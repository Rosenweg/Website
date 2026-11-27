"""Fernwartung ueber den dauerhaften adb-Tunnel (pbx/adb-zentrale), ohne Telefon und ohne Zentrale.

Ablauf wie am A15: Telefon meldet seinen Schluessel -> wartet -> Technik bestaetigt -> bereit
(Peer geht an die Zentrale) -> Sitzung auf/zu im Verlauf -> Not-Aus -> wieder ein.

Laufen lassen: cd pbx/api && python3 -m unittest test_fernwartung -v
"""
import base64
import os
import tempfile
import unittest
from unittest import mock

_tmp = tempfile.mkdtemp()
os.environ["PBX_DB_PATH"] = os.path.join(_tmp, "pbx-fw.sqlite")
os.environ["PBX_ADB_ZENTRALE_URL"] = "http://zentrale.test:8080"
os.environ["PBX_ADB_ZENTRALE_TOKEN"] = "z" * 40
os.environ["PBX_SHARED_SECRET"] = "agi-geheimnis"

import app as pbx  # noqa: E402
import db  # noqa: E402

TECHNIK = {"email": "technik@example.org", "name": "Technik Person", "groups": ["Technik"]}
GERAET = "Basic " + base64.b64encode(b"2002:geheim-2002").decode()
ZENTRALE = {"Authorization": "Bearer " + "z" * 40}
PUB = base64.b64encode(bytes(range(32))).decode()
PUB2 = base64.b64encode(bytes(range(1, 33))).decode()
INFO = {"public_key": base64.b64encode(b"Z" * 32).decode(), "adb_fingerabdruck": "AA:" * 15 + "AA",
        "endpoint_extern": "adb.example:51832", "endpoint_intern": "192.0.2.68:51832"}


class _Antwort:
    def __init__(self, status, daten):
        self.status_code, self.ok, self._d = status, 200 <= status < 300, daten

    def json(self):
        return self._d


class FernwartungTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        conn = db.connect()
        try:
            conn.execute("INSERT INTO sip_extensions (ext, name, secret, context, client) VALUES (?,?,?,?,?)",
                         ("2002", "Rosenweg Smartphone 2", "geheim-2002", "geteilt", "android-sip"))
            conn.commit()
        finally:
            conn.close()

    def setUp(self):
        self.c = pbx.app.test_client()
        self.aufrufe = []
        pbx._FW_MERK["info"] = (0.0, None)
        pbx._FW_MERK["zustand"] = (0.0, None)

        def zentrale(methode, pfad, daten=None, timeout=5):
            self.aufrufe.append((methode, pfad.split("?")[0], daten))
            if pfad == "/gesundheit":
                return INFO
            if pfad == "/zustand":
                return {"peers": [{"ext": "2002", "letzter_handshake": int(pbx.time.time()) - 30, "sitzung": None}]}
            return {"ok": True}
        for p in (mock.patch.object(pbx, "_zentrale", side_effect=zentrale),
                  mock.patch.object(pbx.ami, "originate"),
                  mock.patch.object(pbx.ami, "registered_aors", return_value={"2002"}),
                  mock.patch.object(pbx.adb_updater, "fingerabdruck", return_value="BB:" * 15 + "BB"),
                  mock.patch.object(pbx, "current_user", return_value=TECHNIK)):
            p.start()
            self.addCleanup(p.stop)

    def status(self):
        r = self.c.get("/api/telefon/status", headers={"Authorization": GERAET})
        self.assertEqual(r.status_code, 200, r.get_json())
        return r.get_json()["fernwartung"]

    def schalten(self, aktion):
        r = self.c.post("/api/telefon/2002/fernwartung", json={"aktion": aktion},
                        headers={"Authorization": "Bearer x"})
        self.assertEqual(r.status_code, 200, r.get_json())
        return r.get_json()

    def test_ablauf(self):
        conn = db.connect()
        conn.execute("DELETE FROM telefon_tunnel")
        conn.commit()
        conn.close()
        self.assertEqual(self.status(), {"stand": "neu"})
        r = self.c.post("/api/telefon/tunnel", json={"pubkey": PUB}, headers={"Authorization": GERAET})
        self.assertEqual(r.get_json()["stand"], "wartet")
        # unbestaetigt: nicht in der Peer-Liste der Zentrale
        self.assertEqual(self.c.get("/api/pbx/fernwartung/peers", headers=ZENTRALE).get_json()["peers"], [])
        self.assertEqual(self.c.get("/api/pbx/fernwartung/peers").status_code, 401)

        self.schalten("bestaetigen")
        self.assertIn(("PUT", "/peers", {"peers": [{"ext": "2002", "public_key": PUB, "ip": "10.243.44.2"}]}), self.aufrufe)
        s = self.status()
        self.assertEqual(s["stand"], "bereit")
        self.assertEqual(s["adresse"], "10.243.44.2")
        self.assertEqual(s["gateway"], "10.243.44.1")
        self.assertEqual(s["peer_public"], INFO["public_key"])
        self.assertEqual(s["schluessel"], [INFO["adb_fingerabdruck"], "BB:" * 15 + "BB"])

        # Sitzung im Verlauf
        for art, extra in (("auf", {}), ("zu", {"ende": 2000, "bytes_hin": 10, "bytes_her": 20,
                                                  "befehle": ["shell dumpsys battery"], "grund": "beendet"})):
            r = self.c.post("/api/pbx/fernwartung/sitzung", headers=ZENTRALE,
                            json={"art": art, "ext": "2002", "person": "stefan", "zweck": "shell", "beginn": 1000, **extra})
            self.assertEqual(r.status_code, 200)
        sp = self.c.get("/api/pbx/smartphones", headers={"Authorization": "Bearer x"}).get_json()
        v = sp["fernwartung_verlauf"][0]
        self.assertEqual((v["person"], v["ende"], v["befehle"]), ("stefan", 2000, ["shell dumpsys battery"]))
        self.assertEqual(sp["telefone"][0]["fernwartung"]["ampel"], "gruen")
        self.assertTrue(sp["fernwartung_zentrale"]["erreichbar"])

        # anderer Schluessel: wieder unbestaetigt, alter Peer geht aus der Zentrale
        r = self.c.post("/api/telefon/tunnel", json={"pubkey": PUB2}, headers={"Authorization": GERAET})
        self.assertEqual(r.get_json()["stand"], "wartet")
        self.assertIn(("PUT", "/peers", {"peers": []}), self.aufrufe)
        self.schalten("bestaetigen")

        # Not-Aus: Zentrale sofort, Weckanruf, Status "aus"
        self.aufrufe.clear()
        self.schalten("aus")
        self.assertIn(("DELETE", "/peers/2002", None), self.aufrufe)
        pbx.ami.originate.assert_called()
        self.assertEqual(self.status(), {"stand": "aus"})
        noc = self.c.get("/api/pbx/fernwartung/noc", headers={"X-PBX-Secret": "agi-geheimnis"}).get_json()
        self.assertEqual(noc["telefone"][0]["ampel"], "rot")
        self.assertNotIn("person", str(noc))
        self.schalten("ein")
        self.assertEqual(self.status()["stand"], "bereit")

    def test_alle_aus_und_fremd(self):
        r = self.c.post("/api/pbx/fernwartung/alle-aus", headers={"Authorization": "Bearer x"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.status(), {"stand": "aus"})
        # Telefon meldet danach erst seinen Schluessel: bleibt aus
        r = self.c.post("/api/telefon/tunnel", json={"pubkey": PUB}, headers={"Authorization": GERAET})
        self.assertEqual(r.get_json(), {"stand": "aus"})
        self.schalten("ein")
        fp = "CC:" * 15 + "CC"
        for _ in range(2):   # zweite Meldung binnen 10 Min. zaehlt nicht doppelt
            r = self.c.post("/api/telefon/fernwartung/meldung", headers={"Authorization": GERAET},
                            json={"art": "fremder_schluessel", "fingerabdruck": fp, "abgelehnt": True})
            self.assertEqual(r.status_code, 200)
        conn = db.connect()
        n = conn.execute("SELECT COUNT(*) FROM telefon_adb_fremd WHERE fingerabdruck = ?", (fp,)).fetchone()[0]
        conn.close()
        self.assertEqual(n, 1)
        noc = self.c.get("/api/pbx/fernwartung/noc", headers={"X-PBX-Secret": "agi-geheimnis"}).get_json()
        self.assertTrue(noc["telefone"][0]["fremd"])
        self.assertEqual(noc["telefone"][0]["ampel"], "rot")

    def test_ungueltig(self):
        r = self.c.post("/api/telefon/tunnel", json={"pubkey": "kurz"}, headers={"Authorization": GERAET})
        self.assertEqual(r.status_code, 400)
        r = self.c.post("/api/telefon/tunnel", json={"pubkey": PUB})
        self.assertEqual(r.status_code, 401)
        r = self.c.post("/api/pbx/fernwartung/sitzung", headers={"Authorization": "Bearer falsch" + "z" * 40},
                        json={"art": "auf", "ext": "2002"})
        self.assertEqual(r.status_code, 401)


if __name__ == "__main__":
    unittest.main()
