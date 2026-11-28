"""
SQLite-Datenhaltung der Standalone-PBX-API (laeuft in CT 220 neben Asterisk).
Bewusst eigenstaendig — keine Abhaengigkeit zur Haupt-Postgres. Migration der
Bestandsdaten via migrate_from_postgres.py.

Tabellen:
  ring_members    — wer bei einem eingehenden Anruf klingelt (Mobil oder SIP),
                    mit Prioritaet (Cascading) + Zeitsperre-Flag (bypass_hours).
  sip_extensions  — interne SIP-Telefone (LAN/VPN). Aus dieser Tabelle generiert
                    die API /etc/asterisk/pjsip_phones.conf (+ pjsip reload).
  config          — Geschaeftszeiten + Ring-Timeout.
  calls           — Anruf-/Voicemail-Log.
  prov_tokens     — kurzlebige Einmal-Tokens fuer die Linphone-Provisionierung
                    (der QR-Code zeigt auf /prov/<token>, die XML enthaelt das
                    SIP-Passwort — darum einmalig und mit Verfallszeit).
"""
import os
import sqlite3
import time

DB_PATH = os.environ.get("PBX_DB_PATH", "/var/lib/pbx-api/pbx.sqlite")

SCHEMA = """
CREATE TABLE IF NOT EXISTS ring_members (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    phone        TEXT NOT NULL,            -- kind=mobile: E.164 (+41..),  kind=sip: Extension (z.B. '11')
    kind         TEXT NOT NULL DEFAULT 'mobile',   -- 'mobile' | 'sip'
    bypass_hours INTEGER NOT NULL DEFAULT 0,       -- 1 = klingelt IMMER (ignoriert Zeitsperre)
    enabled      INTEGER NOT NULL DEFAULT 1,
    is_temporary INTEGER NOT NULL DEFAULT 0,
    valid_until  TEXT,                     -- ISO8601, NULL = permanent
    priority     INTEGER NOT NULL DEFAULT 100,     -- kleinere zuerst, gleiche parallel
    internal_ext INTEGER,                  -- interne Direktwahl (ab 1000), eindeutig
    notiz        TEXT,
    added_by     TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sip_extensions (
    ext          TEXT PRIMARY KEY,         -- z.B. '11'
    name         TEXT NOT NULL,
    secret       TEXT NOT NULL,            -- SIP-Passwort (nur LAN/VPN sichtbar)
    context      TEXT NOT NULL DEFAULT 'internal',
    client       TEXT NOT NULL DEFAULT 'linphone',  -- 'linphone' | 'android-sip' (steuert SDP + Provisionierung)
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
    key          TEXT PRIMARY KEY,
    value        TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by   TEXT
);

CREATE TABLE IF NOT EXISTS calls (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    direction            TEXT NOT NULL DEFAULT 'inbound',
    caller_id            TEXT,
    dialed               TEXT,
    uniqueid             TEXT UNIQUE,
    started_at           TEXT NOT NULL DEFAULT (datetime('now')),
    answered_at          TEXT,
    ended_at             TEXT,
    answered_by          TEXT,
    duration_seconds     INTEGER,
    hangup_cause         TEXT,
    voicemail_path       TEXT,
    voicemail_transcript TEXT,
    voicemail_summary    TEXT,
    meta_json            TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS prov_tokens (
    token        TEXT PRIMARY KEY,
    ext          TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    used_at      TEXT,                     -- gesetzt beim ersten Abruf: Einmal-Token
    created_by   TEXT
);

-- Geteilte Telefone (Kontext 'geteilt'): Anmeldung pro Person.
-- Die Person holt sich auf /telefon (eigenes Handy, Authentik) einen
-- persoenlichen Anmelde-QR; das gesperrte Telefon scannt und loest ihn ein.
-- Gespeichert wird nur der SHA-256 des Tokens.
CREATE TABLE IF NOT EXISTS telefon_ausweise (
    token_hash   TEXT PRIMARY KEY,
    user_id      TEXT,
    email        TEXT,
    name         TEXT NOT NULL,
    durch        TEXT,                     -- actor() der Person
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL             -- ISO8601 UTC, kurz (90 s)
);

CREATE TABLE IF NOT EXISTS telefon_sitzungen (
    ext          TEXT PRIMARY KEY,         -- ein Geraet, hoechstens eine Person
    user_id      TEXT,
    email        TEXT,
    name         TEXT NOT NULL,
    seit         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Zuletzt gemeldeter Boot eines geteilten Telefons (Header X-Rosenweg-Boot =
-- Settings.Global.BOOT_COUNT). Meldet das Geraet einen neuen Boot, beendet die
-- Anlage dessen Sitzung selbst (Stefan 27.11.2026: "Jede Sitzung endet direkt
-- beim Neustart"), auch wenn die App das Abmelden nicht schafft.
CREATE TABLE IF NOT EXISTS telefon_boot (
    ext          TEXT PRIMARY KEY,
    boot         TEXT NOT NULL,
    gesehen      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- App-Katalog der geteilten Telefone. art='apk': das Geraet installiert die
-- APK still (Device Owner) und blendet sie nur fuer erlaubte Gruppen ein.
-- art='web': Kachel in der Rosenweg-App (WebView). gruppen leer = alle, die
-- sich anmelden duerfen. persoenlich=1: Daten beim Abmelden loeschen.
-- konfig: JSON fuer Managed Configurations, Platzhalter {email} {name} {benutzer}.
CREATE TABLE IF NOT EXISTS telefon_apps (
    paket        TEXT PRIMARY KEY,         -- Android-Paketname bzw. 'web.<id>'
    name         TEXT NOT NULL,
    art          TEXT NOT NULL DEFAULT 'apk',   -- 'apk' | 'web'
    url          TEXT,                     -- nur web
    apk_datei    TEXT,                     -- Dateiname im App-Verzeichnis
    sha256       TEXT,
    groesse      INTEGER,
    gruppen      TEXT NOT NULL DEFAULT '',
    persoenlich  INTEGER NOT NULL DEFAULT 1,
    konfig       TEXT NOT NULL DEFAULT '{}',
    reihenfolge  INTEGER NOT NULL DEFAULT 100,
    aktiv        INTEGER NOT NULL DEFAULT 1,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Freigegebene Fassungen fuer die Seite /apps (POST /api/apps/release, CI der App-Repos
-- per GitHub OIDC; oder Technik von Hand). schluessel = App aus APPS_REGISTER (z.B. 'vm')
-- oder Paketname einer Katalog-App (z.B. 'ch.rosenweg4303.phone'). Je schluessel und
-- plattform gilt die neueste Zeile; aeltere bleiben begrenzt (APPS_BEHALTEN) zum Zurueckgehen.
CREATE TABLE IF NOT EXISTS apps_versionen (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    schluessel    TEXT NOT NULL,
    plattform     TEXT NOT NULL,           -- 'android' | 'linux-deb' | 'macos' | 'windows'
    version       TEXT NOT NULL,           -- z.B. '1.0.0'
    version_code  INTEGER,                 -- nur Android (aus dem Manifest)
    datei         TEXT NOT NULL,           -- Dateiname unter <PBX_TELEFON_APPS_DIR>/dateien/
    sha256        TEXT NOT NULL,
    groesse       INTEGER NOT NULL,
    notiz         TEXT NOT NULL DEFAULT '',
    quelle        TEXT NOT NULL,           -- 'Rosenweg/rosenweg-salz@v1.0.0' oder E-Mail
    zeit          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS apps_versionen_ziel ON apps_versionen (schluessel, plattform, id);

CREATE TABLE IF NOT EXISTS telefon_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ext          TEXT NOT NULL,
    ereignis     TEXT NOT NULL,            -- 'an' | 'ab' | 'karte-abgelehnt' | 'karte-info' | 'karte-zu' | 'karte-weg' | 'karte-geloescht' | 'gefunden'; 'ab' mit durch='neustart': Sitzung beim Neustart beendet
    email        TEXT,
    name         TEXT,
    durch        TEXT,                     -- wer es ausgeloest hat (Geraet, Person, Admin)
    zeit         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Einstellungen der Telefon-App pro Person (Regel 7: gehoeren der Person;
-- Entscheid 24.11.2026: auf der Anlage statt in der Nextcloud). Es gilt die
-- zuletzt geaenderte Fassung (geaendert = ms seit 1970, vom Telefon).
CREATE TABLE IF NOT EXISTS telefon_einstellungen (
    email        TEXT NOT NULL,
    paket        TEXT NOT NULL,
    werte        TEXT NOT NULL DEFAULT '{}',
    geaendert    INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (email, paket)
);

-- Hintergrundbild des Startbildschirms pro Person auf den geteilten Telefonen
-- (Stefan 27.11.2026: "Pro Person synchronisieren"). Das Bild selbst liegt als JPEG
-- ausserhalb der DB (PBX_HINTERGRUND_DIR, Dateiname = Hash der E-Mail); hier nur die
-- Fassung (Hash des Inhalts), an der die Telefone eine Aenderung erkennen.
CREATE TABLE IF NOT EXISTS telefon_hintergrund (
    email        TEXT PRIMARY KEY,
    version      TEXT NOT NULL,
    groesse      INTEGER NOT NULL,
    breite       INTEGER,
    hoehe        INTEGER,
    ext          TEXT,                     -- von welchem geteilten Telefon zuletzt hochgeladen
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Persoenliche PIN fuer die Bildschirmsperre geteilter Telefone (Entscheid
-- 24.11.2026: auf der Anlage, verschluesselt). Die Geraete-App braucht die PIN im
-- Klartext, um sie als Sperre zu setzen (resetPasswordWithToken) — darum kein Hash,
-- sondern Fernet mit PBX_PIN_KEY (nur in /etc/default/pbx-api).
CREATE TABLE IF NOT EXISTS telefon_pin (
    email        TEXT PRIMARY KEY,
    pin_enc      TEXT NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Nextcloud-App-Passwort der Person auf einem geteilten Telefon (Entscheid 24.11.2026):
-- ausgestellt von nc-token auf CT 104, weitergegeben ueber die Geraete-App an die
-- Rosenweg-Apps, beim Abmelden widerrufen. Verschluesselt wie die PIN (PBX_PIN_KEY).
CREATE TABLE IF NOT EXISTS telefon_nextcloud (
    ext          TEXT PRIMARY KEY,
    email        TEXT NOT NULL,
    benutzer     TEXT NOT NULL,
    pw_enc       TEXT NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Persoenliche Nummern 3 HH WW P (docs/plans/telefon-nummernplan.md, 24.11.2026).
-- Einmal vergeben bleibt eine Nummer bei der Person (Import ueberschreibt nicht).
-- weiterleitung: 'aus' | 'immer' | 'nicht_erreichbar' (nach weiterleitung_sekunden).
-- Eine Nummer pro PERSON: Paare teilen sich oft eine E-Mail (24.11.2026) —
-- darum (email, name) eindeutig, nicht email allein.
CREATE TABLE IF NOT EXISTS personen_nummern (
    nummer       TEXT PRIMARY KEY,
    email        TEXT NOT NULL,
    name         TEXT NOT NULL,
    wohnung      TEXT,
    haus         INTEGER,
    art          TEXT,
    weiterleitung          TEXT NOT NULL DEFAULT 'aus',
    weiterleitung_ziel     TEXT,
    weiterleitung_sekunden INTEGER NOT NULL DEFAULT 20,
    voicemail    INTEGER NOT NULL DEFAULT 1,
    aktiv        INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Persoenliches SIP-Konto in Rosenweg Telefon (Stefan 25.11.2026): pro Sitzung auf einem
-- geteilten Telefon ein eigener pjsip-Zugang <nummer>-<ext> (endpoint/auth/aor gleichen
-- Namens, pjsip_phones.conf). Entsteht beim Anmelden, verschwindet beim Abmelden — ein
-- abgemeldetes Geraet klingelt so nie mehr fuer die Person. Passwort nie loggen.
CREATE TABLE IF NOT EXISTS telefon_sip_person (
    ext          TEXT PRIMARY KEY,         -- Geraet (Nebenstelle) der Sitzung
    nummer       TEXT NOT NULL,            -- persoenliche Nummer 3HHWWP
    email        TEXT NOT NULL,
    passwort     TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Rosenweg Telefon auf dem eigenen Handy (Stefan 25.11.2026): Anmeldung in der App mit dem
-- Rosenweg-Konto (Authentik, Anwendung "rosenweg-apps"), danach ein fester Zugang
-- <nummer>-p<id> pro Handy. Bleibt, bis die App abmeldet, Technik ihn loescht oder die
-- persoenliche Nummer inaktiv wird. Passwort nie loggen.
CREATE TABLE IF NOT EXISTS telefon_sip_privat (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nummer       TEXT NOT NULL,            -- persoenliche Nummer 3HHWWP
    email        TEXT NOT NULL,
    geraet       TEXT NOT NULL DEFAULT '', -- Anzeige, z.B. "Pixel 8" (von der App)
    geraet_kennung TEXT NOT NULL DEFAULT '', -- sha256("rosenweg:"+ANDROID_ID), gleich in allen Rosenweg-Apps
    passwort     TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Wartung der geteilten Telefone (Stefan 25.11.2026): "Debugging ueber WLAN" zentral fuer
-- eine Nebenstelle einschalten. Die Geraete-App liest wlan_debug_bis im Status und wird mit
-- einem kurzen Anruf von 2098 "Wartung" geweckt.
CREATE TABLE IF NOT EXISTS telefon_wartung (
    ext            TEXT PRIMARY KEY,
    wlan_debug_bis INTEGER NOT NULL DEFAULT 0,   -- epoch Sekunden, 0 = aus
    durch          TEXT,
    geaendert      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Debug-Port der geteilten Telefone (Stefan 25.11.2026: "adb via Geraet stabiler"): Rosenweg Geraet
-- findet den Port von "Debugging ueber WLAN" per mDNS bei sich selbst und meldet ihn mit der
-- WLAN-Adresse; /smartphones zeigt daraus "adb connect". port 0 = aus.
CREATE TABLE IF NOT EXISTS telefon_adb (
    ext       TEXT PRIMARY KEY,
    adresse   TEXT NOT NULL DEFAULT '',
    port      INTEGER NOT NULL DEFAULT 0,
    gemeldet  INTEGER NOT NULL DEFAULT 0        -- epoch Sekunden
);

-- adb-Updater (Stefan 26.11.2026: "das zentrale System spielt neue App-Versionen selbst ein"):
-- adb_updater.py auf CT 220 verbindet sich mit eigenem adb-Schluessel ueber Port 5555 und
-- installiert neuere Katalog-Fassungen, nur wenn niemand angemeldet ist und nicht telefoniert
-- wird. seriennummer: beim ersten Kontakt gemerkt, danach muss sie passen (andere IP = anderes
-- Geraet?). freigabe_bis: einmalige Zulassung des Updater-Schluessels laeuft (epoch s).
-- wartung_von_uns: der Updater hat die Wartung selbst eingeschaltet und schaltet sie wieder aus.
CREATE TABLE IF NOT EXISTS telefon_updater (
    ext             TEXT PRIMARY KEY,
    seriennummer    TEXT NOT NULL DEFAULT '',
    zugelassen      INTEGER NOT NULL DEFAULT 0,  -- Updater-Schluessel auf dem Telefon zugelassen
    freigabe_bis    INTEGER NOT NULL DEFAULT 0,
    sofort          INTEGER NOT NULL DEFAULT 0,  -- "Jetzt aktualisieren" auf /smartphones
    wartung_von_uns INTEGER NOT NULL DEFAULT 0,
    versuch         INTEGER NOT NULL DEFAULT 0,  -- epoch s des letzten Versuchs
    geprueft        INTEGER NOT NULL DEFAULT 0,  -- epoch s der letzten vollstaendigen Pruefung
    ergebnis        TEXT NOT NULL DEFAULT ''     -- kurz, fuer /smartphones
);

-- Fernwartung ueber den dauerhaften adb-Tunnel (Plan adb-tunnel-telefone, 27.11.2026): je
-- geteiltem Telefon ein fester WireGuard-Schluessel (entsteht auf dem Telefon, hier nur der
-- oeffentliche Teil) und eine feste Adresse im Tunnelnetz. Aktiv bei adb-zentrale erst nach
-- "Bestaetigen" auf /smartphones; aus = Not-Aus (Peer weg, Telefon setzt ADB_ENABLED=0).
CREATE TABLE IF NOT EXISTS telefon_tunnel (
    ext          TEXT PRIMARY KEY,
    pubkey       TEXT NOT NULL,
    ip           TEXT NOT NULL UNIQUE,
    bestaetigt   INTEGER NOT NULL DEFAULT 0,
    aus          INTEGER NOT NULL DEFAULT 0,
    gemeldet     INTEGER NOT NULL DEFAULT 0,      -- epoch s, letzte Meldung des Telefons
    durch        TEXT,                            -- wer zuletzt bestaetigt/geschaltet hat
    geaendert    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sitzungen ueber den Tunnel (von adb-zentrale gemeldet). person = Konto auf adb-zentrale
-- bzw. "App-Updater"; befehle = JSON-Liste der rw-adb-Befehlszeilen (interaktiv nur "shell").
CREATE TABLE IF NOT EXISTS telefon_fernwartung (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ext          TEXT NOT NULL,
    person       TEXT NOT NULL DEFAULT '',
    zweck        TEXT NOT NULL DEFAULT '',
    beginn       INTEGER NOT NULL,
    ende         INTEGER,
    bytes_hin    INTEGER NOT NULL DEFAULT 0,
    bytes_her    INTEGER NOT NULL DEFAULT 0,
    befehle      TEXT NOT NULL DEFAULT '[]',
    grund        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS telefon_fernwartung_ext ON telefon_fernwartung (ext, beginn);

-- Fremde adb-Rueckfragen ("USB-Debugging zulassen?" mit unbekanntem Fingerabdruck), die die
-- Bedienungshilfe von Rosenweg Geraet abgelehnt hat (NOC rot, Verlauf auf /smartphones).
CREATE TABLE IF NOT EXISTS telefon_adb_fremd (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ext            TEXT NOT NULL,
    fingerabdruck  TEXT NOT NULL,
    abgelehnt      INTEGER NOT NULL DEFAULT 1,
    zeit           INTEGER NOT NULL
);

-- Was der Updater zuletzt auf dem Telefon gesehen hat (versionCode je Paket).
CREATE TABLE IF NOT EXISTS telefon_apps_ist (
    ext           TEXT NOT NULL,
    paket         TEXT NOT NULL,
    version_code  INTEGER,
    geprueft      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ext, paket)
);

-- Protokoll der Geraete-App (Rosenweg Geraet) je geteiltem Telefon, 14 Tage. Die App maskiert
-- Nummern, Mailadressen und Namen vor dem Senden; hier gibt es keine Personendaten.
CREATE TABLE IF NOT EXISTS telefon_geraetelog (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ext    TEXT NOT NULL,
    zeit   INTEGER NOT NULL,           -- Zeitpunkt der Zeile auf dem Telefon (Unix-Sekunden)
    stufe  TEXT NOT NULL DEFAULT 'I',  -- V D I W E F
    tag    TEXT NOT NULL DEFAULT '',
    text   TEXT NOT NULL DEFAULT '',
    empfangen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS telefon_geraetelog_ext_zeit ON telefon_geraetelog (ext, zeit);

-- Versionsstand der Rosenweg-Apps auf den Geraeten (Updater der Apps, Stefan 27.11.2026: "die
-- Apps melden ihre Version ... ohne Personendaten"). geraet = SHA-256-Kennung (Android: aus der
-- ANDROID_ID, Computer: aus der Maschinen-ID), nicht umkehrbar. Eine Meldung ersetzt alle Zeilen
-- des Geraets fuer die Plattform (nicht mehr gemeldet = deinstalliert). Geteilte Telefone stehen
-- zusaetzlich mit Nebenstelle in telefon_apps_ist (adb-Updater).
CREATE TABLE IF NOT EXISTS apps_stand (
    geraet        TEXT NOT NULL,
    plattform     TEXT NOT NULL,           -- 'android' | 'linux-deb' | 'macos' | 'windows'
    paket         TEXT NOT NULL,
    version       TEXT NOT NULL DEFAULT '',
    version_code  INTEGER,
    geteilt       INTEGER NOT NULL DEFAULT 0,  -- Android mit Rosenweg Geraet
    station       INTEGER NOT NULL DEFAULT 0,  -- Rosenweg-Station / verwaltete Installation
    system        TEXT NOT NULL DEFAULT '',
    zuletzt       INTEGER NOT NULL,            -- epoch s
    PRIMARY KEY (geraet, plattform, paket)
);

-- WLAN der geteilten Telefone (Stefan 25.11.2026): SSID "Rosenweg" mit PPSK, das Passwort
-- bestimmt das VLAN. Die Schluessel stehen NUR hier in der Datenbank (nie im Repo, nie im Log);
-- Rosenweg Geraet holt seinen mit dem Geraete-Token und richtet das WLAN als Device Owner ein.
-- netz: Name wie im UniFi-PPSK (RK-Clients, RW9-Clients ...). Abgemeldet gilt 'RK-Clients'.
CREATE TABLE IF NOT EXISTS telefon_wlan (
    netz         TEXT PRIMARY KEY,
    vlan         INTEGER,
    passwort     TEXT NOT NULL,
    geaendert    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 4000er: Hausverwaltung (heute Immosense), 4000 Hauptnummer, 4001 ... Mitarbeiter.
-- Nur Festnetznummern (Entscheid 24.11.2026).
CREATE TABLE IF NOT EXISTS verwaltung_nummern (
    nummer       TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    ziel         TEXT NOT NULL,            -- externe Nummer (E.164)
    notiz        TEXT,
    aktiv        INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ring_enabled ON ring_members(enabled);
CREATE INDEX IF NOT EXISTS idx_prov_ext ON prov_tokens(ext);
"""

DEFAULT_CONFIG = {
    "hours_open_from": "06:00",
    "hours_open_to": "20:00",
    "ring_timeout": "30",
    "weekdays": "mon-sun",
    # Wer sich an geteilten Telefonen anmelden darf (Authentik-Gruppen, klein).
    "telefon_gruppen": "technik,präsident,praesident",
    # Bleiben installiert und funktionsfaehig, aber der Rosenweg Launcher zeigt sie
    # nicht: Android verlangt fuer Notrufe die System-Telefon-App und fuer
    # "Foto aufnehmen" (IMAGE_CAPTURE, seit Android 11) die System-Kamera.
    "telefon_unsichtbar": "com.samsung.android.dialer,com.sec.android.app.camera",
    # System-Apps, die geteilte Telefone immer ausblenden (Device Owner).
    # Lebenswichtiges (WebView, Telefonie, Notruf) schuetzt die App selbst.
    "telefon_ausblenden": ",".join([
        "com.android.vending",                       # Play Store
        "com.google.android.youtube", "com.google.android.apps.youtube.music",
        "com.google.android.gm",                     # Gmail
        "com.google.android.apps.maps", "com.google.android.apps.photos",
        "com.google.android.apps.docs",              # Drive
        "com.google.android.googlequicksearchbox",   # Google-App/Suche
        "com.google.android.apps.messaging", "com.google.android.apps.tachyon",
        "com.google.android.apps.wellbeing", "com.google.android.apps.googleassistant",
        "com.google.android.apps.subscriptions.red", # Google One
        "com.facebook.katana", "com.facebook.appmanager", "com.facebook.services", "com.facebook.system",
        "com.netflix.mediaclient", "com.microsoft.skydrive", "com.spotify.music",
        # Nachinstallierer ab Werk (A15, 24.11.2026): Galaxy Store installierte Temu
        # und ein Spiel still nach der Einrichtung; Aura (ironSource) ist App-Werbung.
        "com.sec.android.app.samsungapps", "com.aura.oobe.samsung.gl",
        "com.einnovation.temu", "com.lazada.android", "com.block.juggle",
        "com.google.android.apps.bard",              # Gemini
        # KI-Assistenten (Entscheid Stefan 24.11.2026: auf geteilten Telefonen
        # gesperrt). Bixby Vision bleibt: die System-Kamera braucht es.
        "com.samsung.android.bixby.agent", "com.samsung.android.bixby.wakeup",
        "com.samsung.android.app.settings.bixby",
        "com.openai.chatgpt", "com.microsoft.copilot", "ai.perplexity.app.android",
        "com.anthropic.claude",
        "com.samsung.android.app.omcagent",          # Samsung-Nachinstallierer (ohne SIM unnoetig)
        "com.linkedin.android", "com.microsoft.office.officehubrow", "com.microsoft.appmanager",
        "com.mojang.minecraftpe", "com.nebula.mahjongtile",
        "com.samsung.sree", "com.samsung.android.game.gamehome", "com.samsung.android.app.spage",
        "com.samsung.android.app.watchmanager", "com.samsung.android.oneconnect",
        "com.samsung.android.voc", "com.sec.android.app.shealth", "com.sec.android.easyMover",
        "com.samsung.ecomm.global.gbr", "com.sec.android.app.kidshome",   # Samsung Shop, Kids
        "com.samsung.android.messaging",             # SMS — ohne SIM nutzlos
        # Samsung-Tastatur (erst ausblendbar, wenn die Rosenweg Tastatur aktiv ist —
        # die aktive Tastatur ist geschuetzt), Google-Spracheingabe + Vorlesestimme,
        # Voice Access, Samsung-Sprachdienst.
        "com.samsung.android.honeyboard", "com.google.android.tts",
        "com.google.android.apps.accessibility.voiceaccess", "com.samsung.android.intellivoiceservice",
        "com.sec.android.app.sbrowser",              # Samsung Internet (Browser: Chrome bzw. spaeter Cromite)
        # Durch Rosenweg-Forks ersetzt (Fossify Camera, Contacts, File Manager):
        "com.samsung.android.app.contacts", "com.sec.android.app.myfiles",
        "com.sec.android.gallery3d", "com.samsung.android.calendar",   # Fossify Gallery, Calendar
        "com.sec.android.app.popupcalculator", "com.samsung.android.app.notes",   # Fossify Calculator, Notes
        "com.sec.android.app.clockpackage",          # Fossify Clock
        "com.sec.android.app.voicenote",             # Fossify Voice Recorder
    ]),
}


def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def wartung_setzen(conn, ext, minuten, durch):
    """Wartung (adb) einer Nebenstelle zentral ein- (minuten > 0) oder ausschalten (0) und
    protokollieren. Gemeinsam fuer /smartphones und den adb-Updater. Gibt wlan_debug_bis zurueck.
    Wecken (Anruf 2098) macht der Aufrufer, danach - nicht in der Transaktion."""
    bis = int(time.time()) + minuten * 60 if minuten else 0
    conn.execute("INSERT INTO telefon_wartung (ext, wlan_debug_bis, durch, geaendert) VALUES (?,?,?,datetime('now')) "
                 "ON CONFLICT(ext) DO UPDATE SET wlan_debug_bis = excluded.wlan_debug_bis, "
                 "durch = excluded.durch, geaendert = excluded.geaendert", (ext, bis, durch))
    conn.execute("INSERT INTO telefon_log (ext, ereignis, durch) VALUES (?,?,?)",
                 (ext, f"wlan-debug {minuten} min" if minuten else "wlan-debug aus", durch))
    return bis


def next_ext(conn, table, col, start):
    """Naechste freie ganzzahlige Durchwahl >= start in table.col."""
    rows = [int(r[0]) for r in conn.execute(f"SELECT {col} FROM {table} WHERE {col} IS NOT NULL")]
    n = start
    used = set(rows)
    while n in used:
        n += 1
    return n


def person_zur_zeit(conn, ext, zeit):
    """E-Mail der Person, die zur Zeit `zeit` an Nebenstelle `ext` angemeldet war
    (aus telefon_log), sonst None."""
    if not ext or not zeit:
        return None
    r = conn.execute(
        # Nur An-/Abmeldungen: Karten-Eintraege (karte-info, karte-zu, ...) sagen nichts darueber,
        # wer angemeldet war.
        "SELECT ereignis, email FROM telefon_log WHERE ext = ? AND zeit <= ? AND ereignis IN ('an', 'ab') "
        "ORDER BY zeit DESC, id DESC LIMIT 1",
        (str(ext), zeit)).fetchone()
    return r["email"] if r and r["ereignis"] == "an" and r["email"] else None


def ist_nebenstelle(conn, nummer):
    return bool(nummer) and conn.execute(
        "SELECT 1 FROM sip_extensions WHERE ext = ?", (str(nummer),)).fetchone() is not None


def calls_nachtragen(conn):
    """Einmalig: bestehende Anrufe ueber das Sitzungsprotokoll Personen zuordnen."""
    for c in conn.execute("SELECT id, direction, caller_id, dialed, answered_by, started_at FROM calls").fetchall():
        ext = c["caller_id"] if c["direction"] in ("internal", "outbound") and ist_nebenstelle(conn, c["caller_id"]) else (
            c["answered_by"] if ist_nebenstelle(conn, c["answered_by"]) else None)
        ziel = c["dialed"] if c["direction"] == "internal" and ist_nebenstelle(conn, c["dialed"]) else None
        conn.execute("UPDATE calls SET ext = ?, person = ?, ziel_ext = ?, ziel_person = ? WHERE id = ?",
                     (ext, person_zur_zeit(conn, ext, c["started_at"]), ziel,
                      person_zur_zeit(conn, ziel, c["started_at"]), c["id"]))


def init_db():
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        # Migration fuer bestehende DBs: internal_ext-Spalte + Backfill ab 1000.
        cols = [r[1] for r in conn.execute("PRAGMA table_info(ring_members)")]
        if "internal_ext" not in cols:
            conn.execute("ALTER TABLE ring_members ADD COLUMN internal_ext INTEGER")
        # immer=1: Werkzeug (Tastatur, Browser) — auch gesperrt verfuegbar, nie
        # ausgeblendet, Daten bleiben. Sonst gaebe es z.B. beim Anmelden keine Tastatur.
        # Nextcloud-Zugang nach dem Abmelden: bleibt, bis das Telefon alles hochgeladen hat (max. 24 h)
        if "abgemeldet_at" not in [r[1] for r in conn.execute("PRAGMA table_info(telefon_nextcloud)")]:
            conn.execute("ALTER TABLE telefon_nextcloud ADD COLUMN abgemeldet_at TEXT")
        if "immer" not in [r[1] for r in conn.execute("PRAGMA table_info(telefon_apps)")]:
            conn.execute("ALTER TABLE telefon_apps ADD COLUMN immer INTEGER NOT NULL DEFAULT 0")
        # Version der APK (fuer die Downloads auf der Apps-Seite und den Updater der Apps)
        spalten = [r[1] for r in conn.execute("PRAGMA table_info(telefon_apps)")]
        if "version_code" not in spalten:
            conn.execute("ALTER TABLE telefon_apps ADD COLUMN version_code INTEGER")
        if "version_name" not in spalten:
            conn.execute("ALTER TABLE telefon_apps ADD COLUMN version_name TEXT")
        # Geraetekennung der eigenen Handys (26.11.2026): im Portal jedes Handy einmal, mit allen Apps
        if "geraet_kennung" not in [r[1] for r in conn.execute("PRAGMA table_info(telefon_sip_privat)")]:
            conn.execute("ALTER TABLE telefon_sip_privat ADD COLUMN geraet_kennung TEXT NOT NULL DEFAULT ''")
        # Gruppen der Person (fuer die App-Freigaben) an Ausweis und Sitzung.
        for tab in ("telefon_ausweise", "telefon_sitzungen"):
            if "gruppen" not in [r[1] for r in conn.execute(f"PRAGMA table_info({tab})")]:
                conn.execute(f"ALTER TABLE {tab} ADD COLUMN gruppen TEXT NOT NULL DEFAULT '[]'")
        # Anzeige-ID der Karte, mit der sich die Person am Telefon angemeldet hat (28.11.2026):
        # geht im Anlage-Token an die Haupt-API (Herkunft eines App-QR; Karte entzogen -> abmelden)
        if "karte" not in [r[1] for r in conn.execute("PRAGMA table_info(telefon_sitzungen)")]:
            conn.execute("ALTER TABLE telefon_sitzungen ADD COLUMN karte TEXT")
        # Der erste Anmeldeweg (Code am Geraet, 23.11.2026) wurde noch am selben
        # Abend durch den Anmelde-QR ersetzt.
        conn.execute("DROP TABLE IF EXISTS telefon_codes")
        # client-Spalte (2026-11-23): Android SIP braucht eine eigene SDP-Variante.
        if "client" not in [r[1] for r in conn.execute("PRAGMA table_info(sip_extensions)")]:
            conn.execute("ALTER TABLE sip_extensions ADD COLUMN client TEXT NOT NULL DEFAULT 'linphone'")
        # Anrufe einer Person zuordnen (24.11.2026, Anrufliste in Rosenweg Telefon):
        # ext/person = Seite der Person, die anruft bzw. abnimmt; ziel_* = angerufene
        # interne Seite. person = E-Mail der zur Zeit angemeldeten Person.
        calls_cols = [r[1] for r in conn.execute("PRAGMA table_info(calls)")]
        neu_calls = [c for c in ("ext", "person", "ziel_ext", "ziel_person") if c not in calls_cols]
        for c in neu_calls:
            conn.execute(f"ALTER TABLE calls ADD COLUMN {c} TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_calls_person ON calls(person)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_calls_ziel_person ON calls(ziel_person)")
        if neu_calls:
            calls_nachtragen(conn)
        # personen_nummern hatte anfangs email UNIQUE (eine Nummer je E-Mail) —
        # umbauen auf (email, name), damit Paare mit gemeinsamer E-Mail je eine Nummer bekommen.
        sql = (conn.execute("SELECT sql FROM sqlite_master WHERE name = 'personen_nummern'").fetchone() or [""])[0] or ""
        if "email        TEXT NOT NULL UNIQUE" in sql:
            conn.execute("ALTER TABLE personen_nummern RENAME TO personen_nummern_alt")
            conn.executescript(SCHEMA)
            conn.execute("INSERT INTO personen_nummern SELECT * FROM personen_nummern_alt")
            conn.execute("DROP TABLE personen_nummern_alt")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_personen_email_name ON personen_nummern(lower(email), lower(name))")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_personen_email ON personen_nummern(lower(email))")
        for r in conn.execute("SELECT id FROM ring_members WHERE internal_ext IS NULL ORDER BY id").fetchall():
            conn.execute("UPDATE ring_members SET internal_ext = ? WHERE id = ?",
                         (next_ext(conn, "ring_members", "internal_ext", 1000), r[0]))
        for k, v in DEFAULT_CONFIG.items():
            conn.execute(
                "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
                (k, v),
            )
        conn.commit()
    finally:
        conn.close()


def touch(conn, table, where_col, where_val):
    conn.execute(
        f"UPDATE {table} SET updated_at = datetime('now') WHERE {where_col} = ?",
        (where_val,),
    )


def rows_to_dicts(rows):
    return [dict(r) for r in rows]


if __name__ == "__main__":
    init_db()
    print(f"DB initialisiert: {DB_PATH}")
