#!/usr/bin/env python3
"""
adb-Updater der geteilten Telefone (Stefan 26.11.2026: "das zentrale System verbindet sich per
adb mit den geteilten Telefonen und spielt neue App-Versionen selbst ein").

Laeuft auf CT 220 neben der PBX-API (systemd: pbx-adb-updater.timer alle 15 Min. und
pbx-adb-updater.path fuer "Jetzt" / neue Freigaben). Benutzt, was es schon gibt:
  - App-Katalog telefon_apps + Dateien unter PBX_TELEFON_APPS_DIR (Quelle aller Fassungen,
    gefuellt von POST /api/apps/release),
  - zentrale Wartung telefon_wartung + Weckanruf 2098 (schaltet adb auf dem Telefon ein),
  - die Meldung von Rosenweg Geraet (telefon_adb: Adresse, Port 5555),
  - die geschuetzten Broadcasts ADB_INSTALLATION (Installationsverbot 10 Min. aufheben) und
    ab Geraet v237 ADB_INSTALLATION_ENDE (Verbot sofort wieder setzen).

Regeln (siehe pbx/GETEILTE-TELEFONE.md, "Apps per adb aktualisieren"):
  - nur wenn niemand angemeldet ist, die letzte Abmeldung >= RUHE_MIN her ist, kein Gespraech
    auf der Nebenstelle laeuft und der Bildschirm aus ist; Akku >= AKKU_MIN oder am Strom,
  - Rosenweg Geraet selbst (Kiosk/Anmeldung) nur nachts (PBX_ADB_NACHT, Standard 01-05 Uhr),
  - nur neuere Fassungen bereits installierter Katalog-Apps (kein Downgrade, keine
    Erstinstallation - die macht Geraet selbst, inkl. Ausblenden),
  - jede APK vor dem Einspielen pruefen: SHA-256 wie im Katalog, Rosenweg-Zertifikat, Paket und
    versionCode aus dem Manifest (mit apksigner, wenn vorhanden, auch kryptografisch),
  - nur Adressen aus PBX_ADB_NETZE (Standard RK-Clients 100.64.9.0/24), Seriennummer muss zur
    Nebenstelle passen, nie neu starten, nie etwas anderes als install/am broadcast/getprop/dumpsys.

Der adb-Schluessel liegt nur auf CT 220 unter PBX_ADB_HOME/.android/adbkey (nie im Repo).
Er wird pro Telefon einmal zugelassen: /smartphones "Updater zulassen" -> Geraet bestaetigt die
Rueckfrage "USB-Debugging zulassen?" nur fuer genau diesen Fingerabdruck (ab Geraet v237).

Aufruf: adb_updater.py [--ext 2102] [--trocken]
  --trocken: nichts einschalten, nichts installieren - nur zeigen, was er tun wuerde.
"""
import argparse
import base64
import fcntl
import hashlib
import hmac
import ipaddress
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ami  # noqa: E402
import apk  # noqa: E402
import db  # noqa: E402

DURCH = "App-Updater"
ADB = os.environ.get("PBX_ADB_BIN", "adb")
ADB_HOME = os.environ.get("PBX_ADB_HOME", "/var/lib/pbx-adb")
ADB_PORT_SERVER = os.environ.get("PBX_ADB_SERVER_PORT", "5039")   # eigener adb-Server, nicht 5037
NETZE = [ipaddress.ip_network(n.strip()) for n in os.environ.get("PBX_ADB_NETZE", "100.64.9.0/24").split(",")
         if n.strip()]
APPS_DIR = os.environ.get("PBX_TELEFON_APPS_DIR", "/var/lib/pbx-api/apps")
NACHT = os.environ.get("PBX_ADB_NACHT", "01-05")
RUHE_MIN = int(os.environ.get("PBX_ADB_RUHE_MIN", "10"))
AKKU_MIN = int(os.environ.get("PBX_ADB_AKKU_MIN", "30"))
WARTUNG_MIN = 15            # so lange schaltet der Updater adb ein (danach sofort wieder aus)
WIEDERHOLEN_S = 3600        # nach einem Fehlversuch fruehestens wieder
FREIGABE_S = 300            # Fenster fuer "Updater zulassen"
GERAET = "ch.rosenweg4303.telefon"
EMPFAENGER = f"{GERAET}/org.sipdroid.sipua.rosenweg.AdbFreigabe"
GERAET_ENDE_AB = 237        # ab dieser Fassung kennt Geraet ADB_INSTALLATION_ENDE
ANSTOSS = os.path.join(ADB_HOME, "anstoss")
TZ = ZoneInfo("Europe/Zurich")


# ─── gemeinsam mit der PBX-API (Anzeige auf /smartphones) ─────────────────────

def fingerabdruck():
    """Fingerabdruck des Updater-Schluessels wie in "USB-Debugging zulassen?" (MD5, XX:XX:..),
    "" wenn es (noch) keinen gibt. Liest nur den oeffentlichen Teil."""
    try:
        with open(os.path.join(ADB_HOME, ".android", "adbkey.pub")) as f:
            roh = base64.b64decode(f.read().split()[0])
    except (OSError, ValueError, IndexError):
        return ""
    return ":".join(f"{b:02X}" for b in hashlib.md5(roh).digest())  # noqa: S324 - so zeigt es Android


def anstossen():
    """systemd-Path-Unit startet den Updater sofort (statt beim naechsten Timer)."""
    try:
        os.makedirs(ADB_HOME, exist_ok=True)
        with open(ANSTOSS, "w") as f:
            f.write(str(int(time.time())))
        return True
    except OSError:
        return False


def zeile(conn, ext):
    conn.execute("INSERT OR IGNORE INTO telefon_updater (ext) VALUES (?)", (ext,))
    return conn.execute("SELECT * FROM telefon_updater WHERE ext = ?", (ext,)).fetchone()


def ausstehend(conn, ext):
    """Katalog-Apps, die auf dem Telefon in aelterer Fassung liegen (Stand der letzten Pruefung)."""
    return [dict(r) for r in conn.execute(
        "SELECT a.paket, a.name, i.version_code AS ist, a.version_code AS soll, a.version_name "
        "FROM telefon_apps a JOIN telefon_apps_ist i ON i.paket = a.paket AND i.ext = ? "
        "WHERE a.art = 'apk' AND a.aktiv = 1 AND a.apk_datei IS NOT NULL AND a.version_code IS NOT NULL "
        "AND i.version_code IS NOT NULL AND a.version_code > i.version_code "
        "ORDER BY a.paket = ?, a.reihenfolge, a.name", (ext, GERAET))]


def hindernis(conn, ext):
    """Warum gerade nicht installiert wird (Text) oder None. Im Zweifel: warten."""
    if conn.execute("SELECT 1 FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone():
        return "jemand ist angemeldet"
    ab = conn.execute("SELECT 1 FROM telefon_log WHERE ext = ? AND ereignis = 'ab' "
                      "AND zeit > datetime('now', ?)", (ext, f"-{RUHE_MIN} minutes")).fetchone()
    if ab:
        return f"vor weniger als {RUHE_MIN} Min. abgemeldet"
    try:
        kanaele = ami.command("core show channels concise")
    except Exception:  # noqa: BLE001
        return "Anlage nicht erreichbar (Gespraeche unbekannt)"
    if any(z.startswith(f"PJSIP/{ext}-") for z in kanaele.splitlines()):
        return "Gespraech laeuft"
    return None


# ─── adb ──────────────────────────────────────────────────────────────────────

def _env():
    e = dict(os.environ)
    e["HOME"] = ADB_HOME
    e["ANDROID_ADB_SERVER_PORT"] = ADB_PORT_SERVER
    e.pop("ADB_VENDOR_KEYS", None)
    return e


def adb(*args, ziel=None, timeout=30):
    cmd = [ADB] + (["-s", ziel] if ziel else []) + list(args)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=_env())
    return r.returncode, (r.stdout + r.stderr).strip()


def shell(ziel, befehl, timeout=30):
    return adb("shell", befehl, ziel=ziel, timeout=timeout)


def zustand(ziel):
    _, aus = adb("devices")
    for z in aus.splitlines()[1:]:
        teile = z.split()
        if len(teile) >= 2 and teile[0] == ziel:
            return teile[1]   # device | unauthorized | offline
    return ""


def versionen(ziel):
    rc, aus = shell(ziel, "cmd package list packages --show-versioncode")
    if rc != 0:
        raise RuntimeError("Paketliste nicht lesbar")
    out = {}
    for z in aus.splitlines():
        # package:ch.rosenweg4303.phone versionCode:41
        if z.startswith("package:") and " versionCode:" in z:
            p, v = z[len("package:"):].split(" versionCode:", 1)
            try:
                out[p.strip()] = int(v.strip())
            except ValueError:
                pass
    return out


def bildschirm_aus(ziel):
    _, aus = shell(ziel, "dumpsys power | grep -m1 mWakefulness=")
    return "mWakefulness=Awake" not in aus


def akku_ok(ziel):
    _, aus = shell(ziel, "dumpsys battery")
    werte = dict(z.strip().split(": ", 1) for z in aus.splitlines() if ": " in z)
    am_strom = any(werte.get(k) == "true" for k in ("AC powered", "USB powered", "Wireless powered"))
    try:
        stand = int(werte.get("level", "0"))
    except ValueError:
        stand = 0
    return am_strom or stand >= AKKU_MIN


def broadcast(ziel, aktion):
    return shell(ziel, f"am broadcast -a ch.rosenweg4303.telefon.{aktion} -n {EMPFAENGER}")


# ─── Pruefung der APK vor dem Einspielen ──────────────────────────────────────

def apk_pruefen(pfad, paket, sha_soll, vcode_soll):
    """None = in Ordnung, sonst der Grund."""
    h = hashlib.sha256()
    with open(pfad, "rb") as f:
        for stueck in iter(lambda: f.read(1024 * 1024), b""):
            h.update(stueck)
    if not sha_soll or not hmac.compare_digest(h.hexdigest(), sha_soll.lower()):
        return "SHA-256 passt nicht zum Katalog"
    if apk.zertifikat_sha256(pfad) != apk.SIGNATUR_SHA256:
        return "nicht mit dem Rosenweg-Schluessel signiert"
    p, vcode, _ = apk.manifest(pfad)
    if p != paket or vcode != vcode_soll:
        return f"Manifest passt nicht ({p} {vcode})"
    signer = shutil.which("apksigner")
    if signer:   # kryptografische Pruefung (Debian-Paket apksigner)
        r = subprocess.run([signer, "verify", "--print-certs", pfad], capture_output=True, text=True, timeout=120)
        if r.returncode != 0 or f"SHA-256 digest: {apk.SIGNATUR_SHA256}" not in r.stdout:
            return "apksigner: Signatur ungueltig"
    return None


# ─── ein Telefon ──────────────────────────────────────────────────────────────

def _log(conn, ext, text):
    conn.execute("INSERT INTO telefon_log (ext, ereignis, durch) VALUES (?,?,?)", (ext, text[:200], DURCH))
    conn.commit()


def _setzen(conn, ext, **werte):
    sp = ", ".join(f"{k} = ?" for k in werte)
    conn.execute(f"UPDATE telefon_updater SET {sp} WHERE ext = ?", (*werte.values(), ext))  # noqa: S608
    conn.commit()


def _wecken(ext):
    try:
        ami.originate(f"PJSIP/{ext}", "suchen", "s", callerid='"Wartung" <2098>', timeout_ms=15000)
    except Exception:  # noqa: BLE001
        pass   # Telefon holt den Stand spaetestens beim naechsten Status


def _nachts():
    try:
        von, bis = (int(x) for x in NACHT.split("-"))
    except ValueError:
        von, bis = 1, 5
    h = datetime.now(TZ).hour
    return von <= h < bis if von < bis else (h >= von or h < bis)


def _adb_ziel(conn, ext, seit):
    """Gemeldete Adresse:5555, wenn frisch (seit) und die Wartung an ist, sonst None."""
    r = conn.execute("SELECT a.adresse, a.port, a.gemeldet, w.wlan_debug_bis FROM telefon_adb a "
                     "LEFT JOIN telefon_wartung w ON w.ext = a.ext WHERE a.ext = ?", (ext,)).fetchone()
    if not r or int(r["port"] or 0) != 5555 or not r["adresse"]:
        return None
    if int(r["wlan_debug_bis"] or 0) <= time.time() or int(r["gemeldet"] or 0) < seit:
        return None
    return r["adresse"]


def faellig(conn, ext, u):
    jetzt = time.time()
    if u["sofort"] or (u["freigabe_bis"] > jetzt and not u["zugelassen"]):
        return True
    if not u["zugelassen"]:
        return False
    if u["versuch"] > u["geprueft"] and jetzt - u["versuch"] < WIEDERHOLEN_S:
        return False   # letzter Versuch ging schief: nicht alle 15 Min. wecken
    if ausstehend(conn, ext) or not u["geprueft"]:
        return True
    neuer = conn.execute("SELECT MAX(CAST(strftime('%s', updated_at) AS INTEGER)) AS t FROM telefon_apps "
                         "WHERE art = 'apk' AND aktiv = 1").fetchone()
    return bool(neuer and neuer["t"] and neuer["t"] > u["geprueft"])


def bearbeiten(conn, ext, trocken=False):
    u = zeile(conn, ext)
    conn.commit()
    jetzt = int(time.time())
    freigabe = u["freigabe_bis"] > jetzt and not u["zugelassen"]
    if not faellig(conn, ext, u):
        return
    grund = hindernis(conn, ext)
    if grund:
        _setzen(conn, ext, ergebnis=f"wartet: {grund}")
        return
    if trocken:
        print(f"{ext}: wuerde verbinden; ausstehend laut letzter Pruefung: "
              f"{[a['paket'] for a in ausstehend(conn, ext)] or 'unbekannt'}")
        return
    _setzen(conn, ext, versuch=jetzt)
    ip = _adb_ziel(conn, ext, jetzt - 900)
    von_uns = bool(u["wartung_von_uns"])   # z.B. "Updater zulassen" hat die Wartung eingeschaltet
    if not ip:
        db.wartung_setzen(conn, ext, WARTUNG_MIN, DURCH)
        conn.execute("UPDATE telefon_updater SET wartung_von_uns = 1 WHERE ext = ?", (ext,))
        conn.commit()
        von_uns = True
        _wecken(ext)
        for _ in range(24):   # bis 2 Min. auf die Meldung von Geraet warten
            time.sleep(5)
            ip = _adb_ziel(conn, ext, jetzt)
            if ip:
                break
    ziel = None
    try:
        if not ip:
            _setzen(conn, ext, ergebnis="Telefon meldet adb nicht (aus, Neustart, anderes WLAN?)")
            return
        if not any(ipaddress.ip_address(ip) in n for n in NETZE):
            _setzen(conn, ext, ergebnis=f"Netz von {ip} nicht freigegeben (nur {', '.join(map(str, NETZE))})")
            return
        ziel = f"{ip}:5555"
        adb("connect", ziel, timeout=20)
        st = zustand(ziel)
        for _ in range(18 if freigabe else 3):   # Zulassen: bis 90 s auf die Bestaetigung
            if st == "device":
                break
            time.sleep(5)
            st = zustand(ziel)
        if st != "device":
            _setzen(conn, ext, ergebnis="Updater-Schluessel nicht zugelassen" if st == "unauthorized"
                    else f"adb: {st or 'keine Verbindung'}")
            return
        _, serie = shell(ziel, "getprop ro.serialno")
        serie = serie.strip()
        if u["seriennummer"] and serie != u["seriennummer"]:
            _log(conn, ext, f"app-update abgebrochen: anderes Geraet unter {ip}")
            _setzen(conn, ext, ergebnis=f"anderes Geraet unter {ip} - nichts installiert")
            return
        if not u["zugelassen"]:
            _setzen(conn, ext, zugelassen=1, freigabe_bis=0, seriennummer=serie)
            _log(conn, ext, "updater zugelassen")
        ist = versionen(ziel)
        conn.execute("DELETE FROM telefon_apps_ist WHERE ext = ?", (ext,))
        conn.executemany("INSERT INTO telefon_apps_ist (ext, paket, version_code, geprueft) VALUES (?,?,?,?)",
                         [(ext, p, v, jetzt) for p, v in ist.items() if p.startswith("ch.rosenweg4303.")])
        conn.commit()
        ergebnis = _einspielen(conn, ext, ziel, ist)
        _setzen(conn, ext, geprueft=int(time.time()), sofort=0, ergebnis=ergebnis)
    except Exception as e:  # noqa: BLE001
        _setzen(conn, ext, ergebnis=f"Fehler: {type(e).__name__}")
        raise
    finally:
        if ziel:
            adb("disconnect", ziel, timeout=10)
        if von_uns and zeile(conn, ext)["wartung_von_uns"]:
            db.wartung_setzen(conn, ext, 0, DURCH)
            conn.execute("UPDATE telefon_updater SET wartung_von_uns = 0 WHERE ext = ?", (ext,))
            conn.commit()
            _wecken(ext)


def _einspielen(conn, ext, ziel, ist):
    offen = ausstehend(conn, ext)
    if not offen:
        return "aktuell"
    katalog = {r["paket"]: r for r in conn.execute(
        "SELECT paket, apk_datei, sha256, version_code FROM telefon_apps WHERE art = 'apk' AND aktiv = 1")}
    frei, fertig, uebrig = False, 0, []
    try:
        for a in offen:   # Geraet steht zuletzt (ausstehend sortiert so)
            paket = a["paket"]
            if paket == GERAET and not _nachts():
                uebrig.append(f"{paket} (nur nachts {NACHT} Uhr)")
                continue
            grund = hindernis(conn, ext)
            if not grund and not bildschirm_aus(ziel):
                grund = "Bildschirm ist an"
            if not grund and not akku_ok(ziel):
                grund = f"Akku unter {AKKU_MIN} %"
            if grund:
                uebrig.append(f"{paket} (wartet: {grund})")
                break
            k = katalog[paket]
            pfad = os.path.join(APPS_DIR, k["apk_datei"])
            fehler = apk_pruefen(pfad, paket, k["sha256"], k["version_code"])
            if fehler:
                _log(conn, ext, f"app-update abgelehnt {paket}: {fehler}")
                uebrig.append(f"{paket} ({fehler})")
                continue
            if not frei:
                broadcast(ziel, "ADB_INSTALLATION")
                frei = True
                time.sleep(2)
            rc, aus = adb("install", "-r", pfad, ziel=ziel, timeout=300)
            if rc == 0 and "Success" in aus:
                _log(conn, ext, f"app-update {paket} {a['ist']} -> {a['soll']}")
                conn.execute("UPDATE telefon_apps_ist SET version_code = ?, geprueft = ? WHERE ext = ? AND paket = ?",
                             (a["soll"], int(time.time()), ext, paket))
                conn.commit()
                fertig += 1
                if paket == GERAET:
                    time.sleep(15)   # Geraet startet neu; danach kennt es ADB_INSTALLATION_ENDE
                    ist[GERAET] = a["soll"]
            else:
                kurz = (aus.splitlines() or ["?"])[-1][:120]
                _log(conn, ext, f"app-update fehlgeschlagen {paket}: {kurz}")
                uebrig.append(f"{paket} (Fehler)")
    finally:
        # Installationsverbot sofort wieder setzen (sonst nach 10 Min. durch Geraet selbst).
        # Aeltere Geraete kennen die Aktion nicht - ihr Empfaenger wuerde sie als
        # ADB_INSTALLATION behandeln, darum nur ab GERAET_ENDE_AB.
        if frei and ist.get(GERAET, 0) >= GERAET_ENDE_AB:
            broadcast(ziel, "ADB_INSTALLATION_ENDE")
    text = f"{fertig} aktualisiert" if fertig else "nichts eingespielt"
    return text + (f"; offen: {', '.join(uebrig)}" if uebrig else "")


# ─── Lauf ─────────────────────────────────────────────────────────────────────

def main(argv=None):
    ap = argparse.ArgumentParser(description="Katalog-Apps per adb auf die geteilten Telefone bringen")
    ap.add_argument("--ext", help="nur diese Nebenstelle")
    ap.add_argument("--trocken", action="store_true", help="nichts einschalten, nichts installieren")
    args = ap.parse_args(argv)
    os.makedirs(ADB_HOME, mode=0o700, exist_ok=True)
    if not os.path.exists(os.path.join(ADB_HOME, ".android", "adbkey")):
        print("kein adb-Schluessel unter", os.path.join(ADB_HOME, ".android"), "- siehe pbx/DEPLOY-PBX-API.md")
        return 1
    with open(os.path.join(ADB_HOME, "updater.lock"), "w") as sperre:
        try:
            fcntl.flock(sperre, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("laeuft schon")
            return 0
        conn = db.connect()
        try:
            exts = [r["ext"] for r in conn.execute(
                "SELECT ext FROM sip_extensions WHERE context = 'geteilt' AND enabled = 1 ORDER BY ext")]
            for ext in exts:
                if args.ext and ext != args.ext:
                    continue
                try:
                    bearbeiten(conn, ext, trocken=args.trocken)
                except Exception as e:  # noqa: BLE001
                    print(f"{ext}: {type(e).__name__}: {e}")
        finally:
            conn.close()
            adb("kill-server", timeout=10)
    return 0


if __name__ == "__main__":
    sys.exit(main())
