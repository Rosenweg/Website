#!/usr/bin/env python3
"""
Einmalige Migration der PBX-Bestandsdaten aus der Haupt-Postgres in die lokale
SQLite der PBX-API. Dependency-frei: liest einen JSON-Dump (kein psycopg2 noetig).

JSON-Dump auf einem Host mit psql-Zugriff erzeugen (Werte = Haupt-Postgres):
  psql "$PG_DSN" -At -c "SELECT json_build_object(
      'ring_members', COALESCE((SELECT json_agg(r) FROM pbx_ring_members r), '[]'),
      'config',       COALESCE((SELECT json_agg(c) FROM pbx_config c), '[]'),
      'calls',        COALESCE((SELECT json_agg(x) FROM pbx_calls x), '[]'))" > pbx-dump.json

Dann auf CT 220:
  PBX_DB_PATH=/var/lib/pbx-api/pbx.sqlite python3 migrate_from_postgres.py pbx-dump.json
"""
import json
import sys

import db


def main(path):
    with open(path) as f:
        data = json.load(f)
    db.init_db()
    conn = db.connect()
    try:
        rm = data.get("ring_members") or []
        for m in rm:
            conn.execute(
                "INSERT INTO ring_members (name, phone, kind, bypass_hours, enabled, is_temporary, "
                "valid_until, priority, notiz, added_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (m.get("name"), m.get("phone"),
                 m.get("kind") or "mobile",
                 1 if m.get("bypass_hours") else 0,
                 1 if m.get("enabled", True) else 0,
                 1 if m.get("is_temporary") else 0,
                 m.get("valid_until"), int(m.get("priority") or 100),
                 m.get("notiz"), m.get("added_by")),
            )
        for c in (data.get("config") or []):
            conn.execute(
                "INSERT INTO config (key, value, updated_by) VALUES (?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (c.get("key"), c.get("value"), c.get("updated_by")),
            )
        for x in (data.get("calls") or []):
            conn.execute(
                "INSERT OR IGNORE INTO calls (direction, caller_id, dialed, uniqueid, started_at, "
                "answered_at, ended_at, answered_by, duration_seconds, hangup_cause, "
                "voicemail_transcript, voicemail_summary) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (x.get("direction", "inbound"), x.get("caller_id"), x.get("dialed"), x.get("uniqueid"),
                 x.get("started_at"), x.get("answered_at"), x.get("ended_at"), x.get("answered_by"),
                 x.get("duration_seconds"), x.get("hangup_cause"),
                 x.get("voicemail_transcript"), x.get("voicemail_summary")),
            )
        conn.commit()
        print(f"Migriert: {len(rm)} ring_members, {len(data.get('config') or [])} config, "
              f"{len(data.get('calls') or [])} calls -> {db.DB_PATH}")
    finally:
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: migrate_from_postgres.py <pbx-dump.json>", file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1])
