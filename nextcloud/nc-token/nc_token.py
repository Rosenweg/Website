#!/usr/bin/env python3
"""App-Passwoerter fuer die Rosenweg-Apps auf geteilten Telefonen (CT 104, Nextcloud).

Nur die Anlage (pbx-api, CT 220) darf fragen: Absender-IP aus NC_TOKEN_ERLAUBT und
Geheimnis im Kopf X-NC-Token-Secret. Die Anlage fragt nur fuer die Person, die gerade
an einem geteilten Telefon angemeldet ist, und widerruft beim Abmelden.

POST /ausstellen {email, name}  -> {benutzer, app_passwort}
POST /widerrufen {email, name}  -> {geloescht: n}

name = Bezeichnung des App-Passworts (z.B. "Rosenweg Geraet 2002"), damit es in den
Nextcloud-Einstellungen der Person erkennbar ist und gezielt widerrufen werden kann.
Entscheid Stefan 24.11.2026 (docs/plans/telefon-nummernplan.md).
"""
import hmac
import json
import os
import re
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NC = os.environ.get("NC_PFAD", "/var/www/nextcloud")
SECRET = os.environ.get("NC_TOKEN_SECRET", "")
ERLAUBT = {ip.strip() for ip in os.environ.get("NC_TOKEN_ERLAUBT", "100.64.2.55").split(",") if ip.strip()}
ADRESSE = os.environ.get("NC_TOKEN_ADRESSE", "100.64.2.36")
PORT = int(os.environ.get("NC_TOKEN_PORT", "8097"))

_benutzer_cache = {"zeit": 0, "karte": {}}


def occ(*args):
    r = subprocess.run(["sudo", "-u", "www-data", "php", f"{NC}/occ", *args],
                       capture_output=True, text=True, timeout=60, cwd=NC)
    if r.returncode != 0:
        raise RuntimeError(f"occ {args[0]} fehlgeschlagen")
    return r.stdout


def benutzer_zu(email):
    """E-Mail -> Nextcloud-Benutzer (gleiche E-Mail in Nextcloud). Zwischenspeicher 5 Minuten."""
    email = email.strip().lower()
    if time.time() - _benutzer_cache["zeit"] > 300 or email not in _benutzer_cache["karte"]:
        karte = {}
        for uid, info in json.loads(occ("user:list", "--info", "--output=json")).items():
            e = (info.get("email") or "").strip().lower()
            if e and info.get("enabled", True):
                karte[e] = uid
        _benutzer_cache.update(zeit=time.time(), karte=karte)
    return _benutzer_cache["karte"].get(email)


def tokens(uid, name):
    return [t for t in json.loads(occ("user:auth-tokens:list", uid, "--output=json")) if t.get("name") == name]


def widerrufen(uid, name):
    n = 0
    for t in tokens(uid, name):
        occ("user:auth-tokens:delete", uid, str(t["id"]))
        n += 1
    return n


def ausstellen(uid, name):
    widerrufen(uid, name)   # hoechstens eines pro Geraet und Person
    aus = occ("user:auth-tokens:add", "-n", "--name", name, uid).splitlines()
    for i, z in enumerate(aus):
        if z.strip().lower().startswith("app password") and i + 1 < len(aus):
            return aus[i + 1].strip()
    raise RuntimeError("kein App-Passwort in der Ausgabe")


class Handler(BaseHTTPRequestHandler):
    def _antwort(self, code, daten):
        b = json.dumps(daten).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        if self.client_address[0] not in ERLAUBT:
            return self._antwort(403, {"error": "nicht erlaubt"})
        if not SECRET or not hmac.compare_digest(self.headers.get("X-NC-Token-Secret", ""), SECRET):
            return self._antwort(401, {"error": "Unauthorized"})
        try:
            laenge = min(int(self.headers.get("Content-Length") or 0), 4096)
            d = json.loads(self.rfile.read(laenge) or b"{}")
            email, name = str(d.get("email", "")), str(d.get("name", ""))
            if not re.fullmatch(r"[^@\s]{1,64}@[^@\s]{1,190}", email) or not re.fullmatch(r"[A-Za-z0-9 ._äöüÄÖÜ-]{3,64}", name):
                return self._antwort(400, {"error": "email/name ungueltig"})
            uid = benutzer_zu(email)
            if not uid:
                return self._antwort(404, {"error": "kein Nextcloud-Konto mit dieser E-Mail"})
            if self.path == "/ausstellen":
                return self._antwort(200, {"benutzer": uid, "app_passwort": ausstellen(uid, name)})
            if self.path == "/widerrufen":
                return self._antwort(200, {"geloescht": widerrufen(uid, name)})
            return self._antwort(404, {"error": "unbekannt"})
        except Exception as e:
            print(f"[nc-token] {self.path}: {type(e).__name__}", flush=True)
            return self._antwort(500, {"error": "Fehler"})

    def log_message(self, fmt, *args):   # keine Anfragedaten ins Journal
        print(f"[nc-token] {self.client_address[0]} {self.command} {self.path}", flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer((ADRESSE, PORT), Handler).serve_forever()
