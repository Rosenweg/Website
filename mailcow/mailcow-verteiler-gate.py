#!/usr/bin/env python3
"""
Rosenweg Verteiler-Sender-Gate fuer Mailcow (rspamd).

Zieht von der Rosenweg-API die Gate-Config und baut daraus rspamd-Regeln: An
"gated" Verteiler-Adressen (external_allowed=false) darf nur senden, wer fuer
GENAU DIESEN Verteiler erlaubt ist (Befund F1, Nov. 2026). Die API liefert je
Verteiler die erlaubten Adressen und Domains (api/lib/verteiler-gate.js):
STWEG-gebunden, Technik/Praesident an alle, Verwaltung nur fuer ihre STWEG.
Frueher galt eine globale Liste fuer alle Verteiler (jede bekannte Adresse
durfte an die Verteiler jeder STWEG). "extern"-Listen sind nicht gated.

Mechanik (rspamd), je gated Verteiler <id>:
  - Map-Dateien in data/conf/rspamd/custom/ (rspamd laedt Maps selbst nach):
        rosenweg_v<id>_rcpt.map     Regex auf die Adresse, auch mit +tag
        rosenweg_v<id>_emails.map   erlaubte Absender-Adressen
        rosenweg_v<id>_domains.map  erlaubte Absender-Domains (nur wenn vorhanden)
  - multimap-Regeln (local.d/multimap.conf, Marker-Block):
        ROSENWEG_V<id>_RCPT, _FROM/_FROMD (Umschlag), _HDR/_HDRD (Kopf-From)
  - composite (local.d/composites.conf, Marker-Block):
        ROSENWEG_VERTEILER_GATE_REJECT: fuer irgendeinen Verteiler <id> gilt
        RCPT & Absender nicht erlaubt -> Score 9999 -> Reject
  Envelope-From allein ist frei waehlbar. Daher zusaetzlich (I-4-3):
        ROSENWEG_GATE_UNBELEGT (Score 0, nur Markierung in der rspamd-Historie):
          erlaubter Absender, aber weder SMTP-authentifiziert, noch SPF-pass
          fuer den Envelope-Absender, noch DMARC-pass fuer einen erlaubten
          Header-From.
        Mit GATE_ABSENDER_PRUEFEN=1 wird genau dieser Fall auch abgewiesen.
        Standard ist nur Markieren: erst in der Historie pruefen, dass keine
        berechtigte Einlieferung (Weiterleitungen, Relays) betroffen ist.
Beide Marker-Bloecke werden idempotent neu geschrieben (self-healing nach
Mailcow-Update/Migration). Vor jedem rspamd-Restart laeuft `rspamadm configtest`;
schlaegt er fehl, werden die Bloecke zurueckgerollt und NICHT neu gestartet.
Aendert sich nur der Inhalt der Maps, ist kein Restart noetig; kommt ein
Verteiler dazu oder faellt weg, aendern sich die Bloecke (Restart).

  --trocken   nichts schreiben, nur die Bloecke und Anzahlen ausgeben

Config: /etc/default/mailcow-verteiler-gate  (API_URL, GATE_SHARED_SECRET,
        GATE_ABSENDER_PRUEFEN=0|1)
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

CONF = {}
for path in ("/etc/default/mailcow-verteiler-gate",):
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                CONF[k.strip()] = v.strip().strip('"').strip("'")

API_URL = CONF.get("API_URL", "https://www.rosenweg4303.ch/api/verteiler/mailcow-gate")
SECRET = CONF.get("GATE_SHARED_SECRET", "")
MAILCOW_DIR = CONF.get("MAILCOW_DIR", "/opt/mailcow-dockerized")
RSPAMD_CONTAINER = CONF.get("RSPAMD_CONTAINER", "mailcowdockerized-rspamd-mailcow-1")
ABSENDER_PRUEFEN = CONF.get("GATE_ABSENDER_PRUEFEN", "0") == "1"

RSPAMD_DIR = os.path.join(MAILCOW_DIR, "data/conf/rspamd")
CUSTOM_DIR = os.path.join(RSPAMD_DIR, "custom")
MULTIMAP = os.path.join(RSPAMD_DIR, "local.d/multimap.conf")
COMPOSITES = os.path.join(RSPAMD_DIR, "local.d/composites.conf")

BEGIN = "# >>> ROSENWEG-VERTEILER-GATE (managed by mailcow-verteiler-gate.py)"
END = "# <<< ROSENWEG-VERTEILER-GATE"

TROCKEN = "--trocken" in sys.argv

# SMTP-authentifizierte Einlieferung (Submission): rspamd prueft dort weder
# SPF noch DMARC, also braucht es ein eigenes Merkmal. Map = "irgendein Nutzer".
AUTHED_RULE = """ROSENWEG_AUTHED {
  type = "selector";
  selector = "user";
  regexp = true;
  map = "/etc/rspamd/custom/rosenweg_authed.map";
  symbol = "ROSENWEG_AUTHED";
  score = 0.0;
}"""

MAP_RE = re.compile(r"^rosenweg_v\d+_(rcpt|emails|domains)\.map$")
ALTE_MAPS = ("rosenweg_gated_rcpt.map", "rosenweg_allowed_domains.map", "rosenweg_allowed_emails.map")


def sym(vid, teil):
    return "ROSENWEG_V%d_%s" % (vid, teil)


def rcpt_regex(address):
    """Verteiler-Adresse als rspamd-Regex, auch mit +tag (Postfix loest stweg3+x@ auf stweg3@ auf)."""
    local, _, domain = address.partition("@")
    return "/^%s(\\+[^@]*)?@%s$/i" % (re.escape(local), re.escape(domain))


def multimap_rule(name, typ, mapfile, extra=""):
    return """%s {
  type = "%s";%s
  map = "/etc/rspamd/custom/%s";
  symbol = "%s";
  score = 0.0;
}""" % (name, typ, extra, mapfile, name)


def plan(eintraege):
    """-> (maps {datei: [zeilen]}, multimap-Block, composites-Block)"""
    maps = {"rosenweg_authed.map": ["/^.+$/"]}
    regeln = [AUTHED_RULE]
    reject, unbelegt = [], []
    for e in eintraege:
        vid = int(e["id"])
        addr = str(e["address"]).strip().lower()
        emails = sorted(set(x.strip().lower() for x in e.get("emails", []) if x and "@" in x))
        domains = sorted(set(x.strip().lower() for x in e.get("domains", []) if x and "." in x))
        maps["rosenweg_v%d_rcpt.map" % vid] = [rcpt_regex(addr)]
        regeln.append(multimap_rule(sym(vid, "RCPT"), "rcpt", "rosenweg_v%d_rcpt.map" % vid, '\n  regexp = true;'))
        env, hdr = [], []
        if emails:
            maps["rosenweg_v%d_emails.map" % vid] = emails
            regeln.append(multimap_rule(sym(vid, "FROM"), "from", "rosenweg_v%d_emails.map" % vid))
            regeln.append(multimap_rule(sym(vid, "HDR"), "header", "rosenweg_v%d_emails.map" % vid,
                                        '\n  header = "From";\n  filter = "email:addr";'))
            env.append(sym(vid, "FROM")); hdr.append(sym(vid, "HDR"))
        if domains:
            maps["rosenweg_v%d_domains.map" % vid] = domains
            regeln.append(multimap_rule(sym(vid, "FROMD"), "from", "rosenweg_v%d_domains.map" % vid,
                                        '\n  filter = "email:domain";'))
            regeln.append(multimap_rule(sym(vid, "HDRD"), "header", "rosenweg_v%d_domains.map" % vid,
                                        '\n  header = "From";\n  filter = "email:domain";'))
            env.append(sym(vid, "FROMD")); hdr.append(sym(vid, "HDRD"))
        rcpt = sym(vid, "RCPT")
        if not env:
            reject.append(rcpt)  # niemand erlaubt
            continue
        erlaubt = "(%s)" % " | ".join(env)
        # Absender "belegt": Envelope-From erlaubt UND (authentifiziert ODER SPF-pass),
        # oder Header-From erlaubt UND DMARC-pass.
        belegt = "((%s & (ROSENWEG_AUTHED | R_SPF_ALLOW)) | ((%s) & DMARC_POLICY_ALLOW))" % (erlaubt, " | ".join(hdr))
        reject.append("(%s & !%s)" % (rcpt, belegt if ABSENDER_PRUEFEN else erlaubt))
        unbelegt.append("(%s & %s & !%s)" % (rcpt, erlaubt, belegt))

    mm = "%s\n%s\n%s\n" % (BEGIN, "\n".join(regeln), END)
    teile = []
    if reject:
        teile.append("""ROSENWEG_VERTEILER_GATE_REJECT {
  expression = "%s";
  score = 9999.0;
  policy = "leave";
}""" % " | ".join(reject))
    if unbelegt:
        teile.append("""ROSENWEG_GATE_UNBELEGT {
  expression = "%s";
  score = 0.0;
  policy = "leave";
}""" % " | ".join(unbelegt))
    co = "%s\n%s\n%s\n" % (BEGIN, "\n".join(teile), END)
    return maps, mm, co


def fetch_config():
    req = urllib.request.Request(API_URL, headers={
        "X-Tracker-Secret": SECRET,
        "User-Agent": "mailcow-verteiler-gate/1.0 (rosenweg)",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def write_map(name, entries):
    os.makedirs(CUSTOM_DIR, exist_ok=True)
    path = os.path.join(CUSTOM_DIR, name)
    body = "\n".join(sorted(set(e.strip() for e in entries if e and e.strip()))) + "\n"
    new = "# auto-generated by mailcow-verteiler-gate.py — do not edit\n" + body
    old = open(path).read() if os.path.exists(path) else None
    if old != new:
        with open(path, "w") as f:
            f.write(new)
        return True
    return False


def ensure_block(path, block):
    """Idempotent: replace existing marker block or append. Returns (changed, prev_text)."""
    prev = open(path).read() if os.path.exists(path) else ""
    pattern = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", re.S)
    stripped = pattern.sub("", prev)
    new = stripped.rstrip() + ("\n\n" if stripped.strip() else "") + block
    if new != prev:
        with open(path, "w") as f:
            f.write(new)
        return True, prev
    return False, prev


def configtest():
    r = subprocess.run(
        ["docker", "exec", RSPAMD_CONTAINER, "rspamadm", "configtest"],
        cwd=MAILCOW_DIR, capture_output=True, text=True)
    return r.returncode == 0, (r.stdout + r.stderr)


def reload_rspamd():
    # Neue multimap-Regeln/Composites werden von `rspamadm control reload` NICHT
    # registriert (nur Map-Inhalte). Beim Aendern der Config-Bloecke daher ein
    # echter Container-Restart. Map-Inhalts-Aenderungen brauchen das nicht
    # (rspamd ueberwacht die Map-Dateien selbst).
    subprocess.run(["docker", "restart", RSPAMD_CONTAINER],
                   cwd=MAILCOW_DIR, capture_output=True, text=True, timeout=120)


def main():
    if not SECRET:
        print("FEHLER: GATE_SHARED_SECRET nicht gesetzt", file=sys.stderr)
        sys.exit(2)
    try:
        cfg = fetch_config()
    except Exception as e:
        print(f"FEHLER beim Abruf {API_URL}: {e}", file=sys.stderr)
        sys.exit(1)

    eintraege = cfg.get("verteiler")
    if cfg.get("version", 1) < 2 or not isinstance(eintraege, list):
        # Alte API ohne Liste je Verteiler: nichts aendern, bisheriges Gate bleibt.
        print("FEHLER: API liefert keine Gate-Liste je Verteiler (version 2) - unveraendert", file=sys.stderr)
        sys.exit(1)
    for e in eintraege:
        if not isinstance(e, dict) or "id" not in e or "@" not in str(e.get("address", "")):
            print("FEHLER: ungueltiger Gate-Eintrag - unveraendert", file=sys.stderr)
            sys.exit(1)
        if not e.get("emails"):
            print("FEHLER: Verteiler %s ohne erlaubte Absender (Teilliste?) - unveraendert" % e.get("id"), file=sys.stderr)
            sys.exit(1)
    if not eintraege:
        print("WARN: keine gated Verteiler - kein Reject")

    maps, mm_block, co_block = plan(eintraege)
    if TROCKEN:
        print(mm_block)
        print(co_block)
        for name in sorted(maps):
            print("%s: %d Zeilen" % (name, len(maps[name])))
        return

    maps_changed = False
    for name, zeilen in maps.items():
        maps_changed |= write_map(name, zeilen)

    mm_changed, mm_prev = ensure_block(MULTIMAP, mm_block)
    co_changed, co_prev = ensure_block(COMPOSITES, co_block)

    if mm_changed or co_changed:
        ok, out = configtest()
        if not ok:
            # Rollback config-Bloecke, Maps koennen bleiben (harmlos ohne Regel)
            with open(MULTIMAP, "w") as f:
                f.write(mm_prev)
            with open(COMPOSITES, "w") as f:
                f.write(co_prev)
            print("FEHLER: rspamadm configtest fehlgeschlagen — Rollback.\n" + out, file=sys.stderr)
            sys.exit(3)
        reload_rspamd()
        print(f"Gate aktualisiert: {len(eintraege)} gated Verteiler (Config geaendert -> rspamd restart).")
    elif maps_changed:
        print(f"Gate-Maps aktualisiert: {len(eintraege)} gated Verteiler (Maps auto-reload).")
    else:
        print("Gate unveraendert.")

    # Erst nach gueltiger Config aufraeumen: Maps verschwundener Verteiler und die
    # alten globalen Maps (die Bloecke verweisen nicht mehr darauf).
    for name in os.listdir(CUSTOM_DIR):
        if (MAP_RE.match(name) and name not in maps) or name in ALTE_MAPS:
            try:
                os.remove(os.path.join(CUSTOM_DIR, name))
            except OSError:
                pass


if __name__ == "__main__":
    main()
