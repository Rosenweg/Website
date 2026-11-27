#!/usr/bin/env python3
"""Authentik: Ruecksprung-Adressen (redirect_uris) der Rosenweg-Apps aus dem App-Register anlegen.

Hintergrund (Flutter-Plan 4.2.7): Jede Rosenweg-App meldet sich als
oeffentlicher Client `rosenweg-apps` (PKCE) an. Authentik schickt die Antwort
zurueck an
  - Android: `<paketname>:/anmeldung`, je App ein Eintrag, Modus strict
    (rosenweg_basis SchemaAnmeldeweg, commons-rosenweg RosenwegAnmeldung),
  - Desktop und iOS: `^http://localhost:[0-9]+/anmeldung$`, ein Eintrag fuer
    alle, Modus regex (rosenweg_basis LocalhostAnmeldeweg).
Bisher wurde jede neue App von Hand in Authentik eingetragen. Dieses Skript
liest das Register (apps-register.json, ueber GET /api/apps/register der
Haupt-API) und legt fehlende Eintraege an. Es entfernt nie etwas.

Laeuft als root auf einem Proxmox-Knoten des Clusters (findet CT 114 selbst,
fremde Knoten per ssh), z. B. vom Arbeitsplatz:

  ssh root@100.64.2.20 'python3 - ' < scripts/authentik-apps-ruecksprung.py               Probelauf
  ssh root@100.64.2.20 'python3 - --ausfuehren' < scripts/authentik-apps-ruecksprung.py   anlegen
  ssh root@100.64.2.20 'python3 - --nur ch.rosenweg4303.profil' < scripts/authentik-apps-ruecksprung.py

Ohne --ausfuehren wird nur gelesen und gezeigt, was sich aendern wuerde.
Geheimnisse werden nie ausgegeben.
"""

import argparse
import json
import re
import shlex
import socket
import subprocess
import sys
import urllib.request

AUTHENTIK_CT = 114
WORKER = "authentik-worker-1"
APP = "rosenweg-apps"
# Haupt-API intern (wie MAIN_API_BASE der PBX); liefert apps-register.json
REGISTER_URL = "http://100.64.2.52:3000/api/apps/register"
LOCALHOST = r"^http://localhost:[0-9]+/anmeldung$"
PAKET = re.compile(r"[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,6}")

# Laeuft in Authentik (ak shell). Bekommt PARAM als JSON, schreibt nur bei
# PARAM["ausfuehren"]. Ausgabe: Zeilen "IST …", "PLAN …", "GETAN …".
# Authentik ab 2024.12 fuehrt redirect_uris als Liste (RedirectURI mit Modus),
# aeltere als Text mit einer Adresse je Zeile — beides wird verstanden.
INNEN = r'''
import json
from django.db import transaction
from authentik.core.models import Application

P = json.loads(PARAM)
try:
    from authentik.providers.oauth2.models import RedirectURI, RedirectURIMatchingMode
    LISTE = True
except ImportError:
    LISTE = False

app = Application.objects.get(slug=P["app"])
prov = app.get_provider()
if LISTE:
    ist = [(str(getattr(u.matching_mode, "value", u.matching_mode)), u.url) for u in prov.redirect_uris]
else:
    ist = [("text", z.strip()) for z in str(prov.redirect_uris or "").splitlines() if z.strip()]
print("IST", "Anwendung", app.slug, "Anbieter", prov.name, "Eintraege", len(ist), "Form", "Liste" if LISTE else "Text")
for modus, url in ist:
    print("IST", modus, url)
vorhanden = {url for _, url in ist}
fehlt = [(m, u) for m, u in P["soll"] if u not in vorhanden]
for m, u in fehlt:
    print("PLAN", "anlegen", m, u)
if not fehlt:
    print("PLAN", "nichts zu tun")

if P["ausfuehren"] and fehlt:
    with transaction.atomic():
        if LISTE:
            neu = list(prov.redirect_uris)
            for m, u in fehlt:
                neu.append(RedirectURI(RedirectURIMatchingMode.REGEX if m == "regex" else RedirectURIMatchingMode.STRICT, u))
            prov.redirect_uris = neu
        else:
            prov.redirect_uris = "\n".join([u for _, u in ist] + [u for _, u in fehlt])
        prov.save()
    for m, u in fehlt:
        print("GETAN", "angelegt", m, u)
'''


_knoten = None


def knoten_von(vmid):
    global _knoten
    if _knoten is None:
        r = subprocess.run(["pvesh", "get", "/cluster/resources", "--type", "vm", "--output-format", "json"],
                           capture_output=True, text=True, check=True)
        _knoten = {v["vmid"]: v["node"] for v in json.loads(r.stdout)}
    return _knoten.get(vmid)


def in_ct(vmid, befehl, eingabe=None):
    node = knoten_von(vmid)
    if not node:
        raise SystemExit(f"CT {vmid} nicht im Cluster gefunden")
    pct = ["pct", "exec", str(vmid), "--"] + befehl
    if node != socket.gethostname():
        pct = ["ssh", "-o", "BatchMode=yes", f"root@{node}", " ".join(shlex.quote(x) for x in pct)]
    return subprocess.run(pct, input=eingabe, capture_output=True, text=True)


def pakete_aus_register(d):
    """Alle Paketnamen aus apps (Feld paket) und katalog (Schluessel)."""
    pakete = [e["paket"] for e in d.get("apps", {}).values()] + list(d.get("katalog", {}).keys())
    falsch = [p for p in pakete if not PAKET.fullmatch(p)]
    if falsch:
        raise SystemExit(f"Ungueltige Paketnamen im Register: {falsch}")
    return sorted(set(pakete))


def main():
    a = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    a.add_argument("--ausfuehren", action="store_true", help="wirklich anlegen (sonst Probelauf)")
    a.add_argument("--register", default=REGISTER_URL, help="Adresse von GET /api/apps/register")
    a.add_argument("--nur", default="", help="nur diese Paketnamen (Komma), z. B. ch.rosenweg4303.profil")
    a.add_argument("--ohne-localhost", action="store_true", help="den Desktop-Eintrag (localhost, regex) nicht pruefen")
    o = a.parse_args()

    with urllib.request.urlopen(o.register, timeout=10) as r:
        register = json.load(r)
    pakete = pakete_aus_register(register)
    if o.nur:
        nur = [p.strip() for p in o.nur.split(",") if p.strip()]
        unbekannt = [p for p in nur if p not in pakete]
        if unbekannt:
            raise SystemExit(f"Nicht im Register: {unbekannt}")
        pakete = nur
    soll = [("strict", f"{p}:/anmeldung") for p in pakete]
    if not o.ohne_localhost:
        soll.append(("regex", LOCALHOST))

    param = json.dumps({"app": APP, "soll": soll, "ausfuehren": o.ausfuehren})
    code = f"PARAM = {param!r}\n" + INNEN
    r = in_ct(AUTHENTIK_CT, ["docker", "exec", "-i", WORKER, "ak", "shell"], eingabe=code)
    for z in r.stdout.splitlines():
        if z.split(" ", 1)[0] in ("IST", "PLAN", "GETAN", "WARNUNG"):
            print(z)
    if r.returncode != 0:
        fehler = [z for z in r.stderr.splitlines() if not z.startswith("{")]
        print("FEHLER", "\n".join(fehler[-15:]), file=sys.stderr)
        return 1
    print("Probelauf — nichts geaendert. Mit --ausfuehren anwenden." if not o.ausfuehren else "Fertig.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
