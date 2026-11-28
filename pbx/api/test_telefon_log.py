"""Protokoll und installierter Stand der Geraete-App, ETag des Katalogs.

Laufen lassen: cd pbx/api && python3 -m unittest test_telefon_log -v
"""
import base64
import os
import tempfile
import time
import unittest
from unittest import mock

_tmp = tempfile.mkdtemp()
os.environ["PBX_DB_PATH"] = os.path.join(_tmp, "pbx-log.sqlite")

import app as pbx  # noqa: E402
import db  # noqa: E402

TECHNIK = {"email": "technik@example.org", "name": "Technik Person", "groups": ["Technik"]}
BEWOHNER = {"email": "b@example.org", "name": "Bewohner", "groups": ["Bewohner"]}
G2101 = {"Authorization": "Basic " + base64.b64encode(b"2101:geheim-2101").decode()}
G2002 = {"Authorization": "Basic " + base64.b64encode(b"2002:geheim-2002").decode()}


class _Antwort:
    def __init__(self, status, daten):
        self.status_code, self.ok, self._d = status, 200 <= status < 300, daten

    def json(self):
        return self._d


def _me(user):
    def get(url, headers=None, timeout=None):
        return _Antwort(200, {"user": user}) if user else _Antwort(401, {})
    return get


class TelefonLogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        conn = db.connect()
        try:
            for ext in ("2101", "2002"):
                conn.execute("INSERT OR IGNORE INTO sip_extensions (ext, name, secret, context, client) VALUES (?,?,?,?,?)",
                             (ext, "Telefon " + ext, "geheim-" + ext, "geteilt", "android-sip"))
            conn.commit()
        finally:
            conn.close()

    def setUp(self):
        self.c = pbx.app.test_client()
        conn = db.connect()
        conn.execute("DELETE FROM telefon_geraetelog")
        conn.commit()
        conn.close()

    def senden(self, ext, zeilen, kopf):
        return self.c.post(f"/api/telefon/{ext}/log", json={"zeilen": zeilen}, headers=kopf)

    def lesen(self, ext, user=TECHNIK, query=""):
        with mock.patch.object(pbx.requests, "get", side_effect=_me(user)):
            return self.c.get(f"/api/telefon/{ext}/log{query}", headers={"Authorization": "Bearer t"})

    def test_senden_und_lesen(self):
        jetzt = int(time.time()) * 1000
        r = self.senden("2101", [
            {"t": jetzt - 5000, "stufe": "W", "tag": "RosenwegSperre", "text": "HOME zeigte nicht auf den Rosenweg Launcher - neu gesetzt"},
            {"t": jetzt, "stufe": "I", "tag": "RosenwegKatalog", "text": "installiert: ch.rosenweg4303.home"},
            {"t": jetzt, "stufe": "X", "tag": "Absturz<>", "text": "kaputt"},
        ], G2101)
        self.assertEqual(r.status_code, 200, r.get_json())
        r = self.lesen("2101")
        self.assertEqual(r.status_code, 200, r.get_json())
        z = r.get_json()["zeilen"]
        self.assertEqual(len(z), 3)
        r = self.lesen("2101", query="?stufe=W")
        self.assertEqual([x["tag"] for x in r.get_json()["zeilen"]], ["RosenwegSperre"])
        r = self.lesen("2101", query="?tag=katalog")
        self.assertEqual([x["tag"] for x in r.get_json()["zeilen"]], ["RosenwegKatalog"])
        self.assertEqual(self.lesen("2002").get_json()["zeilen"], [])

    def test_nur_eigene_nebenstelle_und_nur_geraet(self):
        self.assertEqual(self.senden("2101", [{"text": "x"}], G2002).status_code, 403)
        self.assertEqual(self.senden("2101", [{"text": "x"}], {}).status_code, 401)
        self.assertEqual(self.lesen("2101", user=BEWOHNER).status_code, 403)
        self.assertEqual(self.lesen("2101", user=None).status_code, 401)

    def test_aufbewahrung_14_tage(self):
        conn = db.connect()
        conn.execute("INSERT INTO telefon_geraetelog (ext, zeit, stufe, tag, text, empfangen) VALUES ('2101', ?, 'I', 'alt', 'alt', ?)",
                     (int(time.time()) - 20 * 86400, int(time.time()) - 15 * 86400))
        conn.commit()
        conn.close()
        self.assertEqual(self.senden("2101", [{"t": int(time.time()) * 1000, "text": "neu", "tag": "RosenwegX"}], G2101).status_code, 200)
        z = self.lesen("2101").get_json()["zeilen"]
        self.assertEqual([x["text"] for x in z], ["neu"])
        conn = db.connect()
        conn.execute("INSERT INTO telefon_geraetelog (ext, zeit, stufe, tag, text, empfangen) VALUES ('2101', 1, 'I', 'a', 'a', 1)")
        conn.commit()
        pbx.telefon_geraetelog_aufraeumen()
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM telefon_geraetelog").fetchone()[0], 1)
        conn.close()

    def test_zu_viele_zeilen(self):
        r = self.senden("2101", [{"text": "x"}] * (pbx.LOG_MAX_ZEILEN + 1), G2101)
        self.assertEqual(r.status_code, 400)

    def test_apps_ist(self):
        r = self.c.post("/api/telefon/apps-ist", json={"apps": {"ch.rosenweg4303.telefon": 249, "ch.rosenweg4303.home": 12}}, headers=G2101)
        self.assertEqual(r.status_code, 200, r.get_json())
        conn = db.connect()
        rows = {r["paket"]: r["version_code"] for r in conn.execute("SELECT * FROM telefon_apps_ist WHERE ext = '2101'")}
        conn.close()
        self.assertEqual(rows, {"ch.rosenweg4303.telefon": 249, "ch.rosenweg4303.home": 12})
        self.assertEqual(self.c.post("/api/telefon/apps-ist", json={"apps": {"com.fremd": 1}}, headers=G2101).status_code, 400)
        self.assertEqual(self.c.post("/api/telefon/apps-ist", json={"apps": {"ch.rosenweg4303.x": "1"}}, headers=G2101).status_code, 400)
        self.assertEqual(self.c.post("/api/telefon/apps-ist", json={"apps": {"ch.rosenweg4303.x": 1}}).status_code, 401)

    def test_katalog_etag(self):
        r = self.c.get("/api/telefon/katalog", headers=G2101)
        self.assertEqual(r.status_code, 200)
        etag = r.headers.get("ETag")
        self.assertTrue(etag)
        r = self.c.get("/api/telefon/katalog", headers={**G2101, "If-None-Match": etag})
        self.assertEqual(r.status_code, 304)
        r = self.c.get("/api/telefon/katalog", headers={**G2101, "If-None-Match": '"anders"'})
        self.assertEqual(r.status_code, 200)


if __name__ == "__main__":
    unittest.main()
