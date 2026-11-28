"""Rosenweg Handwerker auf geteilten Telefonen: nur die Notfall-Ansicht fuer Bewohner
(Entscheid Stefan 28.11.2026). Liste, Vertraege, Einsaetze, Kosten und Schreiben gehen dort nicht.

Laufen lassen: cd pbx/api && python3 -m unittest test_portal_handwerker -v
"""
import os
import tempfile
import unittest

os.environ["PBX_DB_PATH"] = os.path.join(tempfile.mkdtemp(), "pbx.sqlite")

import app as pbx  # noqa: E402

H = "ch.rosenweg4303.handwerker"


class PortalHandwerkerTest(unittest.TestCase):
    def test_nur_die_notfall_ansicht(self):
        r = pbx.PORTAL_PFADE_STANDARD
        self.assertTrue(pbx._portal_erlaubt(r, H, "GET", "/api/handwerker-notfall/bewohner"))
        self.assertTrue(pbx._portal_erlaubt(r, H, "GET", "/api/handwerker-notfall/bewohner?stweg=3"))
        self.assertTrue(pbx._portal_erlaubt(r, H, "GET", "/api/auth/me"))

    def test_nichts_sonst(self):
        r = pbx.PORTAL_PFADE_STANDARD
        for methode, pfad in [
            ("GET", "/api/handwerker"),
            ("GET", "/api/handwerker-notfall"),          # Verwaltungsroute mit Mitarbeitern und Handys
            ("GET", "/api/handwerker/7/vertraege"),
            ("GET", "/api/handwerker/7/auftraege"),
            ("GET", "/api/handwerker-export"),
            ("POST", "/api/handwerker"),
            ("PUT", "/api/handwerker/7"),
            ("DELETE", "/api/handwerker/7"),
            ("POST", "/api/handwerker-notfall/bewohner"),
        ]:
            self.assertFalse(pbx._portal_erlaubt(r, H, methode, pfad), f"{methode} {pfad}")

    def test_andere_apps_bekommen_es_nicht(self):
        self.assertFalse(pbx._portal_erlaubt(pbx.PORTAL_PFADE_STANDARD, "ch.rosenweg4303.salz", "GET", "/api/handwerker-notfall/bewohner"))


if __name__ == "__main__":
    unittest.main()
