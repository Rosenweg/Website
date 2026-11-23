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

CREATE TABLE IF NOT EXISTS telefon_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ext          TEXT NOT NULL,
    ereignis     TEXT NOT NULL,            -- 'an' | 'ab'
    email        TEXT,
    name         TEXT,
    durch        TEXT,                     -- wer es ausgeloest hat (Geraet, Person, Admin)
    zeit         TEXT NOT NULL DEFAULT (datetime('now'))
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
}


def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def next_ext(conn, table, col, start):
    """Naechste freie ganzzahlige Durchwahl >= start in table.col."""
    rows = [int(r[0]) for r in conn.execute(f"SELECT {col} FROM {table} WHERE {col} IS NOT NULL")]
    n = start
    used = set(rows)
    while n in used:
        n += 1
    return n


def init_db():
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        # Migration fuer bestehende DBs: internal_ext-Spalte + Backfill ab 1000.
        cols = [r[1] for r in conn.execute("PRAGMA table_info(ring_members)")]
        if "internal_ext" not in cols:
            conn.execute("ALTER TABLE ring_members ADD COLUMN internal_ext INTEGER")
        # Gruppen der Person (fuer die App-Freigaben) an Ausweis und Sitzung.
        for tab in ("telefon_ausweise", "telefon_sitzungen"):
            if "gruppen" not in [r[1] for r in conn.execute(f"PRAGMA table_info({tab})")]:
                conn.execute(f"ALTER TABLE {tab} ADD COLUMN gruppen TEXT NOT NULL DEFAULT '[]'")
        # Der erste Anmeldeweg (Code am Geraet, 23.11.2026) wurde noch am selben
        # Abend durch den Anmelde-QR ersetzt.
        conn.execute("DROP TABLE IF EXISTS telefon_codes")
        # client-Spalte (2026-11-23): Android SIP braucht eine eigene SDP-Variante.
        if "client" not in [r[1] for r in conn.execute("PRAGMA table_info(sip_extensions)")]:
            conn.execute("ALTER TABLE sip_extensions ADD COLUMN client TEXT NOT NULL DEFAULT 'linphone'")
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
