"""Nextcloud-Zugang geteilter Telefone: parallele Anfragen nach der Anmeldung (XCover 2101,
27.11.2026) duerfen nur ein App-Passwort ausstellen - sonst loescht nc-token die vorherigen
gleichen Namens und das Telefon behaelt ein ungueltiges.

Laufen lassen: cd pbx/api && python3 -m unittest test_nextcloud_zugang -v
"""
import base64
import os
import tempfile
import threading
import time
import unittest
from unittest import mock

from cryptography.fernet import Fernet

_tmp = tempfile.mkdtemp()
os.environ["PBX_DB_PATH"] = os.path.join(_tmp, "pbx-nc.sqlite")
_SCHLUESSEL = Fernet.generate_key().decode()
os.environ["PBX_PIN_KEY"] = _SCHLUESSEL
os.environ["NC_TOKEN_URL"] = "http://nc-token.test:8097"
os.environ["NC_TOKEN_SECRET"] = "s" * 32

import app as pbx  # noqa: E402
import db  # noqa: E402

GERAET = {"Authorization": "Basic " + base64.b64encode(b"2101:geheim-2101").decode()}


class _Antwort:
    def __init__(self, status, daten):
        self.status_code, self._d = status, daten

    def json(self):
        return self._d


class NextcloudZugangTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        conn = db.connect()
        try:
            conn.execute("INSERT OR IGNORE INTO sip_extensions (ext, name, secret, context, client) VALUES (?,?,?,?,?)",
                         ("2101", "Rosenweg Smartphone 1", "geheim-2101", "geteilt", "android-sip"))
            conn.commit()
        finally:
            conn.close()

    def setUp(self):
        conn = db.connect()
        try:
            conn.execute("DELETE FROM telefon_nextcloud")
            conn.execute("INSERT OR REPLACE INTO telefon_sitzungen (ext, user_id, email, name) VALUES (?,?,?,?)",
                         ("2101", "1", "person@example.org", "Person"))
            conn.commit()
        finally:
            conn.close()
        # Im CI-Lauf ist app schon von anderen Tests geladen (ohne NC_TOKEN_URL)
        for ziel, wert in ((pbx, {"NC_TOKEN_URL": "http://nc-token.test:8097", "NC_TOKEN_SECRET": "s" * 32}),):
            for k, v in wert.items():
                p = mock.patch.object(ziel, k, v)
                p.start()
                self.addCleanup(p.stop)
        p = mock.patch.dict(os.environ, {"PBX_PIN_KEY": _SCHLUESSEL})
        p.start()
        self.addCleanup(p.stop)
        self.aufrufe = []
        self.n = 0
        self.sperre = threading.Lock()

    def _nc_token(self, url, json=None, headers=None, timeout=None):
        with self.sperre:
            self.aufrufe.append(url.rsplit("/", 1)[1])
            self.n += 1
            n = self.n
        time.sleep(0.2)   # occ braucht Sekunden; parallele Anfragen ueberlappen
        return _Antwort(200, {"benutzer": "person", "app_passwort": f"pw-{n}"})

    def test_parallel_nur_ein_passwort(self):
        ergebnisse = []

        def holen():
            with pbx.app.test_client() as c:
                r = c.get("/api/telefon/nextcloud", headers=GERAET)
                ergebnisse.append((r.status_code, r.get_json().get("app_passwort")))

        with mock.patch.object(pbx.requests, "post", side_effect=self._nc_token):
            t = [threading.Thread(target=holen) for _ in range(4)]
            for x in t:
                x.start()
            for x in t:
                x.join()
        self.assertEqual(self.aufrufe, ["ausstellen"])
        self.assertEqual({e for e in ergebnisse}, {(200, "pw-1")})

    def test_andere_person_widerruft_vor_dem_ausstellen(self):
        with mock.patch.object(pbx.requests, "post", side_effect=self._nc_token):
            c = pbx.app.test_client()
            self.assertEqual(c.get("/api/telefon/nextcloud", headers=GERAET).status_code, 200)
            conn = db.connect()
            conn.execute("UPDATE telefon_sitzungen SET email = 'andere@example.org' WHERE ext = '2101'")
            conn.commit()
            conn.close()
            r = c.get("/api/telefon/nextcloud", headers=GERAET)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.aufrufe, ["ausstellen", "widerrufen", "ausstellen"])


if __name__ == "__main__":
    unittest.main()
