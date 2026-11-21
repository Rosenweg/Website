#!/usr/bin/env python3
"""Beispielmappe Rosenweg – erzeugt docs/beispielmappe/Beispielmappe-Rosenweg.pdf.

Die Musterdokumente werden mit den ECHTEN Vorlagen/Funktionen aus dem Repo
gerendert: Die Funktionen werden als Quelltext aus api/server.js gelesen und
in Headless-Chromium ausgeführt (kein Node, keine Datenbank nötig). Statische
Druckvorlagen (Aushang, Türschilder, Poster) werden direkt aus ihren HTML-
Dateien gedruckt. Externe Abhängigkeiten (Logo-URL, Google Fonts, QR-Dienst
api.qrserver.com) werden durch lokale Dateien bzw. data:-URIs ersetzt.

Aufruf:  python3 scripts/beispielmappe/build.py
Details: scripts/beispielmappe/README.md
"""
import base64
import hashlib
import html
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from pathlib import Path

import qrcode
import qrcode.image.svg
from pypdf import PdfReader, PdfWriter, PageObject, Transformation

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE = HERE / '.cache'
BUILD = CACHE / 'build'
FONTS = CACHE / 'fonts'
OUT = ROOT / 'docs' / 'beispielmappe' / 'Beispielmappe-Rosenweg.pdf'
SERVER_JS = ROOT / 'api' / 'server.js'

A4 = (595.276, 841.890)
ROT = '#c41e1e'

FONT_DOWNLOADS = {
    **{f'inter-{w}.woff2': f'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.16/files/inter-latin-{w}-normal.woff2'
       for w in (300, 400, 500, 600, 700, 800)},
    'NotoColorEmoji.ttf': 'https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@v2.047/fonts/NotoColorEmoji.ttf',
}

M = json.loads((HERE / 'musterdaten.json').read_text(encoding='utf-8'))
SRC = SERVER_JS.read_text(encoding='utf-8')


# ───────────────────────── Infrastruktur ─────────────────────────

def find_chromium():
    for c in (os.environ.get('CHROMIUM'), shutil.which('chromium'), shutil.which('chromium-browser'),
              shutil.which('google-chrome'), '/opt/pw-browsers/chromium'):
        if c and Path(c).exists():
            return c
    sys.exit('Chromium nicht gefunden (Umgebungsvariable CHROMIUM setzen).')


CHROMIUM = find_chromium()


def ensure_fonts():
    FONTS.mkdir(parents=True, exist_ok=True)
    for name, url in FONT_DOWNLOADS.items():
        p = FONTS / name
        if not p.exists():
            print(f'  lade Schrift {name} …')
            with urllib.request.urlopen(url, timeout=60) as r:
                p.write_bytes(r.read())
    conf = CACHE / 'fonts.conf'
    conf.write_text(f'''<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include>
<dir>{FONTS}</dir><cachedir>{CACHE / "fc-cache"}</cachedir></fontconfig>''')
    return conf


def chrome_env():
    env = dict(os.environ)
    env.update(TZ='Europe/Zurich', LANG='de_CH.UTF-8', LC_ALL='C.UTF-8',
               FONTCONFIG_FILE=str(CACHE / 'fonts.conf'))
    return env


def chrome(args, timeout=120):
    base = [CHROMIUM, '--headless', '--no-sandbox', '--disable-gpu', '--lang=de-CH',
            '--hide-scrollbars', '--no-first-run', '--disable-extensions']
    r = subprocess.run(base + args, capture_output=True, text=True, timeout=timeout, env=chrome_env())
    return r


def print_pdf(html_path, pdf_path, budget=4000):
    pdf_path.unlink(missing_ok=True)
    chrome(['--no-pdf-header-footer', f'--virtual-time-budget={budget}',
            f'--print-to-pdf={pdf_path}', html_path.as_uri()])
    if not pdf_path.exists():
        sys.exit(f'PDF nicht erzeugt: {html_path}')
    return pdf_path


def run_js(name, task_js):
    """Führt aus server.js extrahierten Code + Aufgabe in Chromium aus, liefert JSON zurück."""
    js = BUILD / f'{name}.js'
    js.write_text(task_js, encoding='utf-8')
    page = BUILD / f'{name}.runner.html'
    page.write_text(f'<!doctype html><meta charset="utf-8"><pre id="out"></pre><script src="{js.name}"></script>',
                    encoding='utf-8')
    r = chrome(['--dump-dom', '--virtual-time-budget=10000', page.as_uri()])
    m = re.search(r'<pre id="out">(.*?)</pre>', r.stdout, re.S)
    if not m or not m.group(1):
        sys.exit(f'JS-Lauf {name} ohne Ergebnis:\n{r.stderr[-2000:]}')
    data = json.loads(html.unescape(m.group(1)))
    if isinstance(data, dict) and data.get('__error'):
        sys.exit(f'JS-Fehler in {name}:\n{data["__error"]}')
    return data


def js_wrap(body):
    return ('(async () => { const out = document.getElementById("out");\n'
            'try { const result = await (async () => {\n' + body + '\n})();\n'
            'out.textContent = JSON.stringify(result); }\n'
            'catch (e) { out.textContent = JSON.stringify({__error: String(e && e.stack || e)}); } })();\n')


# ───────────────────────── Extraktion aus server.js ─────────────────────────

def extract_function(header):
    """Top-level-Funktion ab 'header' bis zur ersten Zeile, die nur '}' enthält."""
    i = SRC.index('\n' + header) + 1
    j = SRC.index('\n}\n', i) + 3
    return SRC[i:j]


def extract_block(start_marker, end_marker):
    i = SRC.index(start_marker)
    j = SRC.index(end_marker, i) + len(end_marker)
    return SRC[i:j]


# ───────────────────────── Ersetzungen externer Ressourcen ─────────────────────────

def data_uri(path, mime):
    return f'data:{mime};base64,' + base64.b64encode(Path(path).read_bytes()).decode()


def logo_uri():
    """Logo verkleinert (Original 1 MB steckt sonst in jedem Teil-PDF)."""
    from io import BytesIO
    from PIL import Image
    im = Image.open(ROOT / 'logo-rosenweg.png').convert('RGBA')
    im.thumbnail((420, 420), Image.LANCZOS)
    buf = BytesIO()
    im.quantize(colors=256, method=Image.FASTOCTREE).save(buf, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


LOGO = logo_uri()


def qr_data_uri(text):
    img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, border=2,
                      error_correction=qrcode.constants.ERROR_CORRECT_M)
    return 'data:image/svg+xml;base64,' + base64.b64encode(img.to_string()).decode()


def inter_css():
    faces = ''.join(
        f"@font-face{{font-family:'Inter';font-style:normal;font-weight:{w};"
        f"src:url({data_uri(FONTS / f'inter-{w}.woff2', 'font/woff2')}) format('woff2');}}"
        for w in (300, 400, 500, 600, 700, 800))
    return f'<style>{faces}</style>'


def localize(doc):
    """Logo-URL, Google Fonts und api.qrserver.com durch lokale Inhalte ersetzen."""
    doc = re.sub(r'(src=["\'])(?:https?://(?:www\.)?rosenweg4303\.ch)?/?(?:\.\./)*logo-rosenweg\.png',
                 lambda m: m.group(1) + LOGO, doc)
    had_fonts = 'fonts.googleapis.com' in doc
    doc = re.sub(r'<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*', '', doc)
    doc = re.sub(r"@import url\(['\"]?https://fonts\.googleapis\.com[^)]*\);?", '', doc)
    if had_fonts:
        doc = doc.replace('</head>', inter_css() + '</head>', 1)

    def qr(m):
        q = urllib.parse.parse_qs(html.unescape(m.group(1)))
        return qr_data_uri(q['data'][0])
    doc = re.sub(r'https://api\.qrserver\.com/v1/create-qr-code/\?([^"\']+)', qr, doc)
    assert 'qrserver' not in doc and 'googleapis' not in doc
    return doc


# ───────────────────────── Layout eigener Seiten ─────────────────────────

BASE_CSS = f'''
@page {{ size: A4; margin: 22mm 22mm 20mm 22mm; }}
* {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }}
body {{ font-family: 'Inter', 'Liberation Sans', Arial, sans-serif; color: #222; font-size: 10.5pt; line-height: 1.5; margin: 0; }}
.kopf {{ display: flex; align-items: center; gap: 16px; border-bottom: 2px solid {ROT}; padding-bottom: 10px; margin-bottom: 22px; }}
.kopf img {{ width: 54px; height: 54px; }}
.kopf .t1 {{ font-weight: 700; font-size: 13pt; }}
.kopf .t2 {{ color: #666; font-size: 9pt; }}
h1 {{ color: {ROT}; font-size: 22pt; line-height: 1.15; margin: 0 0 6px; }}
h2 {{ color: {ROT}; font-size: 13pt; margin: 22px 0 6px; }}
h3 {{ font-size: 11pt; margin: 14px 0 4px; }}
p {{ margin: 0 0 8px; }}
.kapnr {{ color: #888; font-size: 10pt; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 4px; }}
table.steck {{ width: 100%; border-collapse: collapse; margin: 14px 0; }}
table.steck td {{ border-top: 1px solid #e3e3e3; padding: 8px 10px; vertical-align: top; }}
table.steck td.k {{ width: 34mm; font-weight: 600; color: {ROT}; }}
.hinweis {{ background: #fdf2f2; border-left: 4px solid {ROT}; padding: 10px 14px; margin: 14px 0; font-size: 9.5pt; }}
.grau {{ background: #f6f6f6; border-left: 4px solid #999; padding: 10px 14px; margin: 14px 0; font-size: 9.5pt; }}
ul {{ margin: 4px 0 8px 18px; padding: 0; }} li {{ margin: 2px 0; }}
code, .mono {{ font-family: 'DejaVu Sans Mono', monospace; font-size: 9pt; }}
.seitenumbruch {{ break-before: page; }}
'''


def kopf(t2='Beispielmappe · Dokumente der Rosenweg-Plattform'):
    return (f'<div class="kopf"><img src="{LOGO}"><div><div class="t1">STWEG-Kooperation Rosenweg</div>'
            f'<div class="t2">{t2}</div></div></div>')


def page_html(body, extra_css=''):
    return (f'<!doctype html><html lang="de-CH"><head><meta charset="utf-8">{inter_css()}'
            f'<style>{BASE_CSS}{extra_css}</style></head><body>{body}</body></html>')


def render_own(name, body, extra_css=''):
    p = BUILD / f'{name}.html'
    p.write_text(page_html(body, extra_css), encoding='utf-8')
    return print_pdf(p, BUILD / f'{name}.pdf')


def render_doc(name, doc, budget=4000):
    p = BUILD / f'{name}.html'
    p.write_text(localize(doc), encoding='utf-8')
    return print_pdf(p, BUILD / f'{name}.pdf', budget)


def steckbrief(nr, titel, zeilen, nach=''):
    rows = ''.join(f'<tr><td class="k">{k}</td><td>{v}</td></tr>' for k, v in zeilen)
    return (kopf() + f'<div class="kapnr">Kapitel {nr}</div><h1>{titel}</h1>'
            f'<table class="steck">{rows}</table>{nach}')


# ───────────────────────── Musterdokumente ─────────────────────────

def muster_hash(snapshot):
    canon = json.dumps({k: v for k, v in snapshot.items() if not k.startswith('_')}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canon.encode()).hexdigest()[:12].upper()


def build_vollmachten():
    code = extract_function('function vmEscapeHtml(') + extract_function('function buildVollmachtHtml(')
    task = code + js_wrap(f'const V = {json.dumps(M["vollmachten"], ensure_ascii=False)};\n'
                          'return V.map(v => buildVollmachtHtml(v));')
    docs = run_js('vollmachten', task)
    return [render_doc(f'vollmacht-{v["art"]}', d) for v, d in zip(M['vollmachten'], docs)]


def build_unterschriftenliste():
    u = M['unterschriftenliste']
    snap = dict(u['snapshot'])
    snap['_hash'] = muster_hash(snap)
    code = ''.join(extract_function(h) for h in (
        'function escHtml(', 'function formatAdresseAnschrift(', 'function isAuswaerts(',
        'function rosenwegNrAusBezeichnung(', 'async function buildUnterschriftenlisteHTML('))
    task = (f'const SITE_URL = {json.dumps(M["site_url"])};\n' + code +
            js_wrap(f'return await buildUnterschriftenlisteHTML({u["stweg"]}, '
                    f'{json.dumps(u["opts"], ensure_ascii=False)}, {json.dumps(snap, ensure_ascii=False)});'))
    doc = run_js('unterschriftenliste', task)
    return render_doc('unterschriftenliste', doc), snap['_hash']


def build_deckblatt():
    d = M['deckblatt']
    block = extract_block("const now = new Date().toLocaleString('de-CH'", '</body></html>`;')
    block = block.replace('new Date().toLocaleString(', 'new Date(MUSTER_NOW).toLocaleString(', 1)
    qr = qr_data_uri(d['pickupUrl'])
    task = (f'const MUSTER_NOW = {json.dumps(M["mappe"]["jetzt_iso"])};\n'
            f'const recipientInfo = {json.dumps(d["recipientInfo"], ensure_ascii=False)};\n'
            f'const recipientTag = {json.dumps(d["recipientTag"], ensure_ascii=False)};\n'
            f'const printer = {json.dumps(d["printer"])};\n'
            f'const senderEmailRaw = {json.dumps(d["senderEmailRaw"])};\n'
            f'const parsed = {{ subject: {json.dumps(d["subject"], ensure_ascii=False)} }};\n'
            f'const totalItems = {d["totalItems"]};\n'
            f'const printableAtts = {json.dumps(d["printableAtts"], ensure_ascii=False)};\n'
            f'const pickupUrl = {json.dumps(d["pickupUrl"])};\n'
            f'const pickupQr = {json.dumps(qr)};\n'
            + js_wrap(block + '\nreturn coverHtml;'))
    doc = run_js('deckblatt', task)
    return render_doc('deckblatt', doc)


def build_mails():
    code = (extract_function('function tplGet(') + extract_function('function tplFormat(')
            + extract_function('function renderTemplate(')
            + extract_block('const MAIL_TEMPLATE_DEFAULTS = [', '\n];') + '\n')
    task = code + js_wrap(
        f'const CTX = {json.dumps(M["mails"], ensure_ascii=False)};\n'
        'return { alle: MAIL_TEMPLATE_DEFAULTS.map(t => ({ source_type: t.source_type, kat: t.empfaenger_kategorie, notiz: t.notiz })),\n'
        '  gerendert: Object.keys(CTX).map(k => { const t = MAIL_TEMPLATE_DEFAULTS.find(x => x.source_type === k);\n'
        '    return { source_type: k, kat: t.empfaenger_kategorie, subject: renderTemplate(t.subject_template, CTX[k]),\n'
        '      text: t.body_template ? renderTemplate(t.body_template, CTX[k]) : null,\n'
        '      html: t.body_html_template ? renderTemplate(t.body_html_template, CTX[k]) : null }; }) };')
    return run_js('mails', task)


MAIL_CSS = f'''
table.steck td {{ padding: 5px 10px; }}
.mail {{ border: 1px solid #cfcfcf; border-radius: 8px; margin: 0 0 16px; break-inside: avoid; overflow: hidden; }}
.mail .bar {{ background: #f1f1f1; padding: 6px 12px; font-size: 8pt; color: #666; border-bottom: 1px solid #ddd; }}
.mail table.h {{ width: 100%; border-collapse: collapse; font-size: 9pt; }}
.mail table.h td {{ padding: 3px 12px; }} .mail table.h td.k {{ width: 20mm; color: #777; }}
.mail .subj {{ font-weight: 700; font-size: 10.5pt; }}
.mail pre {{ white-space: pre-wrap; font-family: 'DejaVu Sans Mono', monospace; font-size: 8.4pt; line-height: 1.45;
            margin: 0; padding: 10px 12px 12px; border-top: 1px solid #eee; }}
.mail .htmlbody {{ padding: 10px 12px; border-top: 1px solid #eee; font-size: 9pt; }}
table.liste {{ width: 100%; border-collapse: collapse; font-size: 7.8pt; line-height: 1.3; }}
table.liste th {{ background: {ROT}; color: #fff; text-align: left; padding: 4px 6px; }}
table.liste td {{ border-bottom: 1px solid #e5e5e5; padding: 2px 6px; vertical-align: top; }}
'''

MAIL_TO = {'verwaltung': M['verwaltung']['firma'] + ' &lt;' + M['verwaltung']['email'] + '&gt;'}
MAIL_TO_SONST = {
    'auslage-auszahlung-reminder': M['verwaltung']['firma'] + ' &lt;' + M['verwaltung']['email'] + '&gt;',
    'wasch-billing': 'Erika Beispiel &lt;erika.beispiel@mail.example&gt;',
}


def mail_card(m):
    to = MAIL_TO.get(m['kat']) or MAIL_TO_SONST.get(m['source_type'], '—')
    body = (f'<pre>{html.escape(m["text"])}</pre>' if m['text'] else '') + \
           (f'<div class="htmlbody">{m["html"]}</div>' if m['html'] else '')
    return (f'<div class="mail"><div class="bar">Mail-Ansicht · Vorlage <b>{m["source_type"]}</b>'
            f'{" · Empfänger-Kategorie " + m["kat"] if m["kat"] else ""}</div>'
            f'<table class="h"><tr><td class="k">Von</td><td>STWEG-Kooperation Rosenweg &lt;noreply@rosenweg4303.ch&gt;</td></tr>'
            f'<tr><td class="k">An</td><td>{to}</td></tr>'
            f'<tr><td class="k">Datum</td><td>16.11.2026, 09:42</td></tr>'
            f'<tr><td class="k">Betreff</td><td class="subj">{html.escape(m["subject"])}</td></tr></table>{body}</div>')


# ───────────────────────── Echtheitsprüfung (Screenshot) ─────────────────────────

def screenshot_echtheit(hash_, snap):
    u = M['unterschriftenliste']
    resp = {
        'found': True, 'hash': hash_, 'stweg': u['stweg'], 'datum': u['opts']['datum'],
        'anlass_titel': u['opts']['anlass_titel'], 'generated_at': snap['_generated_at'],
        'generated_at_local': '16.11.2026, 09:42:00', 'download_count': 2,
        'snapshot': {
            'wohnungen': u['snapshot']['wohnungen'],
            'zeichnungsberechtigte': u['opts']['zeichnungsberechtigte'],
            'total_units': len(u['snapshot']['wohnungen']),
            'total_wq': sum(int(w['wertquote'].split('/')[0]) for w in u['snapshot']['wohnungen']),
        },
    }
    body = json.dumps(resp, ensure_ascii=False).encode()

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(ROOT), **kw)

        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path.startswith('/api/unterschriftenliste/verify-json'):
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(body)
            elif self.path.startswith('/api/'):
                self.send_response(401)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{}')
            else:
                super().do_GET()

    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    png = BUILD / 'echtheitspruefung.png'
    png.unlink(missing_ok=True)
    try:
        chrome(['--window-size=1100,1650', '--virtual-time-budget=15000',
                # Anmelde-Server nicht ansprechen: die Seite ist öffentlich
                '--host-resolver-rules=MAP authentik.rosenweg4303.ch 0.0.0.0',
                f'--screenshot={png}',
                f'http://127.0.0.1:{srv.server_address[1]}/echtheitspruefung.html?hash={hash_}'], timeout=90)
    finally:
        srv.shutdown()
    if not png.exists():
        sys.exit('Screenshot Echtheitsprüfung fehlgeschlagen')
    return png


# ───────────────────────── Excel / vCard ─────────────────────────

def vcard(c):
    # identisch zu buildVCard() in api/server.js (CardDAV-Adressbuch-Sync)
    esc = lambda s: re.sub(r'([\\,;])', r'\\\1', str(s or '')).replace('\n', '\\n')
    parts = c['name'].strip().split()
    last, first = parts[-1], ' '.join(parts[:-1])
    note = '; '.join(f'STWEG {w["stweg"]} {w["bezeichnung"]} ({w["rolle"]})' for w in c['wohnungen'])
    uid = 'rosenweg-' + hashlib.sha1(c['name'].lower().encode()).hexdigest()[:16]
    lines = ['BEGIN:VCARD', 'VERSION:3.0', f'UID:{uid}', f'FN:{esc(c["name"])}', f'N:{esc(last)};{esc(first)};;;']
    if c.get('telefon'):
        lines.append(f'TEL;TYPE=CELL:{esc(c["telefon"])}')
    if c.get('email'):
        lines.append(f'EMAIL;TYPE=INTERNET:{esc(c["email"])}')
    if note:
        lines.append(f'NOTE:{esc(note)}')
    lines += ['CATEGORIES:Rosenweg', 'END:VCARD']
    return '\n'.join(lines)


EXCEL_CSS = '''
table.xl { width: 100%; table-layout: auto; border-collapse: collapse; font-family: 'Liberation Sans', Arial, sans-serif; font-size: 7.4pt; margin: 8px 0 14px; }
table.xl th, table.xl td { border: 1px solid #c8c8c8; padding: 2px 4px; white-space: nowrap; }
table.xl thead tr.col th { background: #eef0f2; color: #666; font-weight: 400; text-align: center; }
table.xl thead tr.hd th { background: #fff; font-weight: 700; text-align: left; }
table.xl td.rn, table.xl th.rn { background: #eef0f2; color: #666; text-align: center; }
.tab { display: inline-block; border: 1px solid #c8c8c8; border-top: none; padding: 2px 10px; font-size: 8pt; background: #fff; color: #217346; font-weight: 600; }
pre.vcf { background: #f6f6f6; border: 1px solid #ddd; padding: 10px 12px; font-size: 8.4pt; white-space: pre-wrap; }
'''


def excel_table(rows):
    keys = list(rows[0].keys())
    cols = ''.join(f'<th>{chr(65 + i)}</th>' for i in range(len(keys)))
    head = ''.join(f'<th>{html.escape(k)}</th>' for k in keys)
    body = ''.join(f'<tr><td class="rn">{n + 2}</td>' + ''.join(f'<td>{html.escape(str(r[k]))}</td>' for k in keys) + '</tr>'
                   for n, r in enumerate(rows))
    return (f'<table class="xl"><thead><tr class="col"><th class="rn"></th>{cols}</tr>'
            f'<tr class="hd"><th class="rn">1</th>{head}</tr></thead><tbody>{body}</tbody></table>')


# ───────────────────────── Seiten zusammensetzen ─────────────────────────

def to_a4(page):
    w, h = float(page.mediabox.width), float(page.mediabox.height)
    if abs(w - A4[0]) < 2 and abs(h - A4[1]) < 2:
        return page
    f = min(A4[0] / w, A4[1] / h)
    new = PageObject.create_blank_page(width=A4[0], height=A4[1])
    new.merge_transformed_page(page, Transformation().scale(f).translate((A4[0] - w * f) / 2, (A4[1] - h * f) / 2))
    return new


def overlay_pdf(n, muster_flags):
    pages = []
    for i in range(n):
        wm = '<div class="wm">MUSTER</div>' if muster_flags[i] else ''
        num = '' if i == 0 else f'<div class="nr">Beispielmappe Rosenweg · Seite {i + 1} von {n}</div>'
        pages.append(f'<div class="p">{wm}{num}</div>')
    css = ('@page{size:A4;margin:0} body{margin:0} .p{position:relative;width:210mm;height:297mm;overflow:hidden;break-after:page}'
           '.nr{position:absolute;right:8mm;bottom:4mm;font:7pt "Liberation Sans",Arial,sans-serif;color:#888;'
           'background:rgba(255,255,255,.85);padding:1px 4px}'
           f'.wm{{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) rotate(-35deg);'
           f'font:700 120pt "Liberation Sans",Arial,sans-serif;color:{ROT};opacity:.07;letter-spacing:.1em}}')
    p = BUILD / 'overlay.html'
    p.write_text(f'<!doctype html><meta charset="utf-8"><style>{css}</style>' + ''.join(pages), encoding='utf-8')
    return print_pdf(p, BUILD / 'overlay.pdf', 1000)


def npages(pdf):
    return len(PdfReader(str(pdf)).pages)


# ───────────────────────── Texte ─────────────────────────

def deckblatt_mappe():
    body = f'''
<div style="height:250mm;display:flex;flex-direction:column;">
  <div style="text-align:center;margin-top:28mm;"><img src="{LOGO}" style="width:62mm;"></div>
  <div style="text-align:center;margin-top:16mm;">
    <div style="font-size:12pt;color:#666;letter-spacing:.12em;text-transform:uppercase;">STWEG-Kooperation Rosenweg · 4303 Kaiseraugst</div>
    <h1 style="font-size:30pt;margin:10mm 0 4mm;">Beispielmappe</h1>
    <div style="font-size:16pt;font-weight:600;">Dokumente der Rosenweg-Plattform</div>
    <div style="font-size:12pt;color:#444;margin-top:8mm;">Übersicht für die Liegenschaftsverwaltung<br>{M["mappe"]["empfaenger"]}</div>
    <div style="font-size:11pt;color:#666;margin-top:6mm;">Kaiseraugst, {M["mappe"]["datum"]}</div>
  </div>
  <div style="margin-top:auto;" class="hinweis"><strong>Alle Personen- und Wohnungsdaten sind frei erfunden.</strong>
    Namen, Einheiten, Adressen ausserhalb des Rosenwegs, E-Mail-Adressen, Telefonnummern, IBAN, IP-Adressen und
    Prüf-Codes in dieser Mappe sind Musterwerte. Die Dokumente selbst wurden mit den echten Vorlagen der Plattform erzeugt.</div>
</div>'''
    return body


KAPITEL = [
    ('vollmacht', 'Vollmachten'),
    ('ul', 'Unterschriftenliste mit Echtheits-Hash'),
    ('druck', 'Deckblatt Druckauftrag'),
    ('mail', 'Mail-Vorlagen'),
    ('aushang', 'Aushang'),
    ('tuer', 'Türschilder'),
    ('poster', 'Waschküche-Poster'),
    ('export', 'Excel-Export und vCard'),
]


def einleitung():
    return kopf() + '''
<h1>Einleitung</h1>
<h2>Wer wir sind</h2>
<p>Die <strong>STWEG-Kooperation Rosenweg</strong> verbindet die Stockwerkeigentümergemeinschaften am Rosenweg in
4303 Kaiseraugst. Der <strong>Ausschuss</strong> vertritt die Gemeinschaften gegenüber Verwaltung, Handwerkern und
Behörden; das Team <strong>Technik</strong> betreibt die gemeinsame Rosenweg-Plattform (www.rosenweg4303.ch) mit
Objektverwaltung, Vollmachten, Auslagen, Reklamationen, Druckdienst und Mailversand.</p>
<h2>Was die Plattform erzeugt</h2>
<p>Viele Dokumente, die bisher von Hand entstanden, erzeugt die Plattform heute automatisch aus den gepflegten
Stammdaten: Vollmachten, Unterschriftenlisten mit Echtheits-Hash, Deckblätter für Druckaufträge, Mitteilungen per
Mail, Aushänge, Türschilder und Poster sowie Exporte für Excel und Adressbücher. Diese Mappe zeigt jedes
Dokument einmal mit Musterdaten, jeweils mit einer kurzen Erklärung zu Zweck, Entstehung, Empfängern und Format.</p>
<h2>Wie die Verwaltung die Dokumente erhält und nutzt</h2>
<ul>
<li><strong>Per Mail:</strong> Auszahlungsaufträge, Erinnerungen und Meldungen zu Änderungen in der Objektverwaltung
kommen von <code>noreply@rosenweg4303.ch</code>. Mails an die Verwaltung gehen vor dem Versand durch eine
Freigabe (Technik oder Präsidium); Rückfragen bitte an <code>ausschuss@rosenweg4303.ch</code>.</li>
<li><strong>Als PDF:</strong> Vollmachten und Unterschriftenlisten werden als PDF erzeugt und von Eigentümern
oder vom Ausschuss weitergegeben. Jede Vollmacht trägt einen Dokument-Code, jede Unterschriftenliste einen
Echtheits-Hash, den jede Person öffentlich prüfen kann.</li>
<li><strong>Auf Papier:</strong> Über den Druckdienst kann die Verwaltung Briefe an Bewohnerinnen und Bewohner per
Mail an eine Druckadresse schicken; die Sendung wird vor Ort mit Deckblatt ausgedruckt und zur Abholung
bereitgelegt.</li>
<li><strong>Als Datei:</strong> Wohnungs- und Kontaktlisten lassen sich als Excel bzw. CSV exportieren;
Kontakte werden als vCard in Adressbücher synchronisiert.</li>
</ul>
<div class="grau">Die Musterdokumente sind mit einem schwachen Schriftzug «MUSTER» überlagert. Sie sind keine gültigen
Vollmachten, Listen oder Aufträge.</div>'''


def toc(entries):
    rows = ''.join(
        f'<tr><td style="width:12mm;color:{ROT};font-weight:700;">{nr}</td><td>{t}</td>'
        f'<td style="text-align:right;width:20mm;">{p}</td></tr>'
        + ''.join(f'<tr><td></td><td style="color:#555;padding-left:6mm;">{st}</td><td style="text-align:right;color:#555;">{sp}</td></tr>'
                  for st, sp in subs)
        for nr, t, p, subs in entries)
    return kopf() + f'''<h1>Inhaltsverzeichnis</h1>
<table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:10.5pt;" class="toc">{rows}</table>
<style>.toc td{{padding:5px 4px;border-bottom:1px dotted #ccc;}}</style>'''


# ───────────────────────── Hauptablauf ─────────────────────────

def main():
    BUILD.mkdir(parents=True, exist_ok=True)
    ensure_fonts()
    print('Rendere Musterdokumente …')
    v_pdfs = build_vollmachten()
    ul_pdf, ul_hash = build_unterschriftenliste()
    shot = screenshot_echtheit(ul_hash, M['unterschriftenliste']['snapshot'])
    db_pdf = build_deckblatt()
    mails = build_mails()

    aushang = (ROOT / 'aushang-verwaltungswechsel.html').read_text(encoding='utf-8')
    for alt, neu in (('LangPartners Immobilien AG', M['bisherige_verwaltung']), ('Immosense AG', M['verwaltung']['firma']),
                     ('Fabrikstrasse 10<br>4123 Allschwil', 'Musterstrasse 1<br>4000 Basel'),
                     ('+41&nbsp;61&nbsp;225&nbsp;45&nbsp;50', '+41&nbsp;61&nbsp;000&nbsp;00&nbsp;00'),
                     ('info@immosense.ch', M['verwaltung']['email']), ('www.immosense.ch', M['verwaltung']['website'])):
        assert alt in aushang, alt
        aushang = aushang.replace(alt, neu)
    aushang_pdf = render_doc('aushang', aushang)
    # Vorlagen aus dem API-Image (api/vorlagen/aushaenge/); die API ersetzt {{QR:<thema>}}
    # durch QR-Codes mit geheimem Token. Für die Mappe: Muster-Token, nicht gültig.
    def mit_muster_qr(html_text):
        return re.sub(r'\{\{QR:([a-z]+)\}\}',
                      lambda m: qr_data_uri(f'https://www.rosenweg4303.ch/raum.html?t=beispiel{m.group(1)[:8]:x<8}'),
                      html_text)
    VORL = ROOT / 'api' / 'vorlagen' / 'aushaenge'
    tuer_pdfs = [render_doc(f'tuer-{n}', mit_muster_qr((VORL / f'{n}.html').read_text(encoding='utf-8')))
                 for n in ('heizung-technikraum', 'waschkueche')]
    # Der Inhalt des Posters ist in aktuellem Chromium ca. 405 mm hoch und liefe auf eine
    # zweite Seite über: auf eine lange Seite drucken, to_a4() verkleinert es danach auf A4.
    poster = mit_muster_qr((VORL / 'waschkueche-poster-a4.html').read_text(encoding='utf-8'))
    poster_pdf = render_doc('poster', poster.replace('</head>', '<style>@page{size:210mm 410mm}</style></head>', 1))

    print('Rendere Kapitelseiten …')
    vm = M['verwaltung']
    S = {}  # Kapitel-Steckbriefe
    S['vollmacht'] = render_own('k-vollmacht', steckbrief(1, 'Vollmachten', [
        ('Zweck', 'Eigentümerinnen und Eigentümer bevollmächtigen eine Person oder die Verwaltung, sie zu vertreten '
                  '(z. B. an der Eigentümerversammlung) oder Auskünfte über ihre Einheit zu erhalten.'),
        ('Entstehung', 'Der Vollmachtgeber erfasst die Vollmacht im Portal (Seite «Vollmachten»), wahlweise aus einer '
                       'Vorlage. Das PDF entsteht aus <code>buildVollmachtHtml()</code>; signiert wird elektronisch '
                       '(einfache elektronische Signatur, Zeitpunkt und IP-Adresse werden protokolliert) oder auf Papier.'),
        ('Arten', '<b>Generell</b> – dauerhafte Vertretung bis Widerruf · <b>Spezifisch</b> – ein Einzelgeschäft, '
                  'z. B. eine Versammlung · <b>Auskunft</b> – Datenschutz-/Auskunftsvollmacht.'),
        ('Empfänger', 'Bevollmächtigte Person bzw. Verwaltung, Versammlungsleitung, Ausschuss.'),
        ('Format', 'PDF A4, eine Seite pro Vollmacht; bei Miteigentum ein Unterschriftsfeld je Miteigentümer/in.'),
        ('Besonderheiten', 'Jede Vollmacht trägt einen 8-stelligen <b>Dokument-Code</b> (ohne verwechselbare Zeichen '
                           '0/O/1/I/L). Status (aktiv, abgelaufen, widerrufen) wird im Portal geführt; abgelaufene '
                           'Vollmachten werden automatisch markiert.'),
    ], '<p>Auf den folgenden Seiten: je ein Muster der drei Arten – generell (elektronisch signiert, an die '
       f'Verwaltung), spezifisch (Papier, zwei Miteigentümer) und Auskunft (elektronisch, an Mieterin).</p>'))

    S['ul'] = render_own('k-ul', steckbrief(2, 'Unterschriftenliste mit Echtheits-Hash', [
        ('Zweck', 'Schriftliche Zustimmung der Eigentümer einer STWEG zu einem Beschluss oder Geschäft '
                  '(Zirkularbeschluss), z. B. zu einem Verwaltungsvertrag.'),
        ('Entstehung', 'Der Ausschuss erfasst Anlass, Zweck, Rücksendefrist und Zeichnungsberechtigte. Die Liste wird aus '
                       'der Objektverwaltung erzeugt (<code>buildUnterschriftenlisteHTML()</code>): eine Sammelliste mit allen '
                       'Einheiten und Wertquoten, dazu Einzelbriefe an auswärts wohnende Eigentümer.'),
        ('Empfänger', 'Alle Eigentümerinnen und Eigentümer der STWEG; ausgefüllt zurück an den Ausschuss. '
                      'Kopie an die Verwaltung für die Akten.'),
        ('Format', 'PDF A4, Sammelliste plus je ein Einzelbrief pro auswärtiger Adresse. '
                   'In der Fusszeile jeder Seite: Stand und Hash.'),
        ('Besonderheiten', 'Beim Erzeugen wird ein <b>Snapshot</b> aller Einheiten, Eigentümer und Wertquoten gespeichert. '
                           'Aus seinem Inhalt entsteht ein 12-stelliger <b>Echtheits-Hash</b> (SHA-256). Über '
                           '<code>www.rosenweg4303.ch/echtheitspruefung.html</code> kann jede Person prüfen, ob ein Papier '
                           'echt ist und welche Daten damals galten. Rückläufe werden pro Brief erfasst.'),
    ], f'<div class="hinweis">Muster-Hash dieser Mappe: <code>{ul_hash}</code> – er ist nicht in der Datenbank registriert. '
       'Die Muster-Liste wurde über den Replay-Pfad aus einem erfundenen Snapshot erzeugt; die Einheit 9.1OG.1 hat '
       'eine auswärtige Adresse und erhält deshalb zusätzlich einen Einzelbrief.</div>'))

    S['ul_check'] = render_own('k-ul-check', kopf() + f'''<div class="kapnr">Kapitel 2 · Fortsetzung</div>
<h1>Echtheitsprüfung</h1>
<p>So sieht die öffentliche Prüfseite aus, wenn der Hash <code>{ul_hash}</code> eingegeben wird. Angezeigt werden
Anlass, Datum, Zeitpunkt der Erzeugung und der vollständige Snapshot. Weicht ein Papier davon ab, ist es verändert worden.
Ein unbekannter Hash wird als «Dokument ungültig» gemeldet.</p>
<div style="border:1px solid #ccc;border-radius:6px;overflow:hidden;margin:10px auto 0;width:130mm;height:181mm;">
<img src="{data_uri(shot, 'image/png')}" style="width:130mm;display:block;"></div>
<p style="font-size:8.5pt;color:#777;margin-top:6px;">Bildschirmfoto der echten Seite echtheitspruefung.html; die Prüf-Antwort
des Servers wurde für die Mappe mit den Musterdaten nachgebildet.</p>''')

    S['druck'] = render_own('k-druck', steckbrief(3, 'Deckblatt Druckauftrag', [
        ('Zweck', 'Briefe für Bewohnerinnen und Bewohner werden vor Ort ausgedruckt und zur Abholung bereitgelegt – '
                  'das Deckblatt ordnet den Ausdruck der richtigen Person zu.'),
        ('Entstehung', 'Eine berechtigte Absenderin (z. B. die Verwaltung) schickt eine Mail mit PDF-Anhang an '
                       '<code>druckerr9+vorname.nachname@rosenweg4303.ch</code> (Rosenweg 9, A4) oder '
                       '<code>druckerr13+…</code> (Rosenweg 13, A3). Die Plattform prüft die Absenderadresse, sucht '
                       'den Empfänger in der Objektverwaltung, erzeugt das Deckblatt und druckt Deckblatt und Anhänge.'),
        ('Empfänger', 'Die im +Tag genannte Person; Abholung im Haus.'),
        ('Benachrichtigung', '<b>Die Abholer werden automatisch benachrichtigt:</b> Sobald der Auftrag gedruckt ist, erhalten '
                             'Technik und Präsident eine Mail mit Empfänger, Wohnung, Drucker, Betreff und Absender '
                             '(Vorlage <code>print-notification</code>). Sie holen den Ausdruck am Drucker ab und verteilen ihn.'),
        ('Format', 'PDF A4 (bzw. A3 am Drucker Rosenweg 13), eine Seite, vor den Anhängen.'),
        ('Besonderheiten', 'Der <b>QR-Code</b> führt zur Abholbestätigung. Ist ein Ausdruck nach 24 Stunden nicht als abgeholt '
                           'bestätigt, erinnert die Plattform die Abholer per Sammelmail und danach alle 3 Tage erneut, bis er '
                           'abgeholt ist (Vorlage <code>pickup-reminder</code>). Nur freigegebene Absender dürfen drucken.'),
    ], '<div class="grau">Der QR-Code wird wie im Betrieb lokal erzeugt (im Server mit dem Paket qrcode). '
       'Inhalt, Layout und Texte stammen unverändert aus der Vorlage im Server.</div>'))

    gerendert = mails['gerendert']
    alle = mails['alle']
    liste = ''.join(f'<tr><td><code>{t["source_type"]}</code></td><td>{t["kat"] or "–"}</td>'
                    f'<td>{html.escape(t["notiz"].split(". Variablen")[0])}</td></tr>' for t in alle)
    # Mail-Kapitel separat, da es eine Vorlagen-Tabelle enthält
    mail_intro = steckbrief(4, 'Mail-Vorlagen', [
        ('Zweck', 'Automatische Mitteilungen der Plattform, z. B. Auszahlungsaufträge für genehmigte Auslagen.'),
        ('Entstehung', 'Jede Mail wird aus einer bearbeitbaren Vorlage erzeugt (<code>renderTemplate()</code> mit '
                       'Platzhaltern wie <code>{{auslage.betrag_chf}}</code>). Die Standardvorlagen '
                       '(<code>MAIL_TEMPLATE_DEFAULTS</code>) kann der Ausschuss im Vorlagen-Editor anpassen.'),
        ('Empfänger', 'Je nach Vorlage Verwaltung, Ausschuss, Technik oder Bewohnerinnen und Bewohner.'),
        ('Format', 'Text-Mail, einzelne Vorlagen als HTML-Mail; Absender <code>noreply@rosenweg4303.ch</code>.'),
        ('Besonderheiten', 'Mails an die Verwaltung laufen über eine Warteschlange mit Freigabe durch Technik oder '
                           'Präsidium. Die Eigentümer markieren eine ausbezahlte Auslage selbst als «erhalten».'),
    ]) + '<h2>Alle Standardvorlagen</h2><p>Es folgt eine Auswahl als Mail-Ansicht mit Musterdaten: die Vorlagen für die Verwaltung sowie die Waschküchen-Abrechnung.</p><table class="liste"><tr><th>Vorlage</th><th>Kategorie</th><th>Verwendung</th></tr>' \
        + liste + '</table>'
    S['mail'] = render_own('k-mail', mail_intro, MAIL_CSS)
    mails_pdf = render_own('mails', kopf() + '<div class="kapnr">Kapitel 4 · Mail-Ansicht</div>'
                           + ''.join(mail_card(m) for m in gerendert), MAIL_CSS)

    S['aushang'] = render_own('k-aushang', steckbrief(5, 'Aushang', [
        ('Zweck', 'Information aller Bewohnerinnen und Bewohner an den Anschlagtafeln, hier zum Wechsel der Verwaltung.'),
        ('Entstehung', 'Vom Ausschuss als HTML-Druckvorlage gepflegt (<code>aushang-verwaltungswechsel.html</code>) '
                       'und als PDF gedruckt.'),
        ('Empfänger', 'Alle Hauseingänge; zusätzlich als PDF auf der Website.'),
        ('Format', 'A3 hoch (in dieser Mappe auf A4 verkleinert).'),
        ('Besonderheiten', 'Hinweis auf das Online-Formular für Reparaturen und Schäden, das auch nach einem '
                           'Verwaltungswechsel unverändert bleibt.'),
    ], f'<div class="grau">Die Firmennamen und Kontaktdaten der bisherigen und der neuen Verwaltung wurden für die Mappe '
       f'durch «{M["bisherige_verwaltung"]}» und «{vm["firma"]}» mit Musteradresse ersetzt.</div>'))

    S['tuer'] = render_own('k-tuer', steckbrief(6, 'Türschilder', [
        ('Zweck', 'Beschriftung der Technik- und Gemeinschaftsräume mit Zutrittsregeln und QR-Codes zu Ansprechpartnern, '
                  'Schlüsselregelung und Störungsmeldung.'),
        ('Entstehung', 'Druck aus dem Adminbereich (Seite «Türschilder &amp; Aushänge»). Jeder QR-Code enthält einen '
                       'geheimen Code je Raum: Nur wer ihn vor Ort scannt, sieht Ansprechpartner, Zugang und Notfall-Infos. '
                       'Der Inhalt wird zentral gepflegt – das Schild bleibt dadurch aktuell.'),
        ('Empfänger', 'Türen der Räume: Hauptverteilung, Heizungs- und Technikraum, Liftmaschinenraum, '
                      'Telekommunikation, Tiefgarage, Waschküche.'),
        ('Format', 'A4 hoch, laminiert.'),
        ('Besonderheiten', 'Codes lassen sich je Raum erneuern; alte Ausdrucke werden damit ungültig. '
                           'Gezeigt werden zwei der sechs Schilder (Heizungs-/Technikraum und Waschküche).'),
    ], '<div class="grau">Die QR-Codes in dieser Mappe enthalten Muster-Codes und funktionieren nicht.</div>'))

    S['poster'] = render_own('k-poster', steckbrief(7, 'Waschküche-Poster', [
        ('Zweck', 'Regeln und Ausstattung der Waschküche einer STWEG auf einen Blick.'),
        ('Entstehung', 'Druck aus dem Adminbereich (Seite «Türschilder &amp; Aushänge»), Vorlage je STWEG.'),
        ('Empfänger', 'Waschküche des jeweiligen Hauses.'),
        ('Format', 'A4 hoch. Hinweis: Die Vorlage ist inzwischen länger als eine A4-Seite (ca. 405 mm); '
                   'für die Mappe wurde sie auf eine Seite verkleinert.'),
        ('Besonderheiten', 'Der QR-Code (mit geheimem Code, wie bei den Türschildern) führt zu Regeln und Reservation der Waschküche. Die Nutzung der Waschküche wird '
                           'minutengenau erfasst und monatlich abgerechnet (Mail-Vorlage <code>wasch-billing</code>, '
                           'Muster in Kapitel 4).'),
    ]))

    xl_spalten = ('Bezeichnung', 'Wertquote', 'Rolle', 'Name', 'E-Mail', 'Telefon', 'Adresse')
    xl = [{k: r[k] for k in xl_spalten} for r in M['excel_objektverwaltung']]
    S['export'] = render_own('k-export', steckbrief(8, 'Excel-Export und vCard', [
        ('Zweck', 'Weiterverarbeitung von Stammdaten in eigenen Programmen der Verwaltung bzw. in Adressbüchern.'),
        ('Excel', 'In der Objektverwaltung und in vielen Listen (Personen, Auslagen, Reklamationen, Rückläufe …) '
                  'gibt es den Knopf «Excel» bzw. «CSV». Der Export enthält pro Kontakt eine Zeile; Wohnungsangaben '
                  'stehen in der ersten Zeile der Einheit. Werte, die Excel als Formel ausführen würde, werden geschützt.'),
        ('vCard', 'Kontakte mit Telefon oder Mail werden als vCard 3.0 in ein CardDAV-Adressbuch synchronisiert '
                  '(Notiz mit STWEG, Einheit und Rolle).'),
        ('Format', '.xlsx (SheetJS) bzw. .csv; .vcf (vCard 3.0).'),
    ]) + '<h2>Muster: Wohnungen_STWEG_3_2026-11-16.xlsx (Ausschnitt, ausgewählte Spalten)</h2>' + excel_table(xl)
        + '<div class="tab">STWEG 3</div><h2>Muster: vCard (ein Kontakt)</h2><pre class="vcf">'
        + html.escape(vcard(M['vcards'][0])) + '</pre>', EXCEL_CSS)

    # Reihenfolge der Teile: (Kapitel-Key|None, Unterpunkt-Titel|None, pdf, Muster?)
    body = [
        ('vollmacht', None, S['vollmacht'], False),
        *[(None, f'Muster: Vollmacht {a}', p, True) for a, p in zip(('generell', 'spezifisch', 'Auskunft'), v_pdfs)],
        ('ul', None, S['ul'], False),
        (None, 'Muster: Sammelliste und Einzelbrief', ul_pdf, True),
        (None, 'Echtheitsprüfung', S['ul_check'], False),
        ('druck', None, S['druck'], False),
        (None, 'Muster: Deckblatt', db_pdf, True),
        ('mail', None, S['mail'], False),
        (None, 'Mail-Ansicht der Vorlagen für die Verwaltung', mails_pdf, True),
        ('aushang', None, S['aushang'], False),
        (None, 'Muster: Aushang Verwaltungswechsel', aushang_pdf, True),
        ('tuer', None, S['tuer'], False),
        *[(None, f'Muster: {t}', p, True) for t, p in zip(('Heizungs- und Technikraum', 'Waschküche'), tuer_pdfs)],
        ('poster', None, S['poster'], False),
        (None, 'Muster: Poster Waschküche STWEG 3', poster_pdf, True),
        ('export', None, S['export'], False),
    ]

    cover = render_own('cover', deckblatt_mappe())
    intro = render_own('einleitung', einleitung())

    def toc_entries(start):
        entries, p = [], start
        titles = dict(KAPITEL)
        nr = 0
        for key, sub, pdf, _ in body:
            if key:
                nr += 1
                entries.append([nr, titles[key], p, []])
            else:
                entries[-1][3].append((sub, p))
            p += npages(pdf)
        return entries

    toc_pdf = render_own('toc', toc(toc_entries(100)))
    front = [(cover, False), (intro, False), (toc_pdf, False)]
    start = sum(npages(p) for p, _ in front) + 1
    toc_pdf = render_own('toc', toc(toc_entries(start)))
    assert sum(npages(p) for p, _ in front) + 1 == start

    parts = front + [(pdf, muster) for _, _, pdf, muster in body]
    writer = PdfWriter()
    flags = []
    for pdf, muster in parts:
        for pg in PdfReader(str(pdf)).pages:
            writer.add_page(to_a4(pg))
            flags.append(muster)
    ov = PdfReader(str(overlay_pdf(len(flags), flags)))
    for pg, o in zip(writer.pages, ov.pages):
        pg.merge_page(o)
    # Logo, Schriften usw. stecken in jedem Teil-PDF: Duplikate zusammenführen
    writer.compress_identical_objects(remove_identicals=True, remove_orphans=True)
    writer.add_metadata({'/Title': 'Beispielmappe – Dokumente der Rosenweg-Plattform',
                         '/Author': 'STWEG-Kooperation Rosenweg', '/Subject': 'Musterdokumente mit erfundenen Daten'})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, 'wb') as f:
        writer.write(f)
    print(f'Fertig: {OUT.relative_to(ROOT)} ({len(flags)} Seiten), Muster-Hash {ul_hash}')


if __name__ == '__main__':
    main()
