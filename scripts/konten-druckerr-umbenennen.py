#!/usr/bin/env python3
"""Konten mit Druckernamen (druckerr9vorname.nachname) auf vorname.nachname umbenennen.

Hintergrund: Bis 26.4.2026 bildete die API den Benutzernamen aus dem Mail-Teil
vor dem @. Personen ohne eigene Mail haben Platzhalter wie
druckerr9+vorname.nachname@rosenweg4303.ch (Post geht an den Drucker); daraus
wurden Authentik-Konten "druckerr9vorname.nachname", die ad-sync (dc1, alle
2 min) als sAMAccountName ins AD uebernahm. Regel: Anmeldename = vorname.nachname.

Laeuft als root auf einem Proxmox-Knoten des Clusters (findet die Container
selbst, fremde Knoten per ssh). Die Liste der Konten wird zur Laufzeit gelesen
(Authentik: username beginnt mit "drucker"), keine Namen im Code.

  konten-druckerr-umbenennen.py              Probelauf: Bestandsaufnahme + Plan
  konten-druckerr-umbenennen.py --ausfuehren nur Konten mit Plan AUTO umbenennen
  ... --nur ALT[,ALT]                        auf diese alten Namen beschraenken

AUTO nur wenn: Name ergibt vorname.nachname, Ziel weder in Authentik noch im AD
noch in der Portal-DB vergeben, Konto hat sich nie angemeldet, Mail ist eine
Platzhalter-Adresse mit +Tag. Alles andere ist MANUELL (nur Vorschlag).

Reihenfolge je Lauf (--ausfuehren):
  1. ad-sync-Cron auf dc1 auskommentieren, laufenden sync.py abwarten
  2. je Konto: AD umbenennen (sAMAccountName, UPN, home/profile/unixHome),
     dann Authentik-username, dann users.username in der Portal-DB,
     dann Home-/Profilordner auf dem CephFS (falls vorhanden)
     Scheitert Authentik, wird das AD zurueckbenannt.
  3. Cron wieder einschalten (auch bei Abbruch, try/finally)
Die Mailadresse (auch mit +Tag) bleibt unveraendert. Tokens werden nie ausgegeben.
"""

import argparse
import base64
import json
import re
import shlex
import socket
import subprocess
import sys
import time
import unicodedata

DC_CT = 108          # dc1: samba-tool, ad-sync, Authentik-Token in /etc/ad-sync.env
FS_CTS = (106, 206)  # Fileserver (gleiches CephFS), erster laufender gewinnt
DB_CT = 128          # core-backend: /opt/rosenweg-core, docker compose postgres
AD_REALM = "ad.rosenweg4303.ch"
SAM = "/var/lib/samba/private/sam.ldb"
HOME_WURZEL = "/mnt/cephfs-userdata/home"
PROFIL_WURZEL = "/mnt/cephfs-userdata/profiles"
CRON = "/etc/cron.d/ad-sync"
PAUSE_MARKE = "#PAUSIERT-KONTEN-UMBENENNEN "

# --- Namensregel, gleich wie api/lib/benutzername.js ------------------------
PARTIKEL = {"von", "van", "vom", "zu", "zum", "de", "di", "da", "del", "della", "dello", "dos",
            "das", "do", "du", "der", "den", "des", "la", "le", "lo", "ten", "ter", "al", "el", "st"}
KEINE_PERSON = re.compile(r"\b(ag|gmbh|sa|sagl|s[aà]rl|kg|holding|verwaltung|immobilien|stweg|"
                          r"genossenschaft|erben|erbengemeinschaft)\b", re.I)
FORM = re.compile(r"^[a-z0-9]+(\.[a-z0-9-]+)+$")
PLATZHALTER = re.compile(r"^drucker(?:r\d+)?\+([^@]+)@", re.I)
SICHER = re.compile(r"^[A-Za-z0-9._-]{1,64}$")  # geht in LDAP-Filter und Pfade


def transliteriere(s):
    s = (s or "").lower()
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss"), ("æ", "ae"), ("ø", "oe"),
                 ("œ", "oe"), ("ł", "l"), ("đ", "d"), ("ı", "i")):
        s = s.replace(a, b)
    return "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))


def teil(s):
    s = re.sub(r"[^a-z0-9-]+", "", transliteriere(s))
    return re.sub(r"-+", "-", s).strip("-")


def zusammensetzen(vor, nach):
    v, n = teil(vor), teil(nach)
    if not v or not n:
        return None
    u = f"{v}.{n}"
    return u if FORM.match(u) else None


def aus_vollname(name):
    s = re.sub(r"\bc/o\b.*$", "", name or "", flags=re.I)
    s = re.sub(r"[,;(].*$", "", s).strip()
    if not s or KEINE_PERSON.search(s):
        return None
    w = s.split()
    if len(w) < 2:
        return None
    i = len(w) - 1
    while i > 1 and transliteriere(w[i - 1]) in PARTIKEL:
        i -= 1
    return zusammensetzen(w[0], "".join(w[i:]))


def aus_platzhalter(email):
    m = PLATZHALTER.match((email or "").strip())
    if not m:
        return None
    t = [x for x in m.group(1).split(".") if x]
    return zusammensetzen(t[0], t[-1]) if len(t) >= 2 else None


def vorschlag(name, email):
    return aus_vollname(name) or aus_platzhalter(email)


# --- Container erreichen ------------------------------------------------------
_knoten = None


def knoten_von(vmid):
    global _knoten
    if _knoten is None:
        r = subprocess.run(["pvesh", "get", "/cluster/resources", "--type", "vm", "--output-format", "json"],
                           capture_output=True, text=True, check=True)
        _knoten = {v["vmid"]: (v["node"], v.get("status")) for v in json.loads(r.stdout)}
    return _knoten.get(vmid, (None, None))


def in_ct(vmid, befehl, eingabe=None, pruefen=True):
    """befehl (Liste) im Container ausfuehren, lokal per pct, sonst per ssh zum Knoten."""
    node, _ = knoten_von(vmid)
    if not node:
        raise SystemExit(f"CT {vmid} nicht im Cluster gefunden")
    pct = ["pct", "exec", str(vmid), "--"] + befehl
    if node != socket.gethostname():
        pct = ["ssh", "-o", "BatchMode=yes", f"root@{node}", " ".join(shlex.quote(x) for x in pct)]
    r = subprocess.run(pct, input=eingabe, capture_output=True, text=True)
    if pruefen and r.returncode != 0:
        raise RuntimeError(f"CT {vmid}: {' '.join(befehl[:3])} … rc={r.returncode}: {r.stderr.strip()[:300]}")
    return r


def fs_ct():
    for vmid in FS_CTS:
        if knoten_von(vmid)[1] == "running":
            return vmid
    raise SystemExit("kein Fileserver-Container laeuft")


# --- Authentik (im dc1-Container, Token bleibt dort) ----------------------------
AK_PROG = r'''
import json, ssl, sys, urllib.request, urllib.parse
tok = [l.split("=", 1)[1].strip() for l in open("/etc/ad-sync.env") if l.startswith("AUTHENTIK_TOKEN=")][0]
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
def call(method, p, body=None):
    r = urllib.request.Request("https://authentik.rosenweg4303.ch/api/v3" + p, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + tok, "Accept": "application/json",
                 "Content-Type": "application/json", "User-Agent": "RosenwegADSync/1.0"})
    return json.loads(urllib.request.urlopen(r, context=ctx, timeout=20).read() or b"{}")
auftrag = json.loads(sys.stdin.read())
if auftrag["was"] == "liste":
    drucker, alle, page = [], [], 1
    while True:
        d = call("GET", f"/core/users/?page_size=200&page={page}")
        for u in d["results"]:
            alle.append({"pk": u["pk"], "username": u["username"], "name": u.get("name"), "email": u.get("email")})
            if u["username"].lower().startswith("drucker"):
                drucker.append({"pk": u["pk"], "username": u["username"], "name": u.get("name"),
                    "email": u.get("email"), "is_active": u.get("is_active"), "last_login": u.get("last_login"),
                    "date_joined": u.get("date_joined"), "groups": [g["name"] for g in u.get("groups_obj") or []]})
        if not d.get("pagination", {}).get("next"): break
        page += 1
    print(json.dumps({"drucker": drucker, "alle": alle}))
elif auftrag["was"] == "umbenennen":
    u = call("PATCH", f"/core/users/{int(auftrag['pk'])}/", {"username": auftrag["neu"]})
    print(json.dumps({"username": u.get("username")}))
'''


def authentik(auftrag):
    r = in_ct(DC_CT, ["python3", "-c", AK_PROG], eingabe=json.dumps(auftrag))
    return json.loads(r.stdout)


# --- AD ---------------------------------------------------------------------------
AD_ATTR = ["sAMAccountName", "userPrincipalName", "cn", "memberOf", "homeDirectory", "profilePath",
           "unixHomeDirectory", "lastLogonTimestamp", "logonCount", "uidNumber", "whenCreated"]


def ad_konto(sam):
    r = in_ct(DC_CT, ["ldbsearch", "-H", SAM, f"(sAMAccountName={sam})", *AD_ATTR], pruefen=False)
    d = {}
    for zeile in r.stdout.splitlines():
        m = re.match(r"^(\w+)(::?) (.*)$", zeile)
        if not m:
            continue
        k, art, v = m.groups()
        if art == "::":
            v = base64.b64decode(v).decode("utf-8", "replace")
        if k == "dn":
            d["dn"] = v
        elif k == "memberOf":
            d.setdefault("gruppen", []).append(re.sub(r"^CN=([^,]+),.*$", r"\1", v))
        else:
            d[k] = v
    return d if "dn" in d else None   # ohne dn: nur Verweise (ref:), kein Konto


def ad_umbenennen(alt, neu):
    in_ct(DC_CT, ["samba-tool", "user", "rename", alt, f"--samaccountname={neu}", f"--upn={neu}@{AD_REALM}"])
    dn = ad_konto(neu)["dn"]
    ldif = (f"dn: {dn}\nchangetype: modify\n"
            f"replace: homeDirectory\nhomeDirectory: \\\\dokumente\\home\\{neu}\n-\n"
            f"replace: profilePath\nprofilePath: \\\\dokumente\\profiles\\{neu}\n-\n"
            f"replace: unixHomeDirectory\nunixHomeDirectory: /home/{neu}\n")
    in_ct(DC_CT, ["ldbmodify", "-H", SAM], eingabe=ldif)


def ad_zurueck(neu, alt):
    ad_umbenennen(neu, alt)


# --- Portal-DB -------------------------------------------------------------------
def psql(sql):
    befehl = ["bash", "-c", 'cd /opt/rosenweg-core && docker compose exec -T postgres '
              'sh -c \'psql -X -q -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"\'']
    return in_ct(DB_CT, befehl, eingabe=sql).stdout


def lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def db_bezuege(alt, email, name):
    sql = (f"SELECT json_build_object("
           f"'users', (SELECT json_agg(json_build_object('id', id, 'username', username, 'email', email, 'active', active)) "
           f"          FROM users WHERE LOWER(username) = LOWER({lit(alt)}) OR LOWER(email) = LOWER({lit(email)})),"
           f"'kontakte', (SELECT count(*) FROM wohnungen_kontakte WHERE LOWER(email) = LOWER({lit(email)}) "
           f"             AND archiviert_am IS NULL AND deleted_at IS NULL),"
           f"'personen', (SELECT json_agg(json_build_object('id', id, 'name', name)) FROM personen "
           f"             WHERE LOWER(email) = LOWER({lit(email)})),"
           f"'gleicher_name', (SELECT json_agg(json_build_object('id', p.id, 'email', p.email, 'kontakte', "
           f"   (SELECT count(*) FROM wohnungen_kontakte k WHERE k.person_id = p.id AND k.archiviert_am IS NULL "
           f"    AND k.deleted_at IS NULL))) FROM personen p WHERE LOWER(TRIM(p.name)) = LOWER(TRIM({lit(name or '')}))));")
    return json.loads(psql(sql).strip() or "{}")


def db_username_belegt(neu):
    return psql(f"SELECT count(*) FROM users WHERE LOWER(username) = LOWER({lit(neu)});").strip() != "0"


def db_umbenennen(alt, neu):
    return psql(f"UPDATE users SET username = {lit(neu)}, updated_at = NOW() "
                f"WHERE LOWER(username) = LOWER({lit(alt)}) RETURNING id;").split()


# --- Ordner ------------------------------------------------------------------------
def ordner(alt):
    r = in_ct(fs_ct(), ["bash", "-c", 'for w in "$1" "$2"; do for d in "$w/$3" "$w/$3".V*; do '
                        '[ -e "$d" ] && echo "$d"; done; done; true',
                        "_", HOME_WURZEL, PROFIL_WURZEL, alt])
    return [z for z in r.stdout.splitlines() if z]


def ordner_umbenennen(alt, neu):
    for pfad in ordner(alt):
        ziel = pfad.replace(f"/{alt}", f"/{neu}", 1)
        in_ct(fs_ct(), ["bash", "-c", '[ -e "$2" ] && { echo "$2 existiert" >&2; exit 1; }; mv -- "$1" "$2"',
                        "_", pfad, ziel])
        print(f"      Ordner {pfad} -> {ziel}")


# --- ad-sync pausieren -----------------------------------------------------------
def adsync_pause():
    in_ct(DC_CT, ["sed", "-i", f"s|^\\([^#].*ad-sync/sync.py.*\\)$|{PAUSE_MARKE}\\1|", CRON])
    for _ in range(60):
        if in_ct(DC_CT, ["pgrep", "-f", "/opt/ad-sync/sync.py"], pruefen=False).returncode != 0:
            return
        time.sleep(5)
    raise RuntimeError("sync.py laeuft seit 5 Minuten noch, abgebrochen")


def adsync_weiter():
    in_ct(DC_CT, ["sed", "-i", f"s|^{PAUSE_MARKE}||", CRON], pruefen=False)
    r = in_ct(DC_CT, ["grep", "-c", PAUSE_MARKE, CRON], pruefen=False)
    if r.stdout.strip() not in ("", "0"):
        print(f"!! ad-sync-Cron noch pausiert, bitte {CRON} auf dc1 pruefen", file=sys.stderr)


# --- Plan --------------------------------------------------------------------------
def planen(nur):
    ak = authentik({"was": "liste"})
    belegt_ak = {u["username"].lower(): u for u in ak["alle"]}
    plaene = []
    for u in sorted(ak["drucker"], key=lambda x: x["username"]):
        alt = u["username"]
        if nur and alt not in nur:
            continue
        if not SICHER.match(alt):
            print(f"!! Benutzername {alt!r} mit ungewoehnlichen Zeichen uebersprungen", file=sys.stderr)
            continue
        email = u.get("email") or ""
        neu = vorschlag(u.get("name"), email)
        ad = ad_konto(alt)
        db = db_bezuege(alt, email, u.get("name"))
        gruende = []
        if not PLATZHALTER.match(email):
            gruende.append("Mail ohne +Tag (Sammel-/Druckeradresse, kein Personenkonto)")
        if not neu:
            gruende.append("kein vorname.nachname aus dem Namen ableitbar")
        else:
            frei = belegt_ak.get(neu)
            if frei and frei["pk"] != u["pk"]:
                gruende.append(f"Ziel {neu} in Authentik vergeben (pk {frei['pk']}, {frei.get('email')}): Doppel?")
            if ad_konto(neu):
                gruende.append(f"Ziel {neu} im AD vergeben")
            if db_username_belegt(neu):
                gruende.append(f"Ziel {neu} in Portal-DB users vergeben")
        if u.get("last_login") or (ad and ad.get("lastLogonTimestamp")) or (ad and ad.get("logonCount", "0") != "0"):
            gruende.append("Konto hat sich schon angemeldet (Person muss neuen Namen kennen)")
        if not ad:
            gruende.append("kein AD-Konto gefunden")
        andere = [x for x in (db.get("gleicher_name") or []) if x.get("kontakte")]
        # Haushalt mit gemeinsamem Platzhalter (z.B. beide Partner auf +tag des einen):
        # Person gleichen Namens mit aktivem Kontakt ohne eigene Mail -> nicht verwaist.
        haushalt = any(PLATZHALTER.match(x.get("email") or "") for x in andere)
        if not db.get("kontakte") and not haushalt:
            gruende.append("Mail in keinem aktiven Kontakt mehr: verwaistes Konto, eher loeschen als umbenennen?"
                           + (f" (Person gleichen Namens heute mit {', '.join(sorted({x['email'] or '-' for x in andere}))})"
                              if andere else ""))
        plaene.append({"alt": alt, "neu": neu, "ak": u, "ad": ad, "db": db, "ordner": ordner(alt),
                       "plan": "MANUELL" if gruende else "AUTO", "gruende": gruende})
    ziele = [p["neu"] for p in plaene if p["plan"] == "AUTO"]
    for p in plaene:
        if p["plan"] == "AUTO" and ziele.count(p["neu"]) > 1:
            p["plan"] = "MANUELL"
            p["gruende"].append(f"Ziel {p['neu']} in diesem Lauf mehrfach")
    return plaene


def zeigen(p):
    u, ad, db = p["ak"], p["ad"] or {}, p["db"]
    print(f"\n== {p['alt']}  ->  {p['neu'] or '?'}   [{p['plan']}]")
    print(f"   Authentik: pk {u['pk']}, Name {u.get('name')}, aktiv {u.get('is_active')}, "
          f"letzte Anmeldung {u.get('last_login') or 'nie'}, seit {str(u.get('date_joined'))[:10]}")
    print(f"              Gruppen: {', '.join(u.get('groups') or []) or '-'}")
    if ad:
        print(f"   AD:        CN {ad.get('cn')}, UPN {ad.get('userPrincipalName')}, uid {ad.get('uidNumber')}, "
              f"logonCount {ad.get('logonCount', '0')}, lastLogonTimestamp {ad.get('lastLogonTimestamp', '-')}")
        print(f"              Gruppen: {', '.join(ad.get('gruppen', [])) or '-'}")
        print(f"              Home {ad.get('homeDirectory')}, Profil {ad.get('profilePath')}")
    print(f"   Ordner:    {', '.join(p['ordner']) or 'keine (homes-anlegen.sh legt den Home nach der Umbenennung an)'}")
    print(f"   Portal-DB: users {json.dumps(db.get('users'), ensure_ascii=False)}, aktive Kontakte mit der Mail: "
          f"{db.get('kontakte')}, Personen: {json.dumps(db.get('personen'), ensure_ascii=False)}, "
          f"Personen gleichen Namens: {json.dumps(db.get('gleicher_name'), ensure_ascii=False)}")
    for g in p["gruende"]:
        print(f"   ! {g}")


def ausfuehren(p):
    alt, neu, pk = p["alt"], p["neu"], p["ak"]["pk"]
    print(f"\n>> {alt} -> {neu}")
    if ad_konto(neu) or db_username_belegt(neu):
        print(f"      {neu} inzwischen vergeben, uebersprungen", file=sys.stderr)
        return
    ad_umbenennen(alt, neu)
    print("      AD umbenannt (sAMAccountName, UPN, Home, Profil, unixHome)")
    try:
        r = authentik({"was": "umbenennen", "pk": pk, "neu": neu})
        if r.get("username") != neu:
            raise RuntimeError(f"Authentik meldet {r.get('username')}")
    except Exception:
        ad_zurueck(neu, alt)
        print("      Authentik gescheitert, AD zurueckbenannt", file=sys.stderr)
        raise
    print("      Authentik umbenannt")
    ids = db_umbenennen(alt, neu)
    print(f"      Portal-DB users: {len(ids)} Zeile(n)")
    ordner_umbenennen(alt, neu)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ausfuehren", action="store_true", help="AUTO-Konten wirklich umbenennen")
    ap.add_argument("--nur", default="", help="nur diese alten Benutzernamen (Komma-Liste)")
    ap.add_argument("--verwaist-umbenennen", action="store_true",
                    help="mit --nur: Konten, die nur wegen 'verwaist' MANUELL sind, trotzdem umbenennen")
    a = ap.parse_args()
    nur = {x.strip() for x in a.nur.split(",") if x.strip()}

    plaene = planen(nur)
    if a.verwaist_umbenennen and nur:
        for p in plaene:
            if p["alt"] in nur and p["gruende"] and all(g.startswith("Mail in keinem aktiven Kontakt") for g in p["gruende"]):
                p["plan"] = "AUTO"
                p["gruende"].append("auf Wunsch trotzdem umbenannt (--verwaist-umbenennen)")
    for p in plaene:
        zeigen(p)
    auto = [p for p in plaene if p["plan"] == "AUTO"]
    print(f"\n{len(plaene)} Konto(en), davon {len(auto)} AUTO, {len(plaene) - len(auto)} MANUELL.")
    if not a.ausfuehren:
        print("Probelauf - nichts geaendert. Mit --ausfuehren werden nur AUTO-Konten umbenannt.")
        return
    if not auto:
        return
    adsync_pause()
    print("ad-sync-Cron auf dc1 pausiert")
    try:
        for p in auto:
            ausfuehren(p)
    finally:
        adsync_weiter()
        print("ad-sync-Cron auf dc1 wieder aktiv")


if __name__ == "__main__":
    main()
