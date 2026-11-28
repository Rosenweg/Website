"""python3 -m unittest nextcloud/nc-token/test_nc_token.py — /konto-loeschen (Konto-Loeschung).
occ ist eine Attrappe; es wird nichts auf einer echten Nextcloud geloescht."""
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nc_token  # noqa: E402

KONTEN = {
    "anna": {"email": "Anna@Example.org", "enabled": True},
    "anna-alt": {"email": "anna@example.org", "enabled": False},
    "bert": {"email": "bert@example.org", "enabled": True},
    "chef": {"email": "chef@example.org", "enabled": True},
}


class KontoLoeschenTest(unittest.TestCase):
    def setUp(self):
        self.aufrufe = []

        def occ(*args):
            self.aufrufe.append(args)
            if args[0] == "user:list":
                return json.dumps(KONTEN)
            if args[0] == "user:info":
                return json.dumps({"groups": ["admin"] if args[1] == "chef" else ["stweg3"]})
            if args[0] == "user:delete":
                return "User deleted."
            raise AssertionError(args)

        p = mock.patch.object(nc_token, "occ", side_effect=occ)
        p.start()
        self.addCleanup(p.stop)

    def geloescht(self):
        return [a[1] for a in self.aufrufe if a[0] == "user:delete"]

    def test_alle_konten_der_adresse_auch_deaktivierte(self):
        status, d = nc_token.konto_loeschen(" ANNA@example.org ")
        self.assertEqual(status, 200)
        self.assertEqual(d["geloescht"], ["anna", "anna-alt"])
        self.assertEqual(self.geloescht(), ["anna", "anna-alt"])

    def test_kein_konto(self):
        self.assertEqual(nc_token.konto_loeschen("niemand@example.org")[0], 404)
        self.assertEqual(self.geloescht(), [])

    def test_nie_ein_admin(self):
        status, _ = nc_token.konto_loeschen("chef@example.org")
        self.assertEqual(status, 409)
        self.assertEqual(self.geloescht(), [])


if __name__ == "__main__":
    unittest.main()
