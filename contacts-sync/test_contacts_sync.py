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


class SammlungenJeStweg(unittest.TestCase):
    """F1-7: Z-Push bekommt je STWEG eine Sammlung; das Backend setzt je Konto zusammen."""

    def setUp(self):
        personen = [dict(p) for p in PERSONEN]
        personen[0]["stwegs"] = [3]
        personen[1]["stwegs"] = [3, 5]
        personen[2]["stwegs"] = []          # kein aktiver Wohnungskontakt
        self.s = cs.sammlungen(personen, VERW, VKONT, INTERNE)
        self.namen = lambda sammlung: {v.split("FN:", 1)[1].split("\r\n", 1)[0] for v in self.s[sammlung].values()}

    def test_sammlungen_vorhanden(self):
        self.assertEqual(set(self.s), {"alle", "keine"} | {"s%d" % n for n in range(1, 9)})

    def test_alle_wie_bisher(self):
        self.assertEqual(self.s["alle"], cs.verzeichnis(PERSONEN, VERW, VKONT, INTERNE))

    def test_keine_nur_verwaltung_und_zentrale(self):
        self.assertEqual(self.namen("keine"), {"Rosenweg", "Muster Verwaltungen AG", "Eva Sachbearbeiterin"})

    def test_je_stweg_nur_eigene_personen(self):
        self.assertEqual(self.namen("s3"), {"Anna Beispiel", "Bruno Beispiel"})
        self.assertEqual(self.namen("s5"), {"Bruno Beispiel"})
        self.assertEqual(self.s["s1"], {})
        for n in range(1, 9):
            self.assertNotIn("Clara Ohnenummer", self.namen("s%d" % n))
            self.assertNotIn("rosenweg-pbx", self.s["s%d" % n])

    def test_stand_aendert_sich_mit_inhalt(self):
        a = cs.stand(self.s)
        b = dict(self.s); b["s3"] = {}
        self.assertNotEqual(a, cs.stand(b))
        self.assertEqual(a, cs.stand(dict(self.s)))


if __name__ == "__main__":
    unittest.main()
