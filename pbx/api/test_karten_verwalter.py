"""Kartenverwaltung: Umzug in die Haupt-API (Entscheid Stefan 27.11.2026).

Die alten Pfade /api/telefon/karten/* der Anlage reichen nur noch an /api/karten/*
der Haupt-API weiter (Rosenweg Karten 1.6.3 und Rosenweg Geraet rufen sie noch):
  - Bearer (App auf dem eigenen Handy): Kopf unveraendert weiter, die Haupt-API prueft.
    Regression 27.11.2026 bleibt abgedeckt: ein Bearer geht nie zu _geraet() (401
    "Geraet nicht berechtigt", Anmeldeschleife in Rosenweg Karten 1.6.2).
  - HTTP-Basic (geteiltes Telefon): Anlage-Token fuer genau diese Anfrage.
Dazu die einmalige Uebernahme des Kartenprotokolls aus telefon_log.

Laufen lassen: cd pbx/api && python3 -m unittest test_karten_verwalter -v
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


class _Antwort:
    def __init__(self, status, daten):
        self.status_code = status
        self.ok = 200 <= status < 300
        self._daten = daten

    def json(self):
        return self._daten


def _b64json(teil):
    return json.loads(base64.urlsafe_b64decode(teil + "=" * (-len(teil) % 4)))


class KartenUmzugTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        conn = db.connect()
        try:
            conn.execute("INSERT OR REPLACE INTO sip_extensions (ext, name, secret, context) VALUES ('2099', 'Test', 'geheim', 'geteilt')")
            conn.execute("INSERT OR REPLACE INTO sip_extensions (ext, name, secret, context) VALUES ('2091', 'Leer', 'geheim2', 'geteilt')")
            conn.execute("INSERT OR REPLACE INTO telefon_sitzungen (ext, user_id, email, name) VALUES "
                         "('2099', '7', 'technik@example.org', 'Erika Muster')")
            conn.commit()
        finally:
            conn.close()

    def setUp(self):
        self.client = pbx.app.test_client()
        self.aufrufe = []

    def _haupt(self, status=200, daten=None):
        def request(methode, url, headers=None, json=None, timeout=None, allow_redirects=True):
            self.aufrufe.append({"methode": methode, "url": url, "kopf": dict(headers or {}), "json": json})
            return _Antwort(status, daten if daten is not None else {"ok": True})
        return mock.patch.object(pbx.requests, "request", side_effect=request)

    def test_bearer_geht_unveraendert_an_die_haupt_api(self):
        with self._haupt(daten={"personen": [{"name": "Anna Beispiel", "email": "a@example.org"}]}):
            r = self.client.get("/api/telefon/karten/personen", headers={"Authorization": "Bearer rw_app_" + "x" * 43})
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual(r.get_json()["personen"][0]["email"], "a@example.org")
        a = self.aufrufe[0]
        self.assertEqual((a["methode"], a["url"]), ("GET", pbx.MAIN_API_BASE + "/api/karten/personen"))
        self.assertEqual(a["kopf"]["Authorization"], "Bearer rw_app_" + "x" * 43)
        self.assertEqual(r.headers.get("Deprecation"), "true")
        self.assertIn("/api/karten/personen", r.headers.get("Link", ""))

    def test_status_und_fehler_der_haupt_api_kommen_durch(self):
        with self._haupt(403, {"error": "Nur für Technik oder Präsident"}):
            r = self.client.post("/api/telefon/karten/info", json={"uid": "04D4C227C22A81"},
                                 headers={"Authorization": "Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.get_json()["error"], "Nur für Technik oder Präsident")

    def test_nur_uid_und_email_gehen_weiter(self):
        with self._haupt():
            self.client.post("/api/telefon/karten/zuordnen", headers={"Authorization": "Bearer rw_app_" + "y" * 43},
                             json={"uid": "04D4C227C22A81", "email": "a@example.org", "durch": "gefaelscht"})
        self.assertEqual(self.aufrufe[0]["json"], {"uid": "04D4C227C22A81", "email": "a@example.org"})
        self.assertTrue(self.aufrufe[0]["url"].endswith("/api/karten/zuordnen"))

    def test_geraet_bekommt_anlage_token_fuer_genau_diese_anfrage(self):
        basic = "Basic " + base64.b64encode(b"2099:geheim").decode()
        with mock.patch.object(pbx, "PORTAL_ANLAGE_SECRET", "test-geheimnis"), self._haupt():
            r = self.client.post("/api/telefon/karten/entziehen", json={"uid": "04D4C227C22A81"},
                                 headers={"Authorization": basic})
        self.assertEqual(r.status_code, 200, r.get_json())
        a = self.aufrufe[0]
        self.assertTrue(a["url"].endswith("/api/karten/entziehen"))
        token = a["kopf"]["Authorization"][7:]
        inhalt = _b64json(token.split(".")[1])
        self.assertEqual(inhalt["iss"], "rosenweg-anlage")
        self.assertEqual(inhalt["aud"], "rosenweg-portal")
        self.assertEqual(inhalt["email"], "technik@example.org")
        self.assertEqual(inhalt["ext"], "2099")
        self.assertEqual((inhalt["methode"], inhalt["pfad"]), ("POST", "karten/entziehen"))
        self.assertEqual(inhalt["paket"], "ch.rosenweg4303.karten")
        self.assertLessEqual(inhalt["exp"] - inhalt["iat"], 120)

    def test_geraet_ohne_angemeldete_person_403(self):
        basic = "Basic " + base64.b64encode(b"2091:geheim2").decode()
        with mock.patch.object(pbx, "PORTAL_ANLAGE_SECRET", "test-geheimnis"), self._haupt():
            r = self.client.get("/api/telefon/karten/personen", headers={"Authorization": basic})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.aufrufe, [])

    def test_geraet_mit_falschem_basic_401(self):
        basic = "Basic " + base64.b64encode(b"2099:falsch").decode()
        with self._haupt():
            r = self.client.get("/api/telefon/karten/personen", headers={"Authorization": basic})
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.get_json()["error"], "Geraet nicht berechtigt")
        self.assertEqual(self.aufrufe, [])

    def test_haupt_api_nicht_erreichbar_502(self):
        def kaputt(*a, **k):
            raise pbx.requests.ConnectionError("weg")
        with mock.patch.object(pbx.requests, "request", side_effect=kaputt):
            r = self.client.get("/api/telefon/karten/personen", headers={"Authorization": "Bearer rw_app_" + "z" * 43})
        self.assertEqual(r.status_code, 502)

    def test_zutritt_darf_auf_geteilten_telefonen_karten_und_access(self):
        regeln = pbx.PORTAL_PFADE_STANDARD
        z = "ch.rosenweg4303.zutritt"
        self.assertTrue(pbx._portal_erlaubt(regeln, z, "POST", "/api/karten/info"))
        self.assertTrue(pbx._portal_erlaubt(regeln, z, "GET", "/api/access/users"))
        self.assertTrue(pbx._portal_erlaubt(regeln, z, "GET", "/api/apps/sitzungen?alle=1"))
        self.assertTrue(pbx._portal_erlaubt(regeln, z, "DELETE", "/api/apps/sitzungen/abc"))
        self.assertFalse(pbx._portal_erlaubt(regeln, z, "PUT", "/api/permissions"))
        self.assertFalse(pbx._portal_erlaubt(regeln, "ch.rosenweg4303.salz", "POST", "/api/karten/info"))


class KartenProtokollUebernahmeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        conn = db.connect()
        try:
            for ext, ereignis, durch in [
                ("2099", "an", "karte:0042"),                       # Anmeldung: bleibt in der Anlage
                ("2099", "karte-info", "karte:0042"),
                ("App", "karte-zu", "karte:0042->a@example.org"),
                ("2099", "karte-weg", "karte:0042:404"),
                ("2099", "karte-abgelehnt", "karte:0042:gesperrt"),  # Anmeldung abgelehnt: bleibt
                ("2099", "karte-geloescht", "karte:0043"),
            ]:
                conn.execute("INSERT INTO telefon_log (ext, ereignis, email, name, durch) VALUES (?,?,?,?,?)",
                             (ext, ereignis, "technik@example.org", "Erika Muster", durch))
            conn.commit()
        finally:
            conn.close()

    def test_1_nur_kartenaktionen_einmal_und_mit_marke(self):
        gesendet = []

        def post(url, json=None, headers=None, timeout=None):
            self.assertTrue(url.endswith("/api/pbx/karten-protokoll/uebernahme"))
            self.assertIn("X-PBX-Secret", headers)
            gesendet.append([z["ereignis"] for z in json["zeilen"]])
            return _Antwort(200, {"ok": True, "uebernommen": len(json["zeilen"])})

        g = pbx.karten_protokoll_uebernehmen(post=post, stapel=2)
        self.assertEqual(sum(gesendet, []), ["karte-info", "karte-zu", "karte-weg", "karte-geloescht"])
        self.assertEqual(g["gelesen"], 4)
        # zweiter Lauf: nichts Neues
        gesendet.clear()
        g2 = pbx.karten_protokoll_uebernehmen(post=post)
        self.assertEqual(gesendet, [])
        self.assertEqual(g2["gelesen"], 0)

    def test_2_fehler_der_haupt_api_bricht_ab_ohne_marke(self):
        conn = db.connect()
        try:
            vorher = pbx._cfg(conn).get("karten_protokoll_bis")
            conn.execute("INSERT INTO telefon_log (ext, ereignis, email, name, durch) VALUES "
                         "('2099','karte-info','t@example.org','T','karte:0099')")
            conn.commit()
        finally:
            conn.close()
        with self.assertRaises(RuntimeError):
            pbx.karten_protokoll_uebernehmen(post=lambda *a, **k: _Antwort(500, {}))
        conn = db.connect()
        try:
            self.assertEqual(pbx._cfg(conn).get("karten_protokoll_bis"), vorher)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
