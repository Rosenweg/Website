"""Kartenverwaltung ohne Rosenweg Geraet (Rosenweg Karten auf dem eigenen Handy).

Regression 27.11.2026: Werkzeug liest auch "Authorization: Bearer ..." in
request.authorization. _karten_verwalter() pruefte "not request.authorization" und
schickte so jede App mit Bearer-Token zu _geraet() -> 401 "Geraet nicht berechtigt",
Rosenweg Karten 1.6.2 meldete ab und zeigte den Anmeldeschirm (Schleife).

Laufen lassen: cd pbx/api && python3 -m unittest test_karten_verwalter -v
"""
import base64
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


def _haupt_api(user):
    """Ersatz fuer requests.get an MAIN_API_BASE/api/auth/me."""
    def get(url, headers=None, timeout=None):
        if not url.endswith("/api/auth/me"):
            raise AssertionError("unerwarteter Aufruf: " + url)
        if user is None:
            return _Antwort(401, {"error": "Anmeldung abgelaufen"})
        return _Antwort(200, {"user": user})
    return get


STEFAN = {"email": "technik@example.org", "name": "Technik Person", "groups": ["Technik", "Bewohner"]}
BEWOHNER = {"email": "bewohner@example.org", "name": "Bewohner Person", "groups": ["Bewohner"]}


class KartenVerwalterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        conn = db.connect()
        try:
            conn.execute("INSERT INTO personen_nummern (nummer, email, name, aktiv) VALUES (?,?,?,1)",
                         ("301011", "a@example.org", "Anna Beispiel"))
            conn.commit()
        finally:
            conn.close()

    def setUp(self):
        self.client = pbx.app.test_client()

    def _personen(self, auth, user):
        with mock.patch.object(pbx.requests, "get", side_effect=_haupt_api(user)):
            return self.client.get("/api/telefon/karten/personen", headers={"Authorization": auth})

    def test_karten_sitzung_technik_darf(self):
        r = self._personen("Bearer rw_app_" + "x" * 43, STEFAN)
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual([p["email"] for p in r.get_json()["personen"]], ["a@example.org"])

    def test_authentik_token_technik_darf(self):
        r = self._personen("Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln", STEFAN)
        self.assertEqual(r.status_code, 200, r.get_json())

    def test_ohne_technik_403(self):
        r = self._personen("Bearer rw_app_" + "y" * 43, BEWOHNER)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.get_json()["error"], "nicht berechtigt")

    def test_ungueltiger_bearer_401_ohne_geraet(self):
        # Kein Umweg ueber HTTP-Basic: die Meldung muss die Rosenweg-Anmeldung nennen
        r = self._personen("Bearer rw_app_" + "z" * 43, None)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.get_json()["error"], "Rosenweg-Anmeldung ungueltig")

    def test_geraet_mit_basic_bleibt_beim_geraet(self):
        basic = "Basic " + base64.b64encode(b"2099:falsch").decode()
        r = self._personen(basic, STEFAN)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.get_json()["error"], "Geraet nicht berechtigt")


if __name__ == "__main__":
    unittest.main()
