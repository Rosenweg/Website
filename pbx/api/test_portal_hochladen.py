"""Hochladen auf geteilten Telefonen in Stuecken (portal_hochladen, 64 MB). Die Haupt-API ist
eine Attrappe; es geht nichts ins Netz.

Laufen lassen: cd pbx/api && python3 -m unittest test_portal_hochladen -v
"""
import base64
import json
import os
import tempfile
import unittest
from unittest import mock

_tmp = tempfile.mkdtemp()
os.environ["PBX_DB_PATH"] = os.path.join(_tmp, "pbx.sqlite")
os.environ["PORTAL_HOCH_DIR"] = os.path.join(_tmp, "hoch")

import app as pbx  # noqa: E402
import db  # noqa: E402

PAKET = "ch.rosenweg4303.unterlagen"
PFAD = "/api/documents/stweg3/a.pdf"


class _Roh:
    def __init__(self, daten):
        self.daten = daten

    def read(self, n, decode_content=True):
        return self.daten[:n]


class _Antwort:
    def __init__(self, status=201, daten=b'{"ok":true}'):
        self.status_code = status
        self.raw = _Roh(daten)
        self.headers = {"Content-Type": "application/json"}

    def close(self):
        pass


class PortalHochladenTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()

    def setUp(self):
        conn = db.connect()
        try:
            conn.execute("INSERT OR REPLACE INTO telefon_sitzungen (ext, user_id, email, name) "
                         "VALUES ('2098', '7', 'erika.muster@example.org', 'Erika Müster')")
            conn.commit()
        finally:
            conn.close()
        self.client = pbx.app.test_client()
        self.aufrufe = []
        self._p = [mock.patch.object(pbx, "_geraet", return_value=("2098", None)),
                   mock.patch.object(pbx, "PORTAL_ANLAGE_SECRET", "test-geheimnis"),
                   mock.patch.object(pbx, "_portal_regeln", return_value=pbx.PORTAL_PFADE_STANDARD)]
        for p in self._p:
            p.start()

    def tearDown(self):
        for p in self._p:
            p.stop()

    def _haupt(self, antwort=None):
        def anfrage(methode, url, **kw):
            self.aufrufe.append((methode, url, kw))
            return antwort or _Antwort()
        return mock.patch.object(pbx.requests, "request", side_effect=anfrage)

    def _teil(self, tid, nr, anzahl, gesamt, daten, kopf=None, methode="POST", pfad=PFAD):
        t = {"id": tid, "nr": nr, "anzahl": anzahl, "gesamt": gesamt}
        if kopf is not None:
            t["kopf"] = kopf
        return self.client.post("/api/telefon/portal", json={
            "methode": methode, "pfad": pfad, "paket": PAKET, "koerper": base64.b64encode(daten).decode(), "teil": t})

    def test_roh_in_drei_stuecken(self):
        daten = os.urandom(pbx.PORTAL_HOCH_TEIL * 2 + 100)
        tid = "a" * 16
        kopf = {"name": "Rechnung März.pdf", "typ": "application/pdf", "kopf": {"If-None-Match": "*", "Cookie": "x"}}
        with self._haupt():
            r0 = self._teil(tid, 0, 3, len(daten), daten[:pbx.PORTAL_HOCH_TEIL], kopf)
            self.assertEqual((r0.status_code, r0.get_json()["status"]), (200, 202))
            r1 = self._teil(tid, 1, 3, len(daten), daten[pbx.PORTAL_HOCH_TEIL:2 * pbx.PORTAL_HOCH_TEIL])
            self.assertEqual(r1.get_json()["status"], 202)
            self.assertEqual(self.aufrufe, [])
            r2 = self._teil(tid, 2, 3, len(daten), daten[2 * pbx.PORTAL_HOCH_TEIL:])
        self.assertEqual(r2.get_json()["status"], 201)
        methode, url, kw = self.aufrufe[0]
        self.assertEqual(methode, "POST")
        self.assertTrue(url.endswith(PFAD))
        self.assertEqual(kw["data"], daten)
        h = kw["headers"]
        self.assertEqual(h["Content-Type"], "application/pdf")
        self.assertEqual(h["X-Filename"], "Rechnung%20M%C3%A4rz.pdf")
        self.assertEqual(h["If-None-Match"], "*")
        self.assertNotIn("Cookie", h)
        self.assertIn("Bearer ", h["Authorization"])
        self.assertFalse(os.path.exists(os.path.join(_tmp, "hoch", f"2098-{tid}")))

    def test_multipart(self):
        daten = b"%PDF-1.4 klein"
        kopf = {"name": "x.pdf", "typ": "application/pdf", "multipart": True, "feld": "file", "felder": {"titel": "T"}}
        with self._haupt():
            r = self._teil("b" * 16, 0, 1, len(daten), daten, kopf, pfad="/api/stweg/3/mitteilungen/bild")
        self.assertEqual(r.get_json()["status"], 201)
        kw = self.aufrufe[0][2]
        self.assertEqual(kw["files"]["file"], ("x.pdf", daten, "application/pdf"))
        self.assertEqual(kw["data"], {"titel": "T"})

    def test_reihenfolge_und_groesse(self):
        tid = "c" * 16
        kopf = {"name": "x", "typ": "text/plain"}
        with self._haupt():
            self._teil(tid, 0, 3, 30, b"x" * 10, kopf)
            r = self._teil(tid, 2, 3, 30, b"x" * 10)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.aufrufe, [])
        with self._haupt():
            self._teil("d" * 16, 0, 2, 15, b"x" * 10, kopf)
            r = self._teil("d" * 16, 1, 2, 15, b"x" * 10)   # 20 > 15
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.aufrufe, [])

    def test_ohne_start_410_und_ungueltig(self):
        self.assertEqual(self._teil("e" * 16, 1, 2, 20, b"x").status_code, 410)
        self.assertEqual(self._teil("zz", 0, 1, 1, b"x", {}).status_code, 400)
        self.assertEqual(self._teil("f" * 16, 0, 1, pbx.PORTAL_BINAER_MAX + 1, b"x", {}).status_code, 400)
        self.assertEqual(self._teil("f" * 16, 0, 1, 1, b"x" * (pbx.PORTAL_HOCH_TEIL + 1), {}).status_code, 413)
        self.assertEqual(self._teil("f" * 16, 0, 1, 1, b"x", {}, methode="DELETE").status_code, 400)

    def test_personenwechsel_beendet_upload(self):
        tid = "9" * 16
        kopf = {"name": "x", "typ": "text/plain"}
        with self._haupt():
            self._teil(tid, 0, 2, 20, b"x" * 10, kopf)
            conn = db.connect()
            try:
                conn.execute("UPDATE telefon_sitzungen SET email='anna@example.org' WHERE ext='2098'")
                conn.commit()
            finally:
                conn.close()
            r = self._teil(tid, 1, 2, 20, b"x" * 10)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(self.aufrufe, [])

    def test_nur_freigegebener_pfad(self):
        with self._haupt():
            r = self._teil("8" * 16, 0, 1, 1, b"x", {}, pfad="/api/change-password")
        self.assertEqual(r.status_code, 403)

    def test_limit_64_mb_passt_in_die_stuecke(self):
        self.assertLessEqual(pbx.PORTAL_BINAER_MAX / pbx.PORTAL_HOCH_TEIL, pbx.PORTAL_HOCH_TEILE_MAX)
        self.assertLess(len(base64.b64encode(b"x" * pbx.PORTAL_HOCH_TEIL)), pbx.PORTAL_KOERPER_MAX)


if __name__ == "__main__":
    unittest.main()
