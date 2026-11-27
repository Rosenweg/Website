"""python3 -m unittest discover -s contacts-sync — Verzeichnis ohne echte Nummern (erfundene Beispiele)."""
import importlib.util
import os
import unittest

_pfad = os.path.join(os.path.dirname(__file__), "contacts-sync.py")
_spec = importlib.util.spec_from_file_location("contacts_sync", _pfad)
cs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cs)

PERSONEN = [
    {"name": "Anna Beispiel", "email": "familie@example.org", "emails": [], "adresse": "Musterweg 1",
     "tel": "+41 61 000 00 09", "mobile": "+41 79 000 00 09", "telefone": [{"nummer": "+41 61 000 00 08"}]},
    {"name": "Bruno Beispiel", "email": "familie@example.org", "emails": [], "adresse": None},
    {"name": "Clara Ohnenummer", "email": "clara@example.org", "emails": [], "adresse": None},
    {"name": "Dora Nichts", "email": None, "emails": [], "adresse": None},
]
INTERNE = [
    {"nummer": "309011", "email": "familie@example.org", "name": "Anna Beispiel"},
    {"nummer": "309012", "email": "Familie@Example.org", "name": "Beispiel Bruno"},
]
VERW = [{"firma": "Muster Verwaltungen AG", "tel": "+41 61 000 00 00", "email": "info@example.com"}]
VKONT = [{"firma": "Muster Verwaltungen AG", "name": "Eva Sachbearbeiterin", "funktion": "Bewirtschaftung",
          "email": "eva@example.com", "tel": "+41 61 000 00 01"}]


class Verzeichnis(unittest.TestCase):
    def setUp(self):
        self.d = cs.verzeichnis(PERSONEN, VERW, VKONT, INTERNE)
        self.karte = lambda name: next(v for v in self.d.values() if "FN:" + name + "\r\n" in v)

    def test_person_nur_interne_nummer(self):
        k = self.karte("Anna Beispiel")
        self.assertIn("item1.TEL;TYPE=VOICE:309011", k)
        self.assertIn("item1.X-ABLabel:Rosenweg intern", k)
        self.assertNotIn("309012", k)          # Partnerin mit derselben E-Mail: eigene Nummer
        self.assertIn("CATEGORIES:Rosenweg,Bewohner", k)

    def test_paar_mit_gleicher_mail_bekommt_je_eigene_nummer(self):
        self.assertIn("309012", self.karte("Bruno Beispiel"))

    def test_ohne_interne_nummer_keine_telefonnummer(self):
        k = self.karte("Clara Ohnenummer")
        self.assertNotIn("TEL", k)
        self.assertIn("EMAIL;TYPE=INTERNET:clara@example.org", k)

    def test_ohne_nummer_und_mail_keine_karte(self):
        self.assertFalse(any("Dora Nichts" in v for v in self.d.values()))

    def test_keine_echte_nummer_bei_personen(self):
        for v in self.d.values():
            if "Bewohner" in v:
                tels = [z for z in v.split("\r\n") if ".TEL" in z or z.startswith("TEL")]
                for z in tels:
                    self.assertRegex(z.split(":", 1)[1], r"^3\d{5}$")

    def test_verwaltung_behaelt_geschaeftsnummern(self):
        self.assertIn("+41 61 000 00 01", self.karte("Eva Sachbearbeiterin"))
        self.assertIn("+41 61 000 00 00", self.karte("Muster Verwaltungen AG"))


class PraesidentVoll(unittest.TestCase):
    def test_volle_fassung_mit_echten_und_internen(self):
        d = cs.verzeichnis(PERSONEN, VERW, VKONT, INTERNE, echte=True)
        k = next(v for v in d.values() if "FN:Anna Beispiel\r\n" in v)
        self.assertIn("309011", k)
        self.assertIn("TEL;TYPE=CELL:+41 79 000 00 09", k)
        self.assertIn("+41 61 000 00 08", k)

    def test_geteilte_fassung_ohne_echte(self):
        d = cs.verzeichnis(PERSONEN, VERW, VKONT, INTERNE)
        self.assertFalse(any("000 00 09" in v or "000 00 08" in v for v in d.values()))


class GleichePerson(unittest.TestCase):
    def test_reihenfolge_und_zweitname(self):
        self.assertTrue(cs.gleiche_person("Anna Beispiel", "Beispiel Anna"))
        self.assertTrue(cs.gleiche_person("Anna Beispiel", "Anna Maria Beispiel"))
        self.assertFalse(cs.gleiche_person("Anna Beispiel", "Bruno Beispiel"))
        self.assertFalse(cs.gleiche_person("Anna Beispiel AG", "Anna Beispiel"))


if __name__ == "__main__":
    unittest.main()
