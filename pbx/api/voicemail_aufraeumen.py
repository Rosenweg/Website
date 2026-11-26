#!/usr/bin/env python3
"""
Loeschfrist fuer Voicemails (Stefan 25.11.2026: 90 Tage).

Loescht Aufnahmen der Ring-Group (voicemail/recordings) und persoenliche Voicemails
(voicemail/personen), die aelter als VOICEMAIL_TAGE sind, und leert in der Anrufliste
Pfad, Abschrift und Zusammenfassung dieser Anrufe. Der Anruf selbst bleibt in der Liste.

Achtung: Die naechtlichen Proxmox-Sicherungen (PBS-Rosenweg, keep-all) behalten alte
Staende - die Frist gilt fuer die Anlage, nicht fuer die Backups.

Laeuft taeglich per systemd-Timer (pbx-voicemail-aufraeumen.timer) als root auf CT 220.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db  # noqa: E402

TAGE = int(os.environ.get("VOICEMAIL_TAGE", "90"))
ORDNER = [
    os.environ.get("PBX_VM_DIR", "/var/spool/asterisk/voicemail/recordings"),
    os.environ.get("PBX_VM_PERSON_DIR", "/var/spool/asterisk/voicemail/personen"),
]


def main():
    grenze = time.time() - TAGE * 86400
    dateien = 0
    for ordner in ORDNER:
        if not os.path.isdir(ordner):
            continue
        for name in os.listdir(ordner):
            p = os.path.join(ordner, name)
            if os.path.isfile(p) and name.endswith(".wav") and os.path.getmtime(p) < grenze:
                os.remove(p)
                dateien += 1
    conn = db.connect()
    try:
        n = conn.execute(
            "UPDATE calls SET voicemail_path = NULL, voicemail_transcript = NULL, voicemail_summary = NULL "
            "WHERE started_at < datetime('now', ?) AND (voicemail_path IS NOT NULL "
            "OR voicemail_transcript IS NOT NULL OR voicemail_summary IS NOT NULL)",
            (f"-{TAGE} days",),
        ).rowcount
        conn.commit()
    finally:
        conn.close()
    print(f"Voicemail-Frist {TAGE} Tage: {dateien} Aufnahme(n) geloescht, {n} Eintrag/Eintraege in der Anrufliste geleert")


if __name__ == "__main__":
    main()
