"""Versionsstand der Apps (POST /api/apps/stand, GET /api/pbx/apps-stand fuer das NOC).

Laufen lassen: cd pbx/api && python3 -m unittest test_apps_stand -v
"""
import os
import tempfile
import time
import unittest
from unittest import mock

_tmp = tempfile.mkdtemp()
os.environ["PBX_DB_PATH"] = os.path.join(_tmp, "pbx.sqlite")

import app as pbx  # noqa: E402
import db  # noqa: E402

G1 = "a" * 64
G2 = "b" * 64
TECHNIK = {"email": "technik@example.org", "name": "Technik", "groups": ["Technik"]}
BEWOHNER = {"email": "b@example.org", "name": "Bewohner", "groups": ["Bewohner"]}


class _Antwort:
    def __init__(self, status, daten):
        self.status_code, self.ok, self._d = status, 200 <= status < 300, daten

    def json(self):
        return self._d


def _me(user):
    def get(url, headers=None, timeout=None):
        return _Antwort(200, {"user": user}) if user else _Antwort(401, {})
    return get


class AppsStandTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        conn = db.connect()
        try:
            conn.execute("INSERT INTO telefon_apps (paket, name, art, apk_datei, sha256, groesse, version_code, version_name) "
                         "VALUES ('ch.rosenweg4303.notes', 'Rosenweg Notizen', 'apk', 'n.apk', 'x', 1, 20, '1.2.0')")
            conn.execute("INSERT INTO sip_extensions (ext, name, secret, context) VALUES ('2098', 'A15', 's', 'geteilt')")
            conn.execute("INSERT INTO telefon_apps_ist (ext, paket, version_code, geprueft) "
                         "VALUES ('2098', 'ch.rosenweg4303.notes', 20, ?)", (int(time.time()),))
            conn.commit()
        finally:
            conn.close()

    def setUp(self):
        self.c = pbx.app.test_client()
        pbx._STAND_GEBREMST.clear()

    def melden(self, body):
        return self.c.post("/api/apps/stand", json=body)

    def test_melden_und_noc(self):
        r = self.melden({"geraet": G1, "plattform": "android", "system": "Android SDK 36",
                         "apps": [{"paket": "ch.rosenweg4303.notes", "version": "1.1.0", "version_code": 19}]})
        self.assertEqual(r.status_code, 200, r.get_json())
        r = self.melden({"geraet": G2, "plattform": "android",
                         "apps": [{"paket": "ch.rosenweg4303.notes", "version": "1.2.0", "version_code": 20}]})
        self.assertEqual(r.status_code, 200)
        with mock.patch.object(pbx.requests, "get", side_effect=_me(TECHNIK)):
            r = self.c.get("/api/pbx/apps-stand", headers={"Authorization": "Bearer t"})
        self.assertEqual(r.status_code, 200, r.get_json())
        notes = next(a for a in r.get_json()["apps"] if a["paket"] == "ch.rosenweg4303.notes")
        self.assertEqual(notes["aktuell"], "1.2.0")
        self.assertEqual(notes["geraete"], 3)          # zwei eigene + Telefon 2098
        self.assertEqual(notes["veraltet"], 1)
        self.assertEqual(notes["liste"][0]["geraet"], G1[:12])   # veraltete zuerst, Kennung gekuerzt
        self.assertTrue(any(x["geraet"] == "Telefon 2098" for x in notes["liste"]))

    def test_neue_meldung_ersetzt(self):
        self.melden({"geraet": G1, "plattform": "linux-deb",
                     "apps": [{"paket": "ch.rosenweg4303.vm", "version": "1.2.0"},
                              {"paket": "ch.rosenweg4303.salz", "version": "1.0.0"}]})
        self.melden({"geraet": G1, "plattform": "linux-deb", "apps": [{"paket": "ch.rosenweg4303.vm", "version": "1.3.0"}]})
        conn = db.connect()
        try:
            rows = conn.execute("SELECT paket, version FROM apps_stand WHERE geraet = ? AND plattform = 'linux-deb'",
                                (G1,)).fetchall()
        finally:
            conn.close()
        self.assertEqual([(r["paket"], r["version"]) for r in rows], [("ch.rosenweg4303.vm", "1.3.0")])

    def test_ungueltig(self):
        for body in ({"geraet": "kurz", "plattform": "android", "apps": [{"paket": "ch.rosenweg4303.notes"}]},
                     {"geraet": G1, "plattform": "ios", "apps": [{"paket": "ch.rosenweg4303.notes"}]},
                     {"geraet": G1, "plattform": "android", "apps": []},
                     {"geraet": G1, "plattform": "android", "apps": [{"paket": "com.fremd.app", "version": "1"}]},
                     {"geraet": G1, "plattform": "android", "apps": [{"paket": "ch.rosenweg4303.x", "version": "<b>"}]},
                     {"geraet": G1, "plattform": "android", "apps": [{"paket": "ch.rosenweg4303.x", "version_code": "9"}]}):
            self.assertEqual(self.melden(body).status_code, 400, body)

    def test_gebremst(self):
        b = {"geraet": G2, "plattform": "windows", "apps": [{"paket": "ch.rosenweg4303.vm", "version": "1.0.0"}]}
        for _ in range(pbx.STAND_MAX_STUNDE):
            self.assertEqual(self.melden(b).status_code, 200)
        self.assertEqual(self.melden(b).status_code, 429)

    def test_noc_nur_technik(self):
        with mock.patch.object(pbx.requests, "get", side_effect=_me(BEWOHNER)):
            r = self.c.get("/api/pbx/apps-stand", headers={"Authorization": "Bearer t"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.c.get("/api/pbx/apps-stand").status_code, 401)

    def test_version_vergleich(self):
        self.assertTrue(pbx._stand_veraltet("1.9.3", None, {"version": "1.10.0"}))
        self.assertFalse(pbx._stand_veraltet("1.10.0+5", None, {"version": "1.10.0"}))
        self.assertIsNone(pbx._stand_veraltet("1.0", None, None))


if __name__ == "__main__":
    unittest.main()
