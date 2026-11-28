"""Karte wie Schluessel auf geteilten Telefonen (Entscheid Stefan 28.11.2026):
Mein Telefon stellt den App-QR aus, Profil aendert Angaben und Bild, Vollmachten
signiert mit Karte oder QR. Passwort, SSH, Tokens bleiben draussen.

Laufen lassen: cd pbx/api && python3 -m unittest test_schluessel_portal -v
"""
import os
import tempfile
import unittest

_tmp = tempfile.mkdtemp()
os.environ["PBX_DB_PATH"] = os.path.join(_tmp, "pbx.sqlite")

import app as pbx  # noqa: E402

R = pbx.PORTAL_PFADE_STANDARD
MT = "ch.rosenweg4303.meintelefon"
PROFIL = "ch.rosenweg4303.profil"
VM = "ch.rosenweg4303.vollmachten"


class SchluesselPortal(unittest.TestCase):
    def test_mein_telefon_app_qr(self):
        self.assertTrue(pbx._portal_erlaubt(R, MT, "POST", "/api/apps/qr-ausweis"))
        self.assertTrue(pbx._portal_erlaubt(R, MT, "GET", "/api/apps/qr-ausweis/qa_abcdefghijklmnop"))
        # nicht fuer andere Apps, nicht der Handy-Code (bleibt beim Konto)
        self.assertFalse(pbx._portal_erlaubt(R, "ch.rosenweg4303.salz", "POST", "/api/apps/qr-ausweis"))
        self.assertFalse(pbx._portal_erlaubt(R, MT, "POST", "/api/apps/handy-code/ABCD-EFGH/bestaetigen"))
        self.assertFalse(pbx._portal_erlaubt(R, MT, "DELETE", "/api/apps/qr-ausweis"))

    def test_profil_angaben_und_bild(self):
        for m, p in [("PUT", "/api/auth/profile"), ("PUT", "/api/auth/avatar"), ("GET", "/api/me/wohnungen"),
                     ("GET", "/api/me/person-data"), ("GET", "/api/auth/me"), ("PUT", "/api/me/phones"),
                     ("PUT", "/api/me/emails"), ("PUT", "/api/me/whatsapp-optin")]:
            self.assertTrue(pbx._portal_erlaubt(R, PROFIL, m, p), (m, p))
        for m, p in [("POST", "/api/change-password"), ("POST", "/api/me/tokens"), ("GET", "/api/me/tokens"),
                     ("POST", "/api/ssh/me/schluessel"), ("GET", "/api/ssh/me"), ("POST", "/api/auth/profile"),
                     ("PUT", "/api/auth/profile/x")]:
            self.assertFalse(pbx._portal_erlaubt(R, PROFIL, m, p), (m, p))

    def test_vollmachten_mit_bestaetigung(self):
        for m, p in [("GET", "/api/vollmachten"), ("POST", "/api/vollmachten"), ("GET", "/api/vollmachten/5"),
                     ("POST", "/api/vollmachten/5/sign-bestaetigung"), ("POST", "/api/vollmachten/5/sign-digital")]:
            self.assertTrue(pbx._portal_erlaubt(R, VM, m, p), (m, p))
        self.assertFalse(pbx._portal_erlaubt(R, VM, "POST", "/api/change-password"))
        self.assertFalse(pbx._portal_erlaubt(R, "ch.rosenweg4303.salz", "POST", "/api/vollmachten/5/sign-digital"))


class KarteImAnlageToken(unittest.TestCase):
    """Die Anzeige-ID der Karte vom Sperrbildschirm geht im Anlage-Token mit (28.11.2026)."""

    def _inhalt(self, sitzung):
        import base64
        import json
        pbx.PORTAL_ANLAGE_SECRET = "test"
        t = pbx._portal_token(sitzung, "2098", MT, "POST", "/api/apps/qr-ausweis")
        teil = t.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(teil + "=" * (-len(teil) % 4)))

    def test_mit_karte(self):
        p = self._inhalt({"user_id": "7", "email": "anna@example.ch", "karte": "0042"})
        self.assertEqual(p["karte"], "0042")
        self.assertEqual(p["pfad"], "apps/qr-ausweis")

    def test_ohne_karte(self):
        self.assertNotIn("karte", self._inhalt({"user_id": "7", "email": "anna@example.ch", "karte": None}))
        self.assertNotIn("karte", self._inhalt({"user_id": "7", "email": "anna@example.ch"}))


if __name__ == "__main__":
    unittest.main()
