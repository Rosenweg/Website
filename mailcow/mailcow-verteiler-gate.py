#!/usr/bin/env python3
"""
Rosenweg Verteiler-Sender-Gate fuer Mailcow (rspamd).

Zieht von der Rosenweg-API die Gate-Config (gated Verteiler-Aliase + erlaubte
Absender) und baut daraus eine rspamd-Regel: An "gated" Verteiler-Adressen
(external_allowed=false) darf nur senden, wer aus einer erlaubten Mailcow-/
Verwaltungs-Domain kommt ODER eine erlaubte Objektverwaltungs-Adresse ist.
Alle anderen Absender werden mit Reject abgewiesen. "extern"-Listen sind nicht
in der gated-Liste -> keine Einschraenkung.

Mechanik (rspamd):
  - 3 Map-Dateien in data/conf/rspamd/custom/ (rspamd reloaded Maps automatisch).
  - multimap-Regeln (local.d/multimap.conf, Marker-Block) setzen Symbole:
        ROSENWEG_GATED_RCPT   (Empfaenger ist gated Verteiler)
        ROSENWEG_FROM_OK      (Absender-Domain ODER -Adresse erlaubt)
  - composite (local.d/composites.conf, Marker-Block):
        ROSENWEG_GATED_RCPT & !ROSENWEG_FROM_OK  -> Score 9999 -> Reject
  Envelope-From allein ist frei waehlbar. Daher zusaetzlich (I-4-3):
        ROSENWEG_GATE_UNBELEGT (Score 0, nur Markierung in der rspamd-Historie):
          erlaubter Absender, aber weder SMTP-authentifiziert, noch SPF-pass
          fuer den Envelope-Absender, noch DMARC-pass fuer einen erlaubten
          Header-From.
        Mit GATE_ABSENDER_PRUEFEN=1 wird genau dieser Fall auch abgewiesen.
        Standard ist nur Markieren: erst in der Historie pruefen, dass keine
        berechtigte Einlieferung (Weiterleitungen, Relays) betroffen ist.
Beide Marker-Bloecke werden idempotent neu geschrieben (self-healing nach
Mailcow-Update/Migration). Vor jedem rspamd-Reload laeuft `rspamadm configtest`;
schlaegt er fehl, werden die Bloecke zurueckgerollt und NICHT reloaded.

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

MULTIMAP_BLOCK = """%s
ROSENWEG_GATED_RCPT {
  type = "rcpt";
  map = "/etc/rspamd/custom/rosenweg_gated_rcpt.map";
  symbol = "ROSENWEG_GATED_RCPT";
  score = 0.0;
}
ROSENWEG_FROM_OK_DOMAIN {
  type = "from";
  filter = "email:domain";
  map = "/etc/rspamd/custom/rosenweg_allowed_domains.map";
  symbol = "ROSENWEG_FROM_OK_DOMAIN";
  score = 0.0;
}
ROSENWEG_FROM_OK_EMAIL {
  type = "from";
  map = "/etc/rspamd/custom/rosenweg_allowed_emails.map";
  symbol = "ROSENWEG_FROM_OK_EMAIL";
  score = 0.0;
}
# Header-From (das, was DMARC prueft) gegen dieselben Listen
ROSENWEG_HDR_OK_DOMAIN {
  type = "header";
  header = "From";
  filter = "email:domain";
  map = "/etc/rspamd/custom/rosenweg_allowed_domains.map";
  symbol = "ROSENWEG_HDR_OK_DOMAIN";
  score = 0.0;
}
ROSENWEG_HDR_OK_EMAIL {
  type = "header";
  header = "From";
  filter = "email:addr";
  map = "/etc/rspamd/custom/rosenweg_allowed_emails.map";
  symbol = "ROSENWEG_HDR_OK_EMAIL";
  score = 0.0;
}
# SMTP-authentifizierte Einlieferung (Submission): rspamd prueft dort weder
# SPF noch DMARC, also braucht es ein eigenes Merkmal. Map = "irgendein Nutzer".
ROSENWEG_AUTHED {
  type = "selector";
  selector = "user";
  regexp = true;
  map = "/etc/rspamd/custom/rosenweg_authed.map";
  symbol = "ROSENWEG_AUTHED";
  score = 0.0;
}
%s
""" % (BEGIN, END)

# Absender "belegt": Envelope-From erlaubt UND (authentifiziert ODER SPF-pass),
# oder Header-From erlaubt UND DMARC-pass. DMARC allein reicht nicht fuer den
# Envelope-Treffer, weil es sich auf den Header-From bezieht.
BELEGT = ("((ROSENWEG_FROM_OK_DOMAIN | ROSENWEG_FROM_OK_EMAIL) & (ROSENWEG_AUTHED | R_SPF_ALLOW))"
          " | ((ROSENWEG_HDR_OK_DOMAIN | ROSENWEG_HDR_OK_EMAIL) & DMARC_POLICY_ALLOW)")
ERLAUBT = "(ROSENWEG_FROM_OK_DOMAIN | ROSENWEG_FROM_OK_EMAIL)"


def composite_block():
    if ABSENDER_PRUEFEN:
        reject = "ROSENWEG_GATED_RCPT & !(%s)" % BELEGT
    else:
        reject = "ROSENWEG_GATED_RCPT & !ROSENWEG_FROM_OK_DOMAIN & !ROSENWEG_FROM_OK_EMAIL"
    return """%s
ROSENWEG_VERTEILER_GATE_REJECT {
  expression = "%s";
  score = 9999.0;
  policy = "leave";
}
ROSENWEG_GATE_UNBELEGT {
  expression = "ROSENWEG_GATED_RCPT & %s & !(%s)";
  score = 0.0;
  policy = "leave";
}
%s
""" % (BEGIN, reject, ERLAUBT, BELEGT, END)


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
    body = "\n".join(sorted(set(e.strip().lower() for e in entries if e and e.strip()))) + "\n"
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

    gated = cfg.get("gated_aliases", [])
    domains = cfg.get("allowed_domains", [])
    emails = cfg.get("allowed_emails", [])
    if not gated:
        print("WARN: keine gated_aliases — Gate-Maps werden geleert (kein Reject)")

    maps_changed = False
    maps_changed |= write_map("rosenweg_gated_rcpt.map", gated)
    maps_changed |= write_map("rosenweg_allowed_domains.map", domains)
    maps_changed |= write_map("rosenweg_allowed_emails.map", emails)
    # Regex-Map: passt auf jeden nicht-leeren Benutzernamen
    maps_changed |= write_map("rosenweg_authed.map", ["/^.+$/"])

    mm_changed, mm_prev = ensure_block(MULTIMAP, MULTIMAP_BLOCK)
    co_changed, co_prev = ensure_block(COMPOSITES, composite_block())

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
        print(f"Gate aktualisiert: {len(gated)} gated, {len(domains)} Domains, "
              f"{len(emails)} Adressen (Config geaendert -> rspamd reload).")
    elif maps_changed:
        # Maps werden von rspamd automatisch nachgeladen — kein Reload noetig.
        print(f"Gate-Maps aktualisiert: {len(gated)} gated, {len(domains)} Domains, "
              f"{len(emails)} Adressen (Maps auto-reload).")
    else:
        print("Gate unveraendert.")


if __name__ == "__main__":
    main()
