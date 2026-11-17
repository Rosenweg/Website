#!/usr/bin/env python3
"""
Benutzerbilder aus Authentik ins AD-Attribut thumbnailPhoto schreiben.

Läuft per Cron auf dem Domänencontroller (CT 108). Von dort holen es die
Stationen für den Anmelde-, Sperr- und Menübildschirm; auch Nextcloud und
andere AD-Leser sehen dieses Bild.

Drei Fälle, in dieser Reihenfolge:

  1. Hochgeladenes Foto   Authentik liefert es als data:-URL (profil.html legt
                          es in attributes.avatar ab). Wird zugeschnitten.
  2. Gravatar             eine https-Adresse eines Hosts aus AVATAR_HOSTS (Standard:
                          Gravatar). Ohne Token geholt und zugeschnitten; andere
                          Adressen werden nicht abgerufen (-> Initialen).
  3. Sonst                Initialen auf Rosenweg-Blau, hier gerendert.

Vorgeschichte, damit die Fälle nicht wieder zusammenfallen (3. August 2026):

  * Die Vorgängerfassung schrieb bei *jeder* data:-URL das Rosenweg-Wappen.
    Damit landete sowohl das erzeugte Initialenbild als auch ein hochgeladenes
    Foto im Wappen — alle 84 Konten trugen dasselbe Bild, mit identischer
    Prüfsumme.
  * Ihr Kopfkommentar versprach „Default SVG avatars (initials) are rendered
    locally with PIL". ImageDraw und ImageFont wurden importiert und nirgends
    benutzt; den Renderer gab es nicht.
  * Sie zeigte fest verdrahtet auf https://100.64.2.24:9443 — eine Adresse aus
    dem abgebauten Docker Swarm. Seit dessen Abbau stürzte sie alle zehn
    Minuten mit „No route to host" ab. Das Wappen im AD stammte vom
    31. Juli, dem letzten erfolgreichen Lauf.
  * Der Authentik-Token stand im Klartext im Skript, und das Skript lag in
    keinem Repo.

Zugangsdaten kommen aus der Umgebung, nicht aus dieser Datei:

  AUTHENTIK_URL         z. B. http://100.64.2.37:9000
  AUTHENTIK_API_TOKEN

Auf dem DC liegen sie in /etc/default/sync-avatars-to-ad, das der Cron-Eintrag
einliest. Diese Datei gehört NICHT ins Repo.
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
import ssl
from io import BytesIO

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("FEHLER: python3-pil (Pillow) fehlt.", file=sys.stderr)
    sys.exit(1)

AUTHENTIK_URL = os.environ.get("AUTHENTIK_URL", "").rstrip("/")
AUTHENTIK_TOKEN = os.environ.get("AUTHENTIK_API_TOKEN", "")
SAM_DB = os.environ.get("SAM_DB", "/var/lib/samba/private/sam.ldb")
CACHE_DIR = os.environ.get("CACHE_DIR", "/var/lib/samba/avatar-sync-cache")
AVATAR_SIZE = 96

# Das Blau des Sperrbildschirms (os-stationen, roles/desktop/parts/20-look.sh).
# Eine Farbe für alle: im Haus soll es einheitlich aussehen.
ROSENWEG_BLAU = (15, 23, 42)
SCHRIFTFARBE = (255, 255, 255)

SCHRIFT_KANDIDATEN = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
]

if not AUTHENTIK_URL or not AUTHENTIK_TOKEN:
    print("FEHLER: AUTHENTIK_URL und AUTHENTIK_API_TOKEN müssen gesetzt sein.",
          file=sys.stderr)
    print("        Auf dem DC stehen sie in /etc/default/sync-avatars-to-ad.",
          file=sys.stderr)
    sys.exit(1)

# Fremde Bilder nur von diesen Hosts (Authentik erzeugt Gravatar-Adressen).
# Das Avatar-Feld kann jede Person selbst setzen (PUT /api/auth/avatar) - ohne
# Liste holte der DC beliebige, auch interne Adressen.
FREMD_HOSTS = {h.strip().lower() for h in os.environ.get(
    "AVATAR_HOSTS", "gravatar.com,www.gravatar.com,secure.gravatar.com,"
    "en.gravatar.com,0.gravatar.com,1.gravatar.com,2.gravatar.com").split(",") if h.strip()}
MAX_BILD = 5 * 1024 * 1024

os.makedirs(CACHE_DIR, exist_ok=True)
# Nur fuer Authentik selbst (interne Adresse, ggf. eigenes Zertifikat) bleibt
# die Zertifikatspruefung aus - wie bisher. Fremde Adressen pruefen voll.
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
ctx_fremd = ssl.create_default_context()


class _KeineUmleitung(urllib.request.HTTPRedirectHandler):
    # Eine Umleitung koennte auf http oder ins interne Netz zeigen.
    def redirect_request(self, *args, **kwargs):
        return None


_fremd_opener = urllib.request.build_opener(
    _KeineUmleitung, urllib.request.HTTPSHandler(context=ctx_fremd))


def _begrenzt_lesen(r):
    daten = r.read(MAX_BILD + 1)
    return daten if len(daten) <= MAX_BILD else None


def api_get(path):
    # Der Bearer-Token geht ausschliesslich an AUTHENTIK_URL - nie an eine
    # Adresse aus den Antwortdaten.
    if not path.startswith("/") or path.startswith("//"):
        raise ValueError(f"unerwarteter API-Pfad: {path[:80]!r}")
    req = urllib.request.Request(
        AUTHENTIK_URL + path, headers={"Authorization": f"Bearer {AUTHENTIK_TOKEN}"}
    )
    with urllib.request.urlopen(req, context=ctx, timeout=15) as r:
        return json.loads(r.read())


def bild_holen(url):
    try:
        # Relativer Pfad oder volle Adresse von Authentik selbst: mit Token.
        if url.startswith("/") and not url.startswith("//"):
            voll = AUTHENTIK_URL + url
        elif url.startswith(AUTHENTIK_URL + "/"):
            voll = url
        else:
            voll = None
        if voll:
            req = urllib.request.Request(
                voll, headers={"Authorization": f"Bearer {AUTHENTIK_TOKEN}"}
            )
            with urllib.request.urlopen(req, context=ctx, timeout=15) as r:
                return _begrenzt_lesen(r)
        # Alles andere: nur https, nur erlaubte Hosts, ohne Token, mit
        # Zertifikatspruefung, ohne Umleitungen und mit Groessenlimit.
        teile = urllib.parse.urlsplit(url)
        if teile.scheme != "https" or (teile.hostname or "").lower() not in FREMD_HOSTS:
            return None
        if teile.port not in (None, 443) or teile.username or teile.password:
            return None
        with _fremd_opener.open(urllib.request.Request(url), timeout=15) as r:
            return _begrenzt_lesen(r)
    except Exception:
        return None


def data_url_zerlegen(url):
    """(mimetyp, rohdaten) aus einer data:-URL — oder (None, None)."""
    treffer = re.match(r"^data:([^;,]+)(;base64)?,(.*)$", url, re.S)
    if not treffer:
        return None, None
    typ, ist_base64, nutzlast = treffer.groups()
    try:
        if ist_base64:
            return typ, base64.b64decode(nutzlast)
        return typ, urllib.parse.unquote(nutzlast).encode()
    except Exception:
        return None, None


def initialen(name, benutzername):
    teile = (name or "").strip().split()
    if len(teile) >= 2:
        return (teile[0][0] + teile[-1][0]).upper()
    if teile and len(teile[0]) >= 2:
        return teile[0][:2].upper()
    if benutzername and len(benutzername) >= 2:
        return benutzername[:2].upper()
    return "?"


_schrift_cache = {}


def schrift(groesse):
    if groesse in _schrift_cache:
        return _schrift_cache[groesse]
    for pfad in SCHRIFT_KANDIDATEN:
        if os.path.exists(pfad):
            _schrift_cache[groesse] = ImageFont.truetype(pfad, groesse)
            return _schrift_cache[groesse]
    # Ohne TrueType bleibt die eingebaute Bitmap-Schrift. Sie ist winzig und
    # ignoriert die Grösse — besser als gar kein Bild, aber es soll auffallen.
    print("WARNUNG: keine TrueType-Schrift gefunden, Initialen bleiben klein.",
          file=sys.stderr)
    _schrift_cache[groesse] = ImageFont.load_default()
    return _schrift_cache[groesse]


def initialen_jpeg(name, benutzername):
    """Initialen in Weiss auf einem runden Rosenweg-blauen Grund."""
    # Vierfach zeichnen und herunterrechnen: der Kreisrand wird sonst stufig.
    gross = AVATAR_SIZE * 4
    img = Image.new("RGB", (gross, gross), (255, 255, 255))
    zeichnen = ImageDraw.Draw(img)
    zeichnen.ellipse((0, 0, gross - 1, gross - 1), fill=ROSENWEG_BLAU)

    text = initialen(name, benutzername)
    f = schrift(int(gross * 0.42))
    links, oben, rechts, unten = zeichnen.textbbox((0, 0), text, font=f)
    zeichnen.text(
        ((gross - (rechts - links)) / 2 - links,
         (gross - (unten - oben)) / 2 - oben),
        text, font=f, fill=SCHRIFTFARBE,
    )

    img = img.resize((AVATAR_SIZE, AVATAR_SIZE), Image.LANCZOS)
    aus = BytesIO()
    img.save(aus, "JPEG", quality=90, optimize=True)
    return aus.getvalue()


def zu_thumbnail_jpeg(rohdaten):
    img = Image.open(BytesIO(rohdaten))
    if img.mode in ("RGBA", "LA", "P"):
        grund = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode == "P":
            img = img.convert("RGBA")
        grund.paste(img, mask=img.split()[-1] if img.mode in ("RGBA", "LA") else None)
        img = grund
    else:
        img = img.convert("RGB")

    b, h = img.size
    seite = min(b, h)
    links = (b - seite) // 2
    oben = (h - seite) // 2
    img = img.crop((links, oben, links + seite, oben + seite))
    img = img.resize((AVATAR_SIZE, AVATAR_SIZE), Image.LANCZOS)

    aus = BytesIO()
    img.save(aus, "JPEG", quality=85, optimize=True)
    return aus.getvalue()


def ldap_filter_wert(wert):
    """Wert fuer einen LDAP-Filter maskieren (RFC 4515): * ( ) Backslash NUL."""
    return "".join("\\%02x" % ord(z) if z in "*()\\\x00" else z for z in wert)


def benutzer_dn(benutzername):
    r = subprocess.run(
        ["ldbsearch", "-H", SAM_DB, f"(sAMAccountName={ldap_filter_wert(benutzername)})", "dn"],
        capture_output=True, text=True,
    )
    for zeile in r.stdout.splitlines():
        if zeile.lower().startswith("dn: "):
            return zeile[4:].strip()
    return None


def thumbnail_setzen(dn, jpeg):
    b64 = base64.b64encode(jpeg).decode()
    ldif = (
        f"dn: {dn}\n"
        "changetype: modify\n"
        "replace: thumbnailPhoto\n"
        f"thumbnailPhoto:: {b64}\n"
        "-\n\n"
    )
    r = subprocess.run(
        ["ldbmodify", "-H", SAM_DB],
        input=ldif, capture_output=True, text=True,
    )
    return r.returncode == 0, r.stderr


def cache_datei(benutzername):
    # Benutzername kommt aus Authentik; mit "/" oder ".." darin waere er ein
    # Pfad ausserhalb des Caches. Unauffaellige Namen behalten ihre Datei.
    if re.fullmatch(r"[A-Za-z0-9_@-][A-Za-z0-9._@-]*", benutzername):
        name = benutzername
    else:
        name = "h-" + hashlib.sha256(benutzername.encode()).hexdigest()
    return os.path.join(CACHE_DIR, f"{name}.hash")


def gemerkte_pruefsumme(benutzername):
    p = cache_datei(benutzername)
    if os.path.exists(p):
        with open(p) as f:
            return f.read().strip()
    return None


def pruefsumme_merken(benutzername, h):
    with open(cache_datei(benutzername), "w") as f:
        f.write(h)


def bild_fuer(u):
    """(jpeg, herkunft) für eine Person aus Authentik — oder (None, grund)."""
    benutzername = u.get("username", "")
    avatar = u.get("avatar", "") or ""

    if avatar.startswith("data:"):
        typ, rohdaten = data_url_zerlegen(avatar)
        # Ein SVG ist immer Authentiks erzeugtes Initialenbild — wir rendern
        # unser eigenes, in den Hausfarben und als Raster. Ein Raster in der
        # data:-URL ist dagegen ein hochgeladenes Foto und wird übernommen.
        if rohdaten and typ and not typ.startswith("image/svg"):
            try:
                return zu_thumbnail_jpeg(rohdaten), "hochgeladen"
            except Exception as e:
                print(f"{benutzername}: Foto unlesbar ({e}) — nehme Initialen.",
                      file=sys.stderr)
        return initialen_jpeg(u.get("name", ""), benutzername), "initialen"

    if avatar.startswith("http") or avatar.startswith("/"):
        rohdaten = bild_holen(avatar)
        if rohdaten:
            try:
                return zu_thumbnail_jpeg(rohdaten), "gravatar"
            except Exception as e:
                print(f"{benutzername}: Gravatar unlesbar ({e}) — nehme Initialen.",
                      file=sys.stderr)
        return initialen_jpeg(u.get("name", ""), benutzername), "initialen"

    return initialen_jpeg(u.get("name", ""), benutzername), "initialen"


def main():
    trocken = "--trocken" in sys.argv or "--dry-run" in sys.argv

    gesetzt = 0
    unveraendert = 0
    fehler = 0
    herkunft = {}

    pfad = "/api/v3/core/users/?page_size=100"
    personen = []
    while pfad:
        daten = api_get(pfad)
        personen.extend(daten["results"])
        pg = daten.get("pagination", {})
        naechste = pg.get("next", 0)
        pfad = (f"/api/v3/core/users/?page_size=100&page={naechste}"
                if naechste and naechste > pg.get("current", 0) else None)

    for u in personen:
        benutzername = u.get("username", "")
        if not benutzername or benutzername.startswith("ak-outpost-"):
            continue

        dn = benutzer_dn(benutzername)
        if not dn:
            continue        # kein AD-Konto — z. B. reine Authentik-Dienstkonten

        jpeg, quelle = bild_fuer(u)
        if jpeg is None:
            fehler += 1
            continue
        herkunft[quelle] = herkunft.get(quelle, 0) + 1

        h = hashlib.sha256(jpeg).hexdigest()
        if h == gemerkte_pruefsumme(benutzername):
            unveraendert += 1
            continue

        if trocken:
            print(f"  würde setzen: {benutzername} ({quelle})")
            gesetzt += 1
            continue

        ok, err = thumbnail_setzen(dn, jpeg)
        if ok:
            pruefsumme_merken(benutzername, h)
            gesetzt += 1
        else:
            print(f"ldbmodify {benutzername}: {err}", file=sys.stderr)
            fehler += 1

    art = ", ".join(f"{k}: {v}" for k, v in sorted(herkunft.items())) or "keine"
    print(f"Avatar-Sync{' (trocken)' if trocken else ''}: "
          f"{gesetzt} gesetzt, {unveraendert} unverändert, {fehler} Fehler, "
          f"{len(personen)} Konten — {art}")


if __name__ == "__main__":
    main()
