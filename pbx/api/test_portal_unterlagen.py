"""Rosenweg Unterlagen auf geteilten Telefonen (Entscheid 28.11.2026: wie am eigenen Geraet),
Dateien stueckweise ueber den Portal-Weg (portal_bereich -> Range, Antwort als JSON
mit base64). Die Haupt-API ist eine Attrappe; es geht nichts ins Netz.

Laufen lassen: cd pbx/api && python3 -m unittest test_portal_unterlagen -v
"""
import base64
import json
import os
import tempfile
import unittest
from unittest import mock

_tmp = tempfile.mkdtemp()
os.environ["PBX_DB_PATH"] = os.path.join(_tmp, "pbx.sqlite")

import app as pbx  # noqa: E402
import db  # noqa: E402

PAKET = "ch.rosenweg4303.unterlagen"


class _Roh:
    def __init__(self, daten):
        self.daten = daten

    def read(self, n, decode_content=True):
        return self.daten[:n]


class _Antwort:
    def __init__(self, status, daten, kopf):
        self.status_code = status
        self.raw = _Roh(daten)
        self.headers = kopf

    def close(self):
        pass


class PortalUnterlagenTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        conn = db.connect()
        try:
            conn.execute("INSERT OR REPLACE INTO telefon_sitzungen (ext, user_id, email, name) "
                         "VALUES ('2098', '7', 'erika.muster@example.org', 'Erika Müster')")
            conn.commit()
        finally:
            conn.close()

    def setUp(self):
        self.client = pbx.app.test_client()
        self.anfragen = []
        self._p = [mock.patch.object(pbx, "_geraet", return_value=("2098", None)),
                   mock.patch.object(pbx, "PORTAL_ANLAGE_SECRET", "test-geheimnis"),
                   mock.patch.object(pbx, "_portal_regeln", return_value=pbx.PORTAL_PFADE_STANDARD)]
        for p in self._p:
            p.start()

    def tearDown(self):
        for p in self._p:
            p.stop()

    def _haupt(self, antwort):
        def anfrage(methode, url, headers=None, **kw):
            self.anfragen.append((methode, url, dict(headers or {})))
            return antwort
        return mock.patch.object(pbx.requests, "request", side_effect=anfrage)

    def _portal(self, methode, pfad, koerper=None):
        return self.client.post("/api/telefon/portal", json={"methode": methode, "pfad": pfad, "paket": PAKET, "koerper": koerper})

    def test_alles_freigegeben_ausser_ausweise(self):
        r = pbx.PORTAL_PFADE_STANDARD
        for m, p in [("GET", "/api/documents"), ("GET", "/api/documents/stweg3/bewohner/a.pdf"),
                     ("PUT", "/api/documents/stweg3/a.pdf"), ("DELETE", "/api/documents/stweg3/a.pdf"),
                     ("POST", "/api/documents/move"), ("POST", "/api/documents/folder"),
                     ("GET", "/api/documents-papierkorb"), ("POST", "/api/documents-papierkorb/3/wiederherstellen"),
                     ("GET", "/api/salz/stand"), ("GET", "/api/auth/me"), ("POST", "/api/projects/dach/timeline")]:
            self.assertTrue(pbx._portal_erlaubt(r, PAKET, m, p), (m, p))
        for m, p in [("POST", "/api/change-password"), ("GET", "/api/me/tokens"), ("POST", "/api/me/tokens"),
                     # PUT auth/profile ist seit 28.11.2026 frei (PORTAL_AUSNAHMEN), POST bleibt zu
                     ("DELETE", "/api/me/tokens/3"), ("POST", "/api/me/passkeys"), ("POST", "/api/auth/profile"),
                     ("POST", "/api/auth/login"), ("GET", "/api/Change-Password/"), ("POST", "/api//me//tokens"),
                     ("POST", "/api/%63hange-password"), ("POST", "/api/mqtt/my-app-passwords"),
                     ("POST", "/api/mqtt/user-app-passwords/3")]:
            self.assertFalse(pbx._portal_erlaubt(r, PAKET, m, p), (m, p))

    def test_bereich_lesen(self):
        self.assertEqual(pbx._portal_bereich("/api/documents/a.pdf"), ("/api/documents/a.pdf", None))
        self.assertEqual(pbx._portal_bereich("/api/documents/a.pdf?portal_bereich=0-99"), ("/api/documents/a.pdf", (0, 99)))
        self.assertEqual(pbx._portal_bereich("/api/documents-ordner?path=stweg3&portal_bereich=10-20&x=1"),
                         ("/api/documents-ordner?path=stweg3&x=1", (10, 20)))
        self.assertIs(pbx._portal_bereich("/api/documents/a.pdf?portal_bereich=99-0")[1], False)
        self.assertIs(pbx._portal_bereich(f"/api/documents/a.pdf?portal_bereich=0-{pbx.PORTAL_BINAER_TEIL}")[1], False)
        gross = pbx.PORTAL_BINAER_MAX
        self.assertIs(pbx._portal_bereich(f"/api/documents/a.pdf?portal_bereich={gross - 10}-{gross + 10}")[1], False)
        self.assertEqual(gross, 64 * 1024 * 1024)

    def test_stueck_als_base64(self):
        daten = bytes(range(256)) * 4
        a = _Antwort(206, daten, {"Content-Type": "application/pdf", "Content-Range": "bytes 1024-2047/5000",
                                  "ETag": '"abc"', "Content-Disposition": "inline; filename=\"p.pdf\""})
        with self._haupt(a):
            r = self._portal("GET", "/api/documents/stweg3/bewohner/p.pdf?portal_bereich=1024-2047")
        self.assertEqual(r.status_code, 200)
        b = json.loads(r.get_json()["json"])["binaer"]
        self.assertEqual(base64.b64decode(b["daten"]), daten)
        self.assertEqual((b["von"], b["bis"], b["gesamt"], b["typ"], b["etag"]), (1024, 2047, 5000, "application/pdf", '"abc"'))
        methode, url, kopf = self.anfragen[0]
        self.assertEqual(kopf["Range"], "bytes=1024-2047")
        self.assertTrue(url.endswith("/api/documents/stweg3/bewohner/p.pdf"), url)  # portal_bereich weg
        self.assertLess(len(r.get_data()), pbx.PORTAL_ANTWORT_MAX + 4096)

    def test_ganzes_stueck_passt_noch_in_die_antwort(self):
        daten = os.urandom(pbx.PORTAL_BINAER_TEIL)
        a = _Antwort(206, daten, {"Content-Type": "application/pdf", "Content-Range": f"bytes 0-{len(daten) - 1}/9000000"})
        with self._haupt(a):
            r = self._portal("GET", f"/api/documents/a.pdf?portal_bereich=0-{len(daten) - 1}")
        self.assertEqual(r.status_code, 200)
        self.assertLess(len(r.get_json()["json"].encode()), pbx.PORTAL_ANTWORT_MAX)

    def test_datei_zu_gross(self):
        a = _Antwort(206, b"x" * 10, {"Content-Type": "application/pdf", "Content-Range": f"bytes 0-9/{pbx.PORTAL_BINAER_MAX + 1}"})
        with self._haupt(a):
            r = self._portal("GET", "/api/documents/a.pdf?portal_bereich=0-9")
        self.assertEqual(r.status_code, 413)
        self.assertTrue(r.get_json()["zu_gross"])

    def test_json_bleibt_json(self):
        a = _Antwort(200, b'{"pfad":"","ordner":[]}', {"Content-Type": "application/json; charset=utf-8"})
        with self._haupt(a):
            r = self._portal("GET", "/api/documents-ordner?path=")
        self.assertEqual(json.loads(r.get_json()["json"]), {"pfad": "", "ordner": []})
        self.assertNotIn("Range", self.anfragen[0][2])

    def test_schreiben_geht_zur_haupt_api(self):
        with self._haupt(_Antwort(200, b"{}", {"Content-Type": "application/json"})):
            r = self._portal("PUT", "/api/documents/stweg3/a.pdf", "{}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(self.anfragen), 1)
        self.assertIn("Bearer ", self.anfragen[0][2]["Authorization"])

    def test_ausweis_aendern_abgelehnt(self):
        with self._haupt(_Antwort(200, b"{}", {})):
            r = self._portal("POST", "/api/change-password", "{}")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.anfragen, [])


if __name__ == "__main__":
    unittest.main()
