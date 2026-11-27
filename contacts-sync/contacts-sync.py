#!/usr/bin/env python3
"""Rosenweg-Verzeichnis -> Nextcloud (kontakte/rosenweg), SOGo (inbox@, praesident@), Z-Push.

Personen der Siedlung tragen seit 27.11.2026 nur noch ihre interne Nummer 3HHWWP
(Typ "Rosenweg intern"), nicht mehr Handy/Festnetz: dieses Verzeichnis ist mit
allen geteilt (Kontakte-App, geteilte Telefone, ActiveSync), und sonst koennte
jeder jede Nummer suchen (Stefan). Wer 3HHWWP waehlt, erreicht die Person auf
ihren Geraeten, inklusive Weiterleitung. Die echten Nummern bleiben in der
Personenverwaltung des Portals. Die internen Nummern kommen aus
telefon_interne_nummern (Abbild der Anlage, PUT /api/pbx/personen/nummern).
Verwaltungen und ihre Mitarbeitenden behalten ihre (geschaeftlichen) Nummern.
"""
import os, json, uuid, re, ssl, base64, urllib.request, subprocess, shutil

ENV = {}
NS = uuid.UUID("12345678-1234-5678-1234-567812345678")


def env_lesen(pfad="/root/.contacts-sync.env"):
    for line in open(pfad):
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1); ENV[k] = v.strip()


# TLS-Pruefung (D-16): mit TLS_VERIFY=1 in /root/.contacts-sync.env wird das
# Zertifikat geprueft — dann NC_BASE/SOGO_BASE auf Hostnamen-URLs setzen (die
# Standard-URLs sprechen die Server per IP an, dazu passt kein Zertifikat).
# Ohne TLS_VERIFY wie bisher ohne Pruefung (nur internes Netz).
def tls_kontext():
    ctx = ssl.create_default_context()
    if ENV.get("TLS_VERIFY") != "1":
        ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    return ctx


# Datenbank-Container finden. Frueher Swarm-Dienst rosenweg_postgres; heute
# Compose-Projekt rosenweg-core auf CT 128 (Container rosenweg-core-postgres-1).
# Erst per Compose-Label suchen (unabhaengig vom Namensschema), Name nur als
# Rueckfall. PG_CONTAINER in der env-Datei ueberschreibt alles.
def finde_pg_container():
    if ENV.get("PG_CONTAINER"):
        return ENV["PG_CONTAINER"]
    for filt in (["label=com.docker.compose.project=rosenweg-core", "label=com.docker.compose.service=postgres"],
                 ["label=com.docker.compose.service=postgres"],
                 ["label=com.docker.swarm.service.name=rosenweg_postgres"],
                 ["name=rosenweg-core-postgres"],
                 ["name=rosenweg_postgres"]):
        cmd = ["docker", "ps", "-q"]
        for f in filt: cmd += ["--filter", f]
        ids = subprocess.check_output(cmd).decode().split()
        if ids: return ids[0]
    raise SystemExit("contacts-sync: kein Postgres-Container gefunden (PG_CONTAINER in /root/.contacts-sync.env setzen)")


def psql(pgc, sql):
    return subprocess.check_output(["docker", "exec", pgc, "sh", "-c", "psql -U $POSTGRES_USER -d $POSTGRES_DB -t -A -c \"" + sql + "\""]).decode().strip()


def jq(pgc, sql):
    s = psql(pgc, sql); return json.loads(s) if s else []


def esc(s):
    # \r zuerst: ein CR im Namen haette sonst eine eigene vCard-Zeile begonnen (D-16).
    s = (s or "").replace("\r\n", "\n").replace("\r", "\n"); return s.replace("\\", "\\\\").replace("\n", "\\n").replace(",", "\\,").replace(";", "\\;")


def teltype(n):
    d = n.replace(" ", "").replace("-", ""); return "CELL" if re.search(r"(\+41|^0|^)7[5-9]\d{7}", d) else "VOICE"


def slug(s): return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def firmakey(f):
    p = (f or "").split(); return slug(p[0]) if p else "verwaltung"


INTERN_RE = re.compile(r"^3\d{5}$")
INTERN_LABEL = "Rosenweg intern"


def vc(uid, fn, fam, giv, tels, mails, adr=None, org=None, url=None, note=None, title=None, cats=("Rosenweg",), intern=()):
    L = ["BEGIN:VCARD", "VERSION:3.0", "UID:" + uid, "FN:" + esc(fn), "N:" + esc(fam) + ";" + esc(giv) + ";;;"]
    if org: L.append("ORG:" + esc(org))
    if title: L.append("TITLE:" + esc(title))
    # Interne Nummern mit eigener Beschriftung (vCard-Gruppe + X-ABLabel, wie
    # Apple/Android/Nextcloud eigene Telefon-Typen schreiben)
    for i, t in enumerate(intern, 1):
        L.append("item%d.TEL;TYPE=VOICE:%s" % (i, esc(t)))
        L.append("item%d.X-ABLabel:%s" % (i, INTERN_LABEL))
    for t in tels: L.append("TEL;TYPE=" + teltype(t) + ":" + esc(t))
    for m in mails: L.append("EMAIL;TYPE=INTERNET:" + esc(m))
    if url: L.append("URL:" + esc(url))
    if adr: L.append("ADR;TYPE=WORK:;;" + esc(adr) + ";;;;")
    if note: L.append("NOTE:" + esc(note))
    L.append("CATEGORIES:" + ",".join(cats)); L.append("END:VCARD")
    return "\r\n".join(L) + "\r\n"


def arr(v):
    out = []
    if isinstance(v, list):
        for x in v:
            if isinstance(x, str) and x.strip(): out.append(x.strip())
            elif isinstance(x, dict):
                val = x.get("number") or x.get("value") or x.get("nummer") or x.get("address")
                if val: out.append(str(val).strip())
    return out


# Gleiche Regel wie die Anlage (pbx/api/app.py _gleiche_person) und das Portal
# (api/lib/nummernsicht.js): Paare teilen sich oft eine E-Mail, darum zaehlt die
# E-Mail nur zusammen mit dem Namen.
FIRMA = {"ag", "gmbh", "sa", "gemeinde", "einwohnergemeinde", "stiftung", "genossenschaft"}


def _name_teile(n):
    return {t for t in re.split(r"[\s\-]+", (n or "").lower()) if len(t) > 1}


def gleiche_person(a, b):
    if (a or "").strip().lower() and (a or "").strip().lower() == (b or "").strip().lower():
        return True
    ta, tb = _name_teile(a), _name_teile(b)
    if len(ta) < 2 or len(tb) < 2:
        return False
    if bool(ta & FIRMA) != bool(tb & FIRMA):
        return False
    kurz, lang = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    return kurz <= lang


def interne_nummern_fuer(interne, name, mails):
    mails = {(m or "").strip().lower() for m in mails if m}
    out = []
    for r in interne:
        nr = str(r.get("nummer") or "")
        if INTERN_RE.match(nr) and (r.get("email") or "").strip().lower() in mails \
                and gleiche_person(r.get("name"), name) and nr not in out:
            out.append(nr)
    return out


def verzeichnis(personen, verw, vkont, interne, echte=False):
    """-> {uid: vcard}. Personen nur mit interner Nummer, nie mit Handy/Festnetz.
    echte=True: zusaetzlich die echten Nummern — NUR fuer das persoenliche
    Adressbuch von praesident@ (Entscheid Stefan 27.11.2026), nie fuer geteilte."""
    desired = {}
    for p in personen:
        name = (p.get("name") or "").strip()
        if not name: continue
        parts = name.split(); fam, giv = (parts[-1], " ".join(parts[:-1])) if len(parts) > 1 else (name, "")
        mails = []
        for m in [p.get("email")] + arr(p.get("emails")):
            m = (m or "").strip()
            if m and m not in mails: mails.append(m)
        intern = interne_nummern_fuer(interne, name, mails)
        tels = []
        if echte:
            for t in [p.get("tel"), p.get("mobile")] + arr(p.get("telefone")):
                t = (t or "").strip()
                if t and t not in tels and t not in intern: tels.append(t)
        if not intern and not mails and not tels: continue
        u = str(uuid.uuid5(NS, name))
        # Kategorie "Bewohner": die Anlage liefert fuer solche Karten nur 3HHWWP
        # an die geteilten Telefone, auch falls hier je wieder etwas anderes stuende.
        desired[u] = vc(u, name, fam, giv, tels, mails, adr=(p.get("adresse") or "").replace("\n", ", "),
                        intern=intern, cats=("Rosenweg", "Bewohner"))
    desired["rosenweg-pbx"] = vc("rosenweg-pbx", "Rosenweg", "Rosenweg", "", ["+41 61 551 01 52"], [], note="Telefonzentrale / Technik-Hotline")
    for v in verw:
        fk = firmakey(v.get("firma")); u = fk + "-verwaltung"
        desired[u] = vc(u, v.get("firma"), v.get("firma"), "", ([v.get("tel")] if v.get("tel") else []), ([v.get("email")] if v.get("email") else []), adr=((v.get("adresse") or "").replace("\n", ", ") or None), org=v.get("firma"), url=(("https://" + v.get("website")) if v.get("website") else None), note="Verwaltung Rosenweg", cats=("Rosenweg", "Verwaltung"))
    for k in vkont:
        fk = firmakey(k.get("firma")); nm = (k.get("name") or "").strip()
        if not nm: continue
        parts = nm.split(); fam, giv = (parts[-1], " ".join(parts[:-1])) if len(parts) > 1 else (nm, "")
        u = fk + "-" + slug(nm)
        desired[u] = vc(u, nm, fam, giv, ([k.get("tel")] if k.get("tel") else []), ([k.get("email")] if k.get("email") else []), org=k.get("firma"), title=k.get("funktion"), cats=("Rosenweg", "Verwaltung"))
    return desired


def propfind_uids(ctx, base, auth, host):
    r = urllib.request.Request(base, data=b'<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getetag/></prop></propfind>', method="PROPFIND")
    r.add_header("Authorization", auth); r.add_header("Depth", "1")
    if host: r.add_header("Host", host)
    try: data = urllib.request.urlopen(r, timeout=30, context=ctx).read().decode("utf-8", "ignore")
    except Exception as e: print("  PROPFIND err", e); return set()
    return set(re.findall(r"/([^/]+)\.vcf", data))


def cardreq(method, url, auth, host, body=None):
    r = urllib.request.Request(url, data=(body.encode() if body else None), method=method)
    r.add_header("Authorization", auth)
    if host: r.add_header("Host", host)
    if body: r.add_header("Content-Type", "text/vcard; charset=utf-8")
    return r


def carddav_sync(ctx, desired, label, base, user, pw, delete_stale, host=None):
    auth = "Basic " + base64.b64encode((user + ":" + pw).encode()).decode()
    existing = propfind_uids(ctx, base, auth, host) if delete_stale else set()
    ok = 0
    for uid, bd in desired.items():
        try: urllib.request.urlopen(cardreq("PUT", base + uid + ".vcf", auth, host, bd), timeout=20, context=ctx); ok += 1
        except urllib.error.HTTPError as e:
            if e.code in (200, 201, 204): ok += 1
            else: print("  PUT", uid, e.code)
        except Exception as e: print("  PUT", uid, e)
    dl = 0
    if delete_stale:
        for uid in existing - set(desired):
            try: urllib.request.urlopen(cardreq("DELETE", base + uid + ".vcf", auth, host), timeout=20, context=ctx); dl += 1
            except Exception: pass
    print("  " + label + ": put=" + str(ok) + " del=" + str(dl))


def main():
    env_lesen()
    ctx = tls_kontext()
    nc_base = ENV.get("NC_BASE", "http://100.64.2.36/remote.php/dav/addressbooks/users/kontakte/rosenweg/")
    nc_host = ENV.get("NC_HOST", "nextcloud.rosenweg9.ch")
    sogo_base = ENV.get("SOGO_BASE", "https://100.64.2.33/SOGo/dav/")
    sogo_host = ENV.get("SOGO_HOST", "mailcow.rosenweg9.ch")
    pgc = finde_pg_container()
    personen = jq(pgc, "SELECT COALESCE(json_agg(json_build_object('name',name,'tel',telefon,'mobile',mobile,'telefone',telefone,'email',email,'emails',emails,'adresse',adresse)),'[]'::json) FROM personen WHERE COALESCE(name,'')<>''")
    verw = jq(pgc, "SELECT COALESCE(json_agg(json_build_object('firma',firma_name,'tel',telefon,'email',email,'adresse',adresse,'website',website)),'[]'::json) FROM verwaltungen WHERE aktiv")
    vkont = jq(pgc, "SELECT COALESCE(json_agg(json_build_object('firma',v.firma_name,'name',k.name,'funktion',k.funktion,'email',k.email,'tel',k.telefon)),'[]'::json) FROM verwaltungs_kontakte k JOIN verwaltungen v ON v.id=k.verwaltung_id WHERE v.aktiv")
    try:
        interne = jq(pgc, "SELECT COALESCE(json_agg(json_build_object('nummer',nummer,'email',email,'name',name)),'[]'::json) FROM telefon_interne_nummern WHERE aktiv")
    except subprocess.CalledProcessError:
        interne = []   # Tabelle fehlt noch (API nicht neu): Personen dann ohne Nummer, nie mit echten
    if not interne:
        print("  Hinweis: keine internen Nummern (telefon_interne_nummern leer) — Personen ohne Telefonnummer")
    desired = verzeichnis(personen, verw, vkont, interne)
    voll = verzeichnis(personen, verw, vkont, interne, echte=True)   # nur praesident@
    print("desired:", len(desired), "interne Nummern:", len(interne))
    carddav_sync(ctx, desired, "Nextcloud", nc_base, "kontakte", ENV["NC_KONTAKTE_PW"], True, nc_host)
    # SOGo: persoenliche Buecher nur hinzufuegen/aktualisieren (private Kontakte bleiben).
    # inbox@: nur interne Nummern (gleiche UIDs -> alte Karten mit echten Nummern werden
    # ersetzt). praesident@: volle Fassung mit echten Nummern (Entscheid Stefan).
    carddav_sync(ctx, desired, "SOGo inbox@", sogo_base + "inbox@rosenweg4303.ch/Contacts/personal/", "inbox@rosenweg4303.ch", ENV["INBOX_PW"], False, sogo_host)
    carddav_sync(ctx, voll, "SOGo praesident@", sogo_base + "praesident@rosenweg4303.ch/Contacts/personal/", "praesident@rosenweg4303.ch", ENV["PRAESIDENT_PW"], False, sogo_host)
    tmp = "/tmp/zpush-vcards"
    if os.path.isdir(tmp): shutil.rmtree(tmp)
    os.makedirs(tmp)
    for uid, bd in desired.items(): open(tmp + "/" + uid + ".vcf", "w").write(bd)
    subprocess.run("rsync -a --delete -e 'ssh -o StrictHostKeyChecking=accept-new' " + tmp + "/ root@100.64.2.38:/var/lib/zpush-contacts/", shell=True, check=False)
    subprocess.run("ssh -o StrictHostKeyChecking=accept-new root@100.64.2.38 chown -R www-data:www-data /var/lib/zpush-contacts", shell=True, check=False)
    print("Z-Push CT115: rsynced " + str(len(desired)) + " vcards")
    print("DONE")


if __name__ == "__main__":
    main()
