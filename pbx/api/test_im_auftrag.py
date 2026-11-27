"""Rosenweg Mein Telefon auf geteilten Telefonen: die Haupt-API fragt hier im Auftrag
der Person am Telefon (api/routes/telefonanlage.js, Entscheid Stefan 27.11.2026).

Kopf X-Rosenweg-Im-Auftrag gilt nur mit X-PBX-Secret und nur fuer die Pfade von
Mein Telefon; die Person bekommt dabei keine Technik-Rechte.

Laufen lassen: cd pbx/api && python3 -m unittest test_im_auftrag -v
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

GEHEIM = "pbx-test-geheimnis"


def _person(email="erika.muster@example.org", name="Erika Müster", groups=("Bewohner", "Technik")):
    roh = json.dumps({"id": 7, "email": email, "name": name, "groups": list(groups)}).encode()
    return base64.urlsafe_b64encode(roh).decode().rstrip("=")


class ImAuftragTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        conn = db.connect()
        try:
            conn.execute("INSERT OR REPLACE INTO personen_nummern (nummer, email, name, haus, wohnung, weiterleitung, voicemail) "
                         "VALUES ('300107', 'erika.muster@example.org', 'Erika Müster', 9, '3.2', 'aus', 1)")
            conn.execute("INSERT OR REPLACE INTO personen_nummern (nummer, email, name) VALUES ('300215', 'max@example.org', 'Max Beispiel')")
            conn.execute("INSERT INTO telefon_sip_privat (nummer, email, geraet, passwort) VALUES ('300215', 'max@example.org', 'Galaxy', 'x')")
            conn.commit()
        finally:
            conn.close()

    def setUp(self):
        self.client = pbx.app.test_client()
        self._p = [mock.patch.object(pbx, "PBX_SHARED_SECRET", GEHEIM),
                   mock.patch.object(pbx.ami, "registered_aors", return_value=set())]
        for p in self._p:
            p.start()
        # die Haupt-API darf dabei nie gefragt werden
        self.haupt = mock.patch.object(pbx.requests, "get", side_effect=AssertionError("Haupt-API gefragt"))
        self.haupt.start()

    def tearDown(self):
        self.haupt.stop()
        for p in self._p:
            p.stop()

    def _kopf(self, geheim=GEHEIM, person=None):
        return {"X-PBX-Secret": geheim, "X-Rosenweg-Im-Auftrag": person or _person()}

    def test_mein_telefon_mit_geheimnis_und_person(self):
        r = self.client.get("/api/telefon/ich", headers=self._kopf())
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual(r.get_json()["nummer"], "300107")
        self.assertEqual(r.get_json()["name"], "Erika Müster")

    def test_erreichbarkeit_speichern_fuer_die_person(self):
        r = self.client.put("/api/telefon/ich/erreichbarkeit", headers=self._kopf(),
                            json={"weiterleitung": "immer", "ziel": "079 000 00 01", "voicemail": False})
        self.assertEqual(r.status_code, 200, r.get_json())
        conn = db.connect()
        try:
            p = conn.execute("SELECT weiterleitung, voicemail FROM personen_nummern WHERE nummer = '300107'").fetchone()
            log = conn.execute("SELECT durch FROM telefon_log WHERE ext = '300107' ORDER BY id DESC LIMIT 1").fetchone()
        finally:
            conn.close()
        self.assertEqual((p["weiterleitung"], p["voicemail"]), ("immer", 0))
        self.assertEqual(log["durch"], "selbst")

    def test_falsches_geheimnis_401(self):
        r = self.client.get("/api/telefon/ich", headers=self._kopf(geheim="falsch"))
        self.assertEqual(r.status_code, 401)

    def test_ohne_geheimnis_in_der_anlage_401(self):
        with mock.patch.object(pbx, "PBX_SHARED_SECRET", ""):
            r = self.client.get("/api/telefon/ich", headers=self._kopf(geheim=""))
        self.assertEqual(r.status_code, 401)

    def test_kaputter_kopf_401_und_kein_rueckfall_auf_bearer(self):
        k = self._kopf(person="kein-json")
        k["Authorization"] = "Bearer irgendwas"
        r = self.client.get("/api/telefon/ich", headers=k)
        self.assertEqual(r.status_code, 401)

    def test_nur_die_pfade_von_mein_telefon(self):
        # Technik-Liste aller Handys: weder Pfad freigegeben noch Technik-Recht
        r = self.client.get("/api/pbx/sip-privat", headers=self._kopf())
        self.assertEqual(r.status_code, 401)

    def test_keine_technik_rechte_fremdes_handy_bleibt(self):
        conn = db.connect()
        try:
            zid = conn.execute("SELECT id FROM telefon_sip_privat WHERE email = 'max@example.org'").fetchone()["id"]
        finally:
            conn.close()
        r = self.client.delete(f"/api/telefon/privat/{zid}", headers=self._kopf())
        self.assertEqual(r.status_code, 403, "Technik-Gruppe zaehlt im Auftrag nicht")
        self.assertFalse(pbx.is_admin({"groups": ["Technik"], "im_auftrag": True}))
        self.assertTrue(pbx.is_admin({"groups": ["Technik"]}))

    def test_portal_pfade_fuer_mein_telefon(self):
        regeln = pbx.PORTAL_PFADE_STANDARD
        m = "ch.rosenweg4303.meintelefon"
        self.assertTrue(pbx._portal_erlaubt(regeln, m, "GET", "/api/telefonanlage/ich"))
        self.assertTrue(pbx._portal_erlaubt(regeln, m, "PUT", "/api/telefonanlage/ich/erreichbarkeit"))
        self.assertTrue(pbx._portal_erlaubt(regeln, m, "DELETE", "/api/messenger/zugaenge/12"))
        self.assertTrue(pbx._portal_erlaubt(regeln, m, "GET", "/api/apps/sitzungen"))
        self.assertFalse(pbx._portal_erlaubt(regeln, m, "POST", "/api/messenger/zugaenge"))
        self.assertFalse(pbx._portal_erlaubt(regeln, m, "GET", "/api/karten/personen"))


if __name__ == "__main__":
    unittest.main()
