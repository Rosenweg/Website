// Mitteilungen der STWEG-Seiten: Text als Markdown (Rosenweg STWEG, Entscheid
// Stefan 28.11.2026). Rein, ohne DB und ohne Pakete – testbar mit node --test.
//
//   markdownZuHtml(md)   kleines, sicheres Markdown fuer Web und PDF:
//                        Ueberschriften (# ## ###), **fett**, *kursiv*, `Code`,
//                        Listen (- und 1.), > Zitat, ---, Links (http, https,
//                        mailto, tel) und Bilder ![Text](bild:<id>). Rohes HTML
//                        im Text wird als Text ausgegeben, nie als HTML.
//   htmlZuMarkdown(html) einmalige Uebernahme der alten Abschnitte (CKEditor-
//                        HTML) in Markdown. Bilder als Base64 werden
//                        herausgeloest ([{ platzhalter, typ, bytes }]) und vom
//                        Aufrufer als Bild gespeichert; Tabellen werden zu
//                        Listenzeilen (kein Text geht verloren).
//   bildIds(md)          alle Bild-IDs im Text
//
// Bilder: im Text steht `bild:<id>` (32 Hex-Zeichen). Web und PDF zeigen sie ueber
// /api/stweg-bilder/<id>.

const BILD_ID = /^[0-9a-f]{32}$/;
const BILD_PFAD = '/api/stweg-bilder/';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ─── Markdown -> HTML ───────────────────────────────────────────────

function urlSicher(u) {
  const t = String(u || '').trim();
  if (/^bild:[0-9a-f]{32}$/.test(t)) return BILD_PFAD + t.slice(5);
  if (/^(https?:\/\/|mailto:|tel:)/i.test(t)) return t;
  return null;
}

// Inline-Auszeichnung auf bereits maskiertem Text (esc).
function inline(roh) {
  const teile = [];
  const halten = (h) => { teile.push(h); return `\u0000${teile.length - 1}\u0000`; };
  let t = String(roh).replace(/\u0000/g, '');
  t = t.replace(/\\([\\`*_\[\]])/g, (_, c) => halten(esc(c)));
  // Code zuerst (Inhalt bleibt unberuehrt)
  t = t.replace(/`([^`\n]+)`/g, (_, c) => halten(`<code>${esc(c)}</code>`));
  // Bilder und Links: die Adresse steht im Rohtext; erst sichern, dann maskieren
  t = t.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, alt, u) => {
    const s = urlSicher(u);
    return s ? halten(`<img src="${esc(s)}" alt="${esc(alt)}">`) : `![${alt}](${u})`;
  });
  t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, u) => {
    const s = urlSicher(u);
    return s ? halten(`<a href="${esc(s)}">${esc(text)}</a>`) : `[${text}](${u})`;
  });
  t = esc(t);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => teile[Number(i)]);
}

function markdownZuHtml(md) {
  const zeilen = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  const aus = [];
  let i = 0;
  const leer = (z) => /^\s*$/.test(z);
  while (i < zeilen.length) {
    const z = zeilen[i];
    if (leer(z)) { i++; continue; }
    let m;
    if (/^```/.test(z)) {
      const code = [];
      i++;
      while (i < zeilen.length && !/^```/.test(zeilen[i])) code.push(zeilen[i++]);
      i++;
      aus.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    } else if ((m = z.match(/^(#{1,3})\s+(.*)$/))) {
      aus.push(`<h${m[1].length}>${inline(m[2].trim())}</h${m[1].length}>`);
      i++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(z)) {
      aus.push('<hr>');
      i++;
    } else if (/^>\s?/.test(z)) {
      const q = [];
      while (i < zeilen.length && /^>\s?/.test(zeilen[i])) q.push(zeilen[i++].replace(/^>\s?/, ''));
      aus.push(`<blockquote>${markdownZuHtml(q.join('\n'))}</blockquote>`);
    } else if (/^\s*([-*+])\s+/.test(z) || /^\s*\d+[.)]\s+/.test(z)) {
      const geordnet = /^\s*\d+[.)]\s+/.test(z);
      const re = geordnet ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      const punkte = [];
      while (i < zeilen.length && re.test(zeilen[i])) {
        punkte.push(`<li>${inline(zeilen[i].match(re)[1])}</li>`);
        i++;
      }
      aus.push(`<${geordnet ? 'ol' : 'ul'}>${punkte.join('')}</${geordnet ? 'ol' : 'ul'}>`);
    } else {
      const absatz = [];
      while (i < zeilen.length && !leer(zeilen[i]) && !/^(#{1,3}\s|```|>\s?|\s*([-*+]|\d+[.)])\s+)/.test(zeilen[i])
        && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(zeilen[i])) absatz.push(inline(zeilen[i++]));
      if (!absatz.length) { absatz.push(inline(zeilen[i++])); }
      aus.push(`<p>${absatz.join('<br>')}</p>`);
    }
  }
  return aus.join('\n');
}

/** Bild-IDs, die der Text benutzt. */
function bildIds(md) {
  const ids = new Set();
  for (const m of String(md || '').matchAll(/\(bild:([0-9a-f]{32})\)/g)) ids.add(m[1]);
  return [...ids];
}

// ─── HTML -> Markdown (einmalige Uebernahme) ────────────────────────

const ENTITAETEN = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€', hellip: '…', ndash: '–', mdash: '—' };
function entitaeten(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITAETEN, e) ? ENTITAETEN[e] : m;
  });
}

function attr(a, name) {
  const m = String(a).match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? entitaeten(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

// Zeichen, die im Markdown etwas bedeuten, im Fliesstext schuetzen
const mdText = (s) => s.replace(/([\\`*_\[\]])/g, '\\$1');

/**
 * -> { md, bilder: [{ platzhalter, typ, bytes }] }. Platzhalter im Text:
 * `bild:@@n@@` – der Aufrufer ersetzt ihn durch `bild:<id>` nach dem Speichern.
 */
function htmlZuMarkdown(html) {
  const roh = String(html == null ? '' : html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const bilder = [];
  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;
  let aus = '';
  const listen = []; // { geordnet, n }
  let zitat = 0;
  let code = false;
  let linkStack = [];
  let zelleErste = true;
  let m;

  const neueZeile = () => { if (aus && !aus.endsWith('\n')) aus += '\n'; };
  const absatz = () => { neueZeile(); if (aus && !aus.endsWith('\n\n')) aus += '\n'; };
  const prefix = () => (zitat ? '> '.repeat(zitat) : '');

  while ((m = token.exec(roh))) {
    if (m[4] !== undefined) {
      let t = entitaeten(m[4]);
      if (!code) t = mdText(t.replace(/\s+/g, ' '));
      if (!code && /^\s*$/.test(t) && (!aus || aus.endsWith('\n'))) continue;
      if (!code && (!aus || aus.endsWith('\n'))) t = t.replace(/^\s+/, '');
      if (zitat && (!aus || aus.endsWith('\n'))) aus += prefix();
      aus += t;
      continue;
    }
    const zu = m[1] === '/';
    const tag = m[2].toLowerCase();
    const a = m[3];
    switch (tag) {
      case 'p': case 'div': case 'figure': case 'section':
        if (!zu) absatz(); else absatz();
        break;
      case 'br': aus += '\n'; break;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        if (!zu) { absatz(); aus += '#'.repeat(Math.min(3, Number(tag[1]))) + ' '; } else absatz();
        break;
      case 'strong': case 'b': aus += '**'; break;
      case 'em': case 'i': aus += '*'; break;
      case 'a':
        if (!zu) { linkStack.push({ href: attr(a, 'href'), start: aus.length }); aus += '['; }
        else {
          const l = linkStack.pop();
          if (l && l.href && urlSicher(l.href)) aus += `](${l.href.replace(/\)/g, '%29').replace(/\s/g, '%20')})`;
          else if (l) aus = aus.slice(0, l.start) + aus.slice(l.start + 1);
        }
        break;
      case 'ul': case 'ol':
        if (!zu) { if (!listen.length) absatz(); else neueZeile(); listen.push({ geordnet: tag === 'ol', n: 0 }); } else { listen.pop(); if (!listen.length) absatz(); }
        break;
      case 'li':
        if (!zu) {
          neueZeile();
          const l = listen[listen.length - 1] || { geordnet: false, n: 0 };
          l.n += 1;
          aus += prefix() + '  '.repeat(Math.max(0, listen.length - 1)) + (l.geordnet ? `${l.n}. ` : '- ');
        } else neueZeile();
        break;
      case 'blockquote': if (!zu) { absatz(); zitat += 1; } else { zitat = Math.max(0, zitat - 1); absatz(); } break;
      case 'pre': if (!zu) { absatz(); aus += '```\n'; code = true; } else { neueZeile(); aus += '```\n\n'; code = false; } break;
      case 'code': if (!code) aus += '`'; break;
      case 'hr': absatz(); aus += '---\n\n'; break;
      case 'img': {
        const src = attr(a, 'src') || '';
        const alt = (attr(a, 'alt') || '').replace(/[\[\]]/g, '');
        const d = src.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
        if (d) {
          const platzhalter = `@@${bilder.length}@@`;
          bilder.push({ platzhalter, typ: d[1].toLowerCase(), bytes: Buffer.from(d[2].replace(/\s+/g, ''), 'base64') });
          aus += `![${alt}](bild:${platzhalter})`;
        } else if (/^https?:\/\//i.test(src)) aus += `![${alt}](${src.replace(/\s/g, '%20')})`;
        break;
      }
      case 'table': if (!zu) absatz(); else absatz(); break;
      case 'tr': if (!zu) { neueZeile(); aus += '- '; zelleErste = true; } else neueZeile(); break;
      case 'td': case 'th':
        if (!zu) { if (!zelleErste) aus += ' · '; zelleErste = false; }
        break;
      default: break; // span, u, s, thead, tbody …: Inhalt bleibt
    }
  }
  let md = aus.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // leere Hervorhebungen (z. B. <strong></strong>) entfernen
  md = md.replace(/\*\*\*\*/g, '');
  return { md, bilder };
}

module.exports = { markdownZuHtml, htmlZuMarkdown, bildIds, urlSicher, BILD_ID, BILD_PFAD, esc };
