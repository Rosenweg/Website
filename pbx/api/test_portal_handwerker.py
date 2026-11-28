"""Rosenweg Handwerker auf geteilten Telefonen: wie am eigenen Geraet (Linie 28.11.2026,
ersetzt "nur Notfall-Ansicht"); die Haupt-API prueft die Rechte. Die Sperren gelten weiter.

Laufen lassen: cd pbx/api && python3 -m unittest test_portal_handwerker -v
"""
import os
import tempfile
import unittest

os.environ["PBX_DB_PATH"] = os.path.join(tempfile.mkdtemp(), "pbx.sqlite")

import app as pbx  # noqa: E402

H = "ch.rosenweg4303.handwerker"


class PortalHandwerkerTest(unittest.TestCase):
    def test_notfall_ansicht_und_liste(self):
        r = pbx.PORTAL_PFADE_STANDARD
        self.assertTrue(pbx._portal_erlaubt(r, H, "GET", "/api/handwerker-notfall/bewohner"))
        self.assertTrue(pbx._portal_erlaubt(r, H, "GET", "/api/handwerker-notfall/bewohner?stweg=3"))
        self.assertTrue(pbx._portal_erlaubt(r, H, "GET", "/api/handwerker"))
        self.assertTrue(pbx._portal_erlaubt(r, H, "GET", "/api/auth/me"))

    def test_sperren_bleiben(self):
        r = pbx.PORTAL_PFADE_STANDARD
        for methode, pfad in [("POST", "/api/change-password"), ("GET", "/api/me/tokens"), ("POST", "/api/auth/login")]:
            self.assertFalse(pbx._portal_erlaubt(r, H, methode, pfad), f"{methode} {pfad}")


if __name__ == "__main__":
    unittest.main()
