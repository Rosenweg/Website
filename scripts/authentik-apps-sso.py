#!/usr/bin/env python3
"""Authentik fuer die stille Kerberos-Anmeldung der Rosenweg-Apps vorbereiten.

Hintergrund: Die Flutter-Apps (rosenweg_basis, RosenwegKonto.stillAnmelden)
melden sich an Linux-Stationen (Domaenenanmeldung, sssd) und an
Windows-Rechnern der Domaene mit dem Kerberos-Ticket der Sitzung an — ohne
Browser: SPNEGO an die Kerberos-Quelle `ad-kerberos`, Ablauf
`default-source-authentication` ueber die Ablauf-API, dann die gewohnte
PKCE-Autorisierung von `rosenweg-apps`. Fragt Authentik dabei irgendetwas,
faellt die App auf den Browser zurueck.

Was dafuer in Authentik noetig ist:

  1. rosenweg-apps: Autorisierung mit IMPLIZITER Zustimmung
     (default-provider-authorization-implicit-consent). Heute explizit mit
     Ablauf nach 4 Wochen: dann fragt Authentik nach Zustimmung, und die
     stille Anmeldung geht nicht. rosenweg-apps ist die eigene App des Hauses
     (wie Nextcloud, Proxmox, PMG, die schon implizit sind).
  2. optional (--hausnetz NETZ[,NETZ]): Kerberos-Anmeldung nur aus diesen
     Netzen (Ausdrucks-Policy auf dem Ablauf default-source-authentication).
     Gilt dann auch fuer den Knopf "SSO Login" im Browser. Vorher pruefen,
     mit welcher Adresse Authentik die Stationen sieht (Ereignisse "login",
     client_ip) — hinter dem Edge-Traefik kann das eine oeffentliche
     Adresse sein.

Die Kerberos-Quelle selbst bleibt, wie sie ist (SPN HTTP@authentik.rosenweg4303.ch,
Benutzerzuordnung username_link).

Laeuft als root auf einem Proxmox-Knoten des Clusters (findet CT 114 selbst,
fremde Knoten per ssh), z. B. vom Arbeitsplatz:

  ssh root@100.64.2.20 'python3 - ' < scripts/authentik-apps-sso.py                 Probelauf
  ssh root@100.64.2.20 'python3 - --ausfuehren' < scripts/authentik-apps-sso.py     aendern
  ssh root@100.64.2.20 'python3 - --zurueck --ausfuehren' < scripts/authentik-apps-sso.py

Ohne --ausfuehren wird nur gelesen und gezeigt, was sich aendern wuerde.
Geheimnisse (Keytab, Tokens) werden nie ausgegeben.
"""

import argparse
import ipaddress
import json
import shlex
import socket
import subprocess
import sys

AUTHENTIK_CT = 114
WORKER = "authentik-worker-1"
APP = "rosenweg-apps"
QUELLE = "ad-kerberos"
ABLAUF_QUELLE = "default-source-authentication"
IMPLIZIT = "default-provider-authorization-implicit-consent"
EXPLIZIT = "default-provider-authorization-explicit-consent"
POLICY = "rosenweg-kerberos-nur-hausnetz"

# Laeuft in Authentik (ak shell). Bekommt PARAM als JSON, schreibt nur bei
# PARAM["ausfuehren"]. Ausgabe: Zeilen "IST …", "PLAN …", "GETAN …".
INNEN = r'''
import json
from django.db import transaction
from authentik.core.models import Application
from authentik.flows.models import Flow
from authentik.policies.models import PolicyBinding
from authentik.policies.expression.models import ExpressionPolicy
from authentik.sources.kerberos.models import KerberosSource, UserKerberosSourceConnection
from authentik.stages.consent.models import UserConsent

P = json.loads(PARAM)
plan = []

app = Application.objects.get(slug=P["app"])
prov = app.get_provider()
ziel_flow = Flow.objects.get(slug=P["explizit"] if P["zurueck"] else P["implizit"])
print("IST", "Anwendung", app.slug, "Anbieter", prov.name, "Autorisierung", prov.authorization_flow.slug)
print("IST", "Zustimmungen gespeichert", UserConsent.objects.filter(application=app).count())
if prov.authorization_flow_id != ziel_flow.pk:
    plan.append(("Autorisierung", prov.authorization_flow.slug, ziel_flow.slug))

q = KerberosSource.objects.get(slug=P["quelle"])
print("IST", "Quelle", q.slug, "aktiv", q.enabled, "Realm", q.realm, "SPN", q.spnego_server_name,
      "Keytab", "gesetzt" if q.spnego_keytab else "FEHLT", "Zuordnung", q.user_matching_mode,
      "Ablauf", q.authentication_flow and q.authentication_flow.slug,
      "verknuepfte Konten", UserKerberosSourceConnection.objects.filter(source=q).count())
if not q.enabled or not q.spnego_keytab:
    print("WARNUNG", "Kerberos-Quelle nicht nutzbar (aus oder ohne Keytab) — stille Anmeldung geht so nicht")

fq = Flow.objects.get(slug=P["ablauf_quelle"])
pol = ExpressionPolicy.objects.filter(name=P["policy"]).first()
bindung = PolicyBinding.objects.filter(target=fq, policy=pol).first() if pol else None
print("IST", "Ablauf", fq.slug, "Policy-Modus", fq.policy_engine_mode,
      "Bindungen", [str(b.policy) for b in PolicyBinding.objects.filter(target=fq)])
netze = P["hausnetz"]
ausdruck = None
if netze:
    ausdruck = ("# Kerberos-Anmeldung nur aus dem Hausnetz (scripts/authentik-apps-sso.py)\n"
                "NETZE = %r\n"
                "return any(ak_client_ip in ip_network(n) for n in NETZE)\n" % (netze,))
if P["zurueck"] or not netze:
    if bindung and P["zurueck"]:
        plan.append(("Policy entfernen", P["policy"], "-"))
else:
    if not pol or pol.expression != ausdruck:
        plan.append(("Policy setzen", P["policy"], ", ".join(netze)))
    if not bindung:
        plan.append(("Policy binden", fq.slug, P["policy"]))
    if fq.policy_engine_mode != "all":
        plan.append(("Policy-Modus", fq.policy_engine_mode, "all"))

for p in plan:
    print("PLAN", *p)
if not plan:
    print("PLAN", "nichts zu tun")

if P["ausfuehren"] and plan:
    with transaction.atomic():
        if prov.authorization_flow_id != ziel_flow.pk:
            prov.authorization_flow = ziel_flow
            prov.save()
            print("GETAN", "Autorisierung", ziel_flow.slug)
        if P["zurueck"]:
            if bindung:
                bindung.delete()
                print("GETAN", "Bindung entfernt")
            if pol:
                pol.delete()
                print("GETAN", "Policy geloescht")
        elif netze:
            if not pol:
                pol = ExpressionPolicy.objects.create(name=P["policy"], expression=ausdruck)
            elif pol.expression != ausdruck:
                pol.expression = ausdruck
                pol.save()
            print("GETAN", "Policy", P["policy"])
            if not bindung:
                order = max([b.order for b in PolicyBinding.objects.filter(target=fq)] + [0]) + 10
                PolicyBinding.objects.create(target=fq, policy=pol, order=order, enabled=True)
                print("GETAN", "Bindung", fq.slug, order)
            if fq.policy_engine_mode != "all":
                fq.policy_engine_mode = "all"
                fq.save()
                print("GETAN", "Policy-Modus all")
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


def main():
    a = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    a.add_argument("--ausfuehren", action="store_true", help="wirklich aendern (sonst Probelauf)")
    a.add_argument("--zurueck", action="store_true", help="explizite Zustimmung wieder setzen, Hausnetz-Policy entfernen")
    a.add_argument("--hausnetz", default="", help="Kerberos nur aus diesen Netzen, z. B. 100.64.0.0/10,192.168.9.0/24")
    o = a.parse_args()
    netze = [n.strip() for n in o.hausnetz.split(",") if n.strip()]
    for n in netze:
        ipaddress.ip_network(n)  # wirft bei Tippfehlern, bevor etwas geschieht
    if o.zurueck and netze:
        raise SystemExit("--zurueck und --hausnetz schliessen sich aus")

    param = json.dumps({"app": APP, "quelle": QUELLE, "ablauf_quelle": ABLAUF_QUELLE, "implizit": IMPLIZIT,
                        "explizit": EXPLIZIT, "policy": POLICY, "hausnetz": netze,
                        "zurueck": o.zurueck, "ausfuehren": o.ausfuehren})
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
