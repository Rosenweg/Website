"""Hintergrundbild des Startbildschirms pro Person (geteilte Telefone).

GET/PUT/DELETE /api/telefon/hintergrund (Geraetezugang, Person der Sitzung),
"hintergrund" im Status, DELETE /api/telefon/ich/hintergrund (Mein Telefon).

Laufen lassen: cd pbx/api && python3 -m unittest test_hintergrund -v
"""
import base64
import os
import struct
import tempfile
import unittest
from unittest import mock

_tmp = tempfile.mkdtemp()
os.environ.setdefault("PBX_DB_PATH", os.path.join(_tmp, "pbx.sqlite"))

import app as pbx  # noqa: E402
import db  # noqa: E402

ANNA = "anna.hg@example.org"
BERT = "bert.hg@example.org"


def _jpeg(breite=720, hoehe=1600, fuell=100):
    """Kleinstes Geruest, das wie ein JPEG aussieht (SOI, APP0, SOF0, SOS, EOI)."""
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    sof = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, hoehe, breite, 1) + b"\x01\x11\x00"
    sos = b"\xff\xda" + struct.pack(">H", 8) + b"\x01\x01\x00\x00\x3f\x00"
    return b"\xff\xd8" + app0 + sof + sos + b"\x00" * fuell + b"\xff\xd9"


def _basic(ext, secret):
    return {"Authorization": "Basic " + base64.b64encode(f"{ext}:{secret}".encode()).decode()}


class _Antwort:
    def __init__(self, status, daten):
        self.status_code, self.ok, self._d = status, 200 <= status < 300, daten

    def json(self):
        return self._d


def _me(user):
    def get(url, headers=None, timeout=None):
        return _Antwort(200, {"user": user}) if user else _Antwort(401, {})
    return get


class _Basis(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        conn = db.connect()
        try:
            for ext, ctx in (("2201", "geteilt"), ("2202", "geteilt"), ("2203", "geteilt"), ("2299", "internal")):
                conn.execute("INSERT OR REPLACE INTO sip_extensions (ext, name, secret, context) VALUES (?,?,?,?)",
                             (ext, "Telefon " + ext, "geheim" + ext, ctx))
            conn.commit()
        finally:
            conn.close()

    def setUp(self):
        self.c = pbx.app.test_client()
        self.dir = tempfile.mkdtemp()
        p = mock.patch.object(pbx, "HINTERGRUND_DIR", self.dir)
        p.start()
        self.addCleanup(p.stop)
        conn = db.connect()
        try:
            conn.execute("DELETE FROM telefon_sitzungen WHERE ext IN ('2201','2202','2203','2299')")
            conn.execute("DELETE FROM telefon_hintergrund")
            conn.execute("INSERT INTO telefon_sitzungen (ext, email, name, gruppen) VALUES ('2201', ?, 'Anna', '[]')",
                         (ANNA,))
            conn.execute("INSERT INTO telefon_sitzungen (ext, email, name, gruppen) VALUES ('2202', ?, 'Bert', '[]')",
                         (BERT,))
            conn.commit()
        finally:
            conn.close()

    def hoch(self, ext, daten, **kw):
        return self.c.put("/api/telefon/hintergrund", data=daten, content_type="image/jpeg",
                          headers=_basic(ext, kw.get("secret", "geheim" + ext)))

    def hole(self, ext):
        return self.c.get("/api/telefon/hintergrund", headers=_basic(ext, "geheim" + ext))

    def status(self, ext):
        return self.c.get("/api/telefon/status", headers=_basic(ext, "geheim" + ext)).get_json()

class HintergrundTest(_Basis):
    def test_ohne_bild_standard(self):
        self.assertEqual(self.hole("2201").status_code, 404)
        self.assertEqual(self.status("2201")["hintergrund"], "")

    def test_hochladen_holen_status(self):
        bild = _jpeg()
        r = self.hoch("2201", bild)
        self.assertEqual(r.status_code, 200, r.get_json())
        version = r.get_json()["version"]
        self.assertEqual(len(version), 16)
        g = self.hole("2201")
        self.assertEqual(g.status_code, 200)
        self.assertEqual(g.data, bild)
        self.assertEqual(g.headers["X-Hintergrund-Version"], version)
        self.assertEqual(g.mimetype, "image/jpeg")
        self.assertEqual(self.status("2201")["hintergrund"], version)
        # Datei ausserhalb der DB, ohne E-Mail im Namen
        dateien = os.listdir(self.dir)
        self.assertEqual(len(dateien), 1)
        self.assertNotIn("anna", dateien[0])

    def test_folgt_der_person_auf_anderes_telefon(self):
        v = self.hoch("2201", _jpeg()).get_json()["version"]
        conn = db.connect()
        try:
            conn.execute("DELETE FROM telefon_sitzungen WHERE ext = '2201'")
            conn.execute("INSERT INTO telefon_sitzungen (ext, email, name, gruppen) VALUES ('2203', ?, 'Anna', '[]')",
                         (ANNA.upper(),))
            conn.commit()
        finally:
            conn.close()
        self.assertEqual(self.status("2203")["hintergrund"], v)
        self.assertEqual(self.hole("2203").status_code, 200)

    def test_keine_fremden_bilder(self):
        self.hoch("2201", _jpeg())
        # Bert (anderes Telefon) sieht Annas Bild nicht
        self.assertEqual(self.hole("2202").status_code, 404)
        self.assertEqual(self.status("2202")["hintergrund"], "")
        # Bert ueberschreibt nur sein eigenes
        self.hoch("2202", _jpeg(fuell=300))
        self.assertNotEqual(self.hole("2201").data, self.hole("2202").data)

    def test_niemand_angemeldet_409(self):
        self.assertEqual(self.hoch("2203", _jpeg()).status_code, 409)
        self.assertEqual(self.hole("2203").status_code, 409)

    def test_falscher_zugang_und_nicht_geteilt_401(self):
        self.assertEqual(self.hoch("2201", _jpeg(), secret="falsch").status_code, 401)
        self.assertEqual(self.c.get("/api/telefon/hintergrund").status_code, 401)
        # Nebenstelle ohne context=geteilt (eigenes Handy, Tischtelefon): nichts
        self.assertEqual(self.hoch("2299", _jpeg()).status_code, 401)

    def test_zu_gross_413(self):
        with mock.patch.object(pbx, "HINTERGRUND_MAX", 1000):
            r = self.hoch("2201", _jpeg(fuell=2000))
        self.assertEqual(r.status_code, 413)
        self.assertEqual(os.listdir(self.dir), [])

    def test_kein_jpeg_400(self):
        self.assertEqual(self.hoch("2201", b"\x89PNG\r\n\x1a\n" + b"\x00" * 50).status_code, 400)
        self.assertEqual(self.hoch("2201", b"").status_code, 400)
        # riesige Pixelmasse
        self.assertEqual(self.hoch("2201", _jpeg(breite=9000, hoehe=9000)).status_code, 400)

    def test_zuruecksetzen_vom_telefon(self):
        self.hoch("2201", _jpeg())
        r = self.c.delete("/api/telefon/hintergrund", headers=_basic("2201", "geheim2201"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.hole("2201").status_code, 404)
        self.assertEqual(self.status("2201")["hintergrund"], "")
        self.assertEqual(os.listdir(self.dir), [])

    def test_zuruecksetzen_mein_telefon(self):
        self.hoch("2201", _jpeg())
        self.hoch("2202", _jpeg(fuell=300))
        with mock.patch.object(pbx.requests, "get", side_effect=_me({"email": ANNA, "name": "Anna"})):
            r = self.c.delete("/api/telefon/ich/hintergrund", headers={"Authorization": "Bearer x"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.status("2201")["hintergrund"], "")
        self.assertNotEqual(self.status("2202")["hintergrund"], "")   # Bert bleibt

    def test_mein_telefon_ohne_anmeldung_401(self):
        with mock.patch.object(pbx.requests, "get", side_effect=_me(None)):
            r = self.c.delete("/api/telefon/ich/hintergrund", headers={"Authorization": "Bearer x"})
        self.assertEqual(r.status_code, 401)


class PersonLoeschenTest(_Basis):
    """Loeschungen: die Haupt-API meldet ein geloeschtes Konto, die Anlage entfernt das Bild."""

    def loeschen(self, email, secret="pbx-geheim"):
        return self.c.post("/api/pbx/person/loeschen", json={"email": email},
                           headers={"X-PBX-Secret": secret})

    def test_bild_und_zeile_weg(self):
        with mock.patch.object(pbx, "PBX_SHARED_SECRET", "pbx-geheim"):
            self.hoch("2201", _jpeg())
            self.hoch("2202", _jpeg(fuell=300))
            r = self.loeschen(ANNA.upper())
            self.assertEqual(r.status_code, 200)
            self.assertTrue(r.get_json()["hintergrund"])
            conn = db.connect()
            try:
                self.assertIsNone(conn.execute("SELECT 1 FROM telefon_hintergrund WHERE email = ?", (ANNA,)).fetchone())
            finally:
                conn.close()
            self.assertFalse(os.path.exists(pbx._hintergrund_datei(ANNA)))
            self.assertTrue(os.path.exists(pbx._hintergrund_datei(BERT)))   # nur die Person
            self.assertFalse(self.loeschen(ANNA).get_json()["hintergrund"])  # zweimal: ok

    def test_nur_mit_geheimnis(self):
        with mock.patch.object(pbx, "PBX_SHARED_SECRET", "pbx-geheim"):
            self.hoch("2201", _jpeg())
            self.assertEqual(self.loeschen(ANNA, secret="falsch").status_code, 401)
            self.assertEqual(self.c.post("/api/pbx/person/loeschen", json={"email": ANNA}).status_code, 401)
            self.assertTrue(os.path.exists(pbx._hintergrund_datei(ANNA)))
            self.assertEqual(self.loeschen("").status_code, 400)
        with mock.patch.object(pbx, "PBX_SHARED_SECRET", ""):
            self.assertEqual(self.loeschen(ANNA, secret="").status_code, 401)


class JpegMasseTest(unittest.TestCase):
    def test_masse(self):
        self.assertEqual(pbx._jpeg_masse(_jpeg(720, 1600)), (720, 1600))

    def test_kein_jpeg(self):
        self.assertIsNone(pbx._jpeg_masse(b"GIF89a"))
        self.assertIsNone(pbx._jpeg_masse(b"\xff\xd8\xff"))
        self.assertIsNone(pbx._jpeg_masse(b"\xff\xd8\xff\xe0\x00\x01"))


if __name__ == "__main__":
    unittest.main()
