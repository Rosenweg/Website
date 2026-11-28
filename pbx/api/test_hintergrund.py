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


class _Ok:
    def __init__(self, ok=True, status=200, daten=None):
        self.ok, self.status_code, self._daten = ok, status, daten or {}

    def json(self):
        return self._daten


class PersonLoeschenTest(_Basis):
    """Loeschungen (Stefan 27.11.2026: "alles loeschen, ueber die richtigen Ablaeufe").
    Attrappen: pjsip (regenerate_phones_conf), nc-token (requests.post), Website (requests.put)."""

    def setUp(self):
        super().setUp()
        self.vm = tempfile.mkdtemp()
        for name, wert in (("PBX_SHARED_SECRET", "pbx-geheim"), ("VM_PERSON_DIR", self.vm),
                           ("NC_TOKEN_URL", "http://nc-token.test")):
            p = mock.patch.object(pbx, name, wert)
            p.start()
            self.addCleanup(p.stop)
        self.pjsip = mock.patch.object(pbx, "regenerate_phones_conf")
        self.pjsip_m = self.pjsip.start()
        self.addCleanup(self.pjsip.stop)
        self.nc = mock.patch.object(pbx.requests, "post", return_value=_Ok())
        self.nc_m = self.nc.start()
        self.addCleanup(self.nc.stop)
        self.web = mock.patch.object(pbx.requests, "put", return_value=_Ok())
        self.web_m = self.web.start()
        self.addCleanup(self.web.stop)
        conn = db.connect()
        try:
            for t in ("telefon_einstellungen", "telefon_pin", "telefon_ausweise", "telefon_nextcloud",
                      "telefon_sip_person", "telefon_sip_privat", "personen_nummern", "calls", "telefon_log"):
                conn.execute(f"DELETE FROM {t}")
            for wer, nr in ((ANNA, "301011"), (BERT, "302021")):
                conn.execute("INSERT INTO personen_nummern (nummer, email, name, aktiv) VALUES (?,?,?,1)",
                             (nr, wer, wer.split("@")[0]))
                conn.execute("INSERT INTO telefon_einstellungen (email, paket, werte, geaendert) "
                             "VALUES (?, 'ch.rosenweg4303.home', '{}', 1)", (wer,))
                conn.execute("INSERT INTO telefon_pin (email, pin_enc) VALUES (?, 'x')", (wer,))
                conn.execute("INSERT INTO telefon_ausweise (token_hash, email, name, expires_at) "
                             "VALUES (?, ?, 'X', '2099-01-01T00:00:00Z')", ("h-" + wer, wer))
                conn.execute("INSERT INTO telefon_sip_privat (nummer, email, passwort) VALUES (?,?, 'pw')", (nr, wer))
            conn.execute("INSERT INTO telefon_nextcloud (ext, email, benutzer, pw_enc) VALUES ('2201', ?, 'anna', 'x')",
                         (ANNA,))
            conn.execute("INSERT INTO telefon_sip_person (ext, nummer, email, passwort) VALUES ('2201', '301011', ?, 'pw')",
                         (ANNA,))
            conn.execute("INSERT INTO telefon_log (ext, ereignis, email, name, durch) VALUES ('2201', 'an', ?, 'Anna', ?)",
                         (ANNA, ANNA))
            conn.execute("INSERT INTO calls (direction, caller_id, dialed, uniqueid, ext, person, ziel_ext, ziel_person, "
                         "voicemail_path, voicemail_transcript) VALUES ('internal', '302021', '301011', 'u1', "
                         "'302021-p1', ?, '301011-2201', ?, ?, 'Hallo Anna')",
                         (BERT, ANNA, os.path.join(self.vm, "301011-u1.wav")))
            conn.execute("INSERT INTO calls (direction, caller_id, dialed, uniqueid, person, ziel_person) "
                         "VALUES ('internal', '302021', '0611234567', 'u2', ?, NULL)", (BERT,))
            conn.commit()
        finally:
            conn.close()
        for f in ("301011-u1.wav", "301011-u9.wav", "302021-u5.wav"):
            open(os.path.join(self.vm, f), "wb").close()
        self.hoch("2201", _jpeg())

    def loeschen(self, email, secret="pbx-geheim"):
        return self.c.post("/api/pbx/person/loeschen", json={"email": email},
                           headers={"X-PBX-Secret": secret})

    def eins(self, sql, *a):
        conn = db.connect()
        try:
            return conn.execute(sql, a).fetchone()
        finally:
            conn.close()

    def test_alle_schritte(self):
        r = self.loeschen(ANNA.upper())
        self.assertEqual(r.status_code, 200, r.get_json())
        d = r.get_json()
        self.assertTrue(d["ok"], d)
        self.assertEqual(sorted(d["schritte"]), sorted(d["reihenfolge"]))
        self.assertEqual(d["reihenfolge"], ["sitzungen", "nextcloud", "sip", "combox", "nummern", "daten",
                                               "anrufe", "protokoll"])
        st = d["schritte"]
        # 1. abgemeldet ueber _telefon_abmelden (Sitzung weg, 'ab' im Protokoll)
        self.assertEqual(st["sitzungen"]["abgemeldet"], ["2201"])
        self.assertIsNone(self.eins("SELECT 1 FROM telefon_sitzungen WHERE ext = '2201'"))
        self.assertIsNotNone(self.eins("SELECT 1 FROM telefon_sitzungen WHERE ext = '2202'"))   # Bert bleibt
        # 2. Nextcloud bei nc-token widerrufen
        self.assertEqual(st["nextcloud"]["widerrufen"], ["2201"])
        url, = self.nc_m.call_args.args
        self.assertEqual(url, "http://nc-token.test/widerrufen")
        self.assertEqual(self.nc_m.call_args.kwargs["json"], {"email": ANNA, "name": "Rosenweg Geraet 2201"})
        self.assertIsNone(self.eins("SELECT 1 FROM telefon_nextcloud"))
        # 3. SIP-Zugaenge weg, pjsip neu geschrieben
        self.assertEqual((st["sip"]["sip_person"] + 0, st["sip"]["sip_privat"]), (0, 1))   # sip_person ging mit dem Abmelden
        self.assertTrue(self.pjsip_m.called)
        self.assertIsNone(self.eins("SELECT 1 FROM telefon_sip_person"))
        self.assertIsNone(self.eins("SELECT 1 FROM telefon_sip_privat WHERE email = ?", ANNA))
        self.assertIsNotNone(self.eins("SELECT 1 FROM telefon_sip_privat WHERE email = ?", BERT))
        # 4. Combox: Annas Sprachnachrichten weg, Berts bleibt
        self.assertEqual(st["combox"]["dateien"], 2)
        self.assertEqual(sorted(os.listdir(self.vm)), ["302021-u5.wav"])
        self.assertIsNone(self.eins("SELECT voicemail_transcript FROM calls WHERE uniqueid = 'u1'")[0])
        # 5. Nummer freigegeben und der Website gemeldet (ganze Liste ohne Anna)
        self.assertEqual(st["nummern"], {"ok": True, "nummern": ["301011"], "website": True})
        self.assertIsNone(self.eins("SELECT 1 FROM personen_nummern WHERE nummer = '301011'"))
        gemeldet = self.web_m.call_args.kwargs["json"]["nummern"]
        self.assertEqual([n["nummer"] for n in gemeldet], ["302021"])
        # 6. Einstellungen, PIN, Anmelde-QR, Hintergrund
        self.assertEqual(st["daten"], {"ok": True, "telefon_einstellungen": 1, "telefon_pin": 1,
                                       "telefon_ausweise": 1, "hintergrund": True})
        self.assertTrue(d["hintergrund"])
        for t in ("telefon_einstellungen", "telefon_pin", "telefon_ausweise", "telefon_hintergrund"):
            self.assertIsNone(self.eins(f"SELECT 1 FROM {t} WHERE lower(email) = ?", ANNA), t)
            self.assertIsNotNone(self.eins(f"SELECT 1 FROM {t} WHERE email = ?", BERT) if t != "telefon_hintergrund"
                                 else True, t)
        self.assertFalse(os.path.exists(pbx._hintergrund_datei(ANNA)))
        # 7. Anrufe anonymisiert (bleiben fuer die Statistik), Berts Seite unveraendert
        a = self.eins("SELECT * FROM calls WHERE uniqueid = 'u1'")
        self.assertEqual((a["ziel_person"], a["dialed"], a["ziel_ext"]), ("gelöscht", "gelöscht", "gelöscht"))
        self.assertEqual((a["person"], a["caller_id"], a["ext"]), (BERT, "302021", "302021-p1"))
        self.assertEqual(self.eins("SELECT COUNT(*) FROM calls")[0], 2)
        # 8. Protokoll anonymisiert, Zeilen bleiben
        self.assertIsNone(self.eins("SELECT 1 FROM telefon_log WHERE lower(email) = ? OR durch = ?", ANNA, ANNA))
        self.assertEqual(self.eins("SELECT COUNT(*) FROM telefon_log WHERE email = 'gelöscht' AND name = 'gelöscht'")[0], 2)

    def test_fehler_eines_schritts_rest_laeuft(self):
        self.nc_m.return_value = _Ok(False, 500)
        self.pjsip_m.side_effect = OSError("asterisk weg")
        self.web_m.return_value = _Ok(False, 502)
        d = self.loeschen(ANNA).get_json()
        self.assertFalse(d["ok"])
        st = d["schritte"]
        self.assertFalse(st["nextcloud"]["ok"])
        self.assertIn("2201", st["nextcloud"]["fehler"])
        self.assertIsNotNone(self.eins("SELECT 1 FROM telefon_nextcloud WHERE ext = '2201'"))   # nicht widerrufen = bleibt
        self.assertFalse(st["sip"]["ok"])
        self.assertIn("asterisk weg", st["sip"]["fehler"])
        self.assertFalse(st["nummern"]["ok"])
        self.assertIn("Website", st["nummern"]["fehler"])
        for n in ("sitzungen", "combox", "daten", "anrufe", "protokoll"):
            self.assertTrue(st[n]["ok"], n)
        self.assertIsNone(self.eins("SELECT 1 FROM telefon_pin WHERE email = ?", ANNA))
        # Nochmals, wenn alles wieder geht: Widerruf und pjsip holen nach
        self.nc_m.return_value = _Ok()
        self.pjsip_m.side_effect = None
        self.web_m.return_value = _Ok()
        self.pjsip_m.reset_mock()
        d = self.loeschen(ANNA).get_json()
        self.assertTrue(d["ok"], d)
        self.assertTrue(self.pjsip_m.called)
        self.assertIsNone(self.eins("SELECT 1 FROM telefon_nextcloud"))

    def loeschen_mit(self, body):
        return self.c.post("/api/pbx/person/loeschen", json=body, headers={"X-PBX-Secret": "pbx-geheim"})

    def test_nextcloud_konto_nur_wenn_verlangt(self):
        """Ohne schritte (aeltere Haupt-API) wie bisher; das Nextcloud-Konto nur auf Verlangen."""
        self.loeschen(ANNA)
        self.assertNotIn("http://nc-token.test/konto-loeschen", [c.args[0] for c in self.nc_m.call_args_list])
        self.nc_m.reset_mock()
        self.nc_m.return_value = _Ok(daten={"geloescht": ["anna"]})
        d = self.loeschen_mit({"email": ANNA, "schritte": ["nextcloud_konto"]}).get_json()
        self.assertTrue(d["ok"], d)
        self.assertEqual(list(d["schritte"]), ["nextcloud_konto"])
        self.assertEqual(d["schritte"]["nextcloud_konto"]["konten"], 1)
        self.assertEqual(self.nc_m.call_args.args, ("http://nc-token.test/konto-loeschen",))
        self.assertEqual(self.nc_m.call_args.kwargs["json"], {"email": ANNA})

    def test_nextcloud_konto_fehlt_oder_admin(self):
        self.nc_m.return_value = _Ok(False, 404)
        d = self.loeschen_mit({"email": ANNA, "schritte": ["nextcloud_konto"]}).get_json()
        self.assertTrue(d["ok"], d)                          # kein Konto = erledigt
        self.nc_m.return_value = _Ok(False, 409)
        d = self.loeschen_mit({"email": ANNA, "schritte": ["nextcloud_konto"]}).get_json()
        self.assertFalse(d["ok"])                            # Admin: bleibt offen
        self.assertIn("409", d["schritte"]["nextcloud_konto"]["fehler"])

    def test_wiederholung_nur_offene_schritte_mit_frueheren_nummern(self):
        """Der Nachlauf der Haupt-API wiederholt nur, was scheiterte. Die Nummer ist dann schon
        freigegeben; die Anrufe werden trotzdem ueber die mitgegebene Nummer anonymisiert."""
        conn = db.connect()
        try:
            conn.execute("DELETE FROM personen_nummern WHERE email = ?", (ANNA,))
            conn.commit()
        finally:
            conn.close()
        d = self.loeschen_mit({"email": ANNA, "schritte": ["anrufe"], "nummern": ["301011", "x; drop"]}).get_json()
        self.assertTrue(d["ok"], d)
        self.assertEqual(list(d["schritte"]), ["anrufe"])
        self.assertEqual(d["nummern"], ["301011"])
        a = self.eins("SELECT * FROM calls WHERE uniqueid = 'u1'")
        self.assertEqual((a["ziel_person"], a["dialed"]), ("gelöscht", "gelöscht"))
        # andere Schritte liefen nicht
        self.assertIsNotNone(self.eins("SELECT 1 FROM telefon_pin WHERE email = ?", ANNA))

    def test_schritte_ungueltig(self):
        self.assertEqual(self.loeschen_mit({"email": ANNA, "schritte": ["rm -rf"]}).status_code, 400)
        self.assertEqual(self.loeschen_mit({"email": ANNA, "schritte": []}).status_code, 400)
        self.assertEqual(self.loeschen_mit({"email": ANNA, "schritte": "sip"}).status_code, 400)

    def test_unbekannte_person_alles_ok(self):
        d = self.loeschen("niemand@example.org").get_json()
        self.assertTrue(d["ok"], d)
        self.assertFalse(self.nc_m.called)
        self.assertFalse(self.web_m.called)

    def test_fernwartung_unberuehrt(self):
        conn = db.connect()
        try:
            conn.execute("INSERT INTO telefon_fernwartung (ext, person, beginn) VALUES ('2201', ?, 1)", (ANNA,))
            conn.commit()
        finally:
            conn.close()
        self.loeschen(ANNA)
        self.assertIsNotNone(self.eins("SELECT 1 FROM telefon_fernwartung WHERE person = ?", ANNA))

    def test_nur_mit_geheimnis(self):
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
