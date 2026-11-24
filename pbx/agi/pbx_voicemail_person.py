#!/usr/bin/env python3
"""
AGI-Script: persoenliche Voicemail (3000er) bei der PBX-API eintragen.
Die Aufnahme bleibt auf der Anlage und gehoert nur der Person — keine
Weitergabe an die Technik-Gruppe (das macht nur transcribe_voicemail.py fuer
die STWEG-Nummer).

  exten = s,n,AGI(pbx_voicemail_person.py,${NUMMER},${VM_FILE}.wav,${UNIQUEID},${CALLERID(num)})
"""
import os
import re
import sys

try:
    import requests
except ImportError:
    print('VERBOSE "[vm-person] requests fehlt" 1')
    sys.exit(0)


def _load_env_file(path='/etc/default/asterisk-env'):
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' in line:
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    except (FileNotFoundError, PermissionError, OSError):
        pass
    return env


_envfile = _load_env_file()
API_BASE = os.environ.get('PBX_API_BASE') or _envfile.get('PBX_API_BASE', 'http://127.0.0.1:8095')
PBX_SECRET = os.environ.get('PBX_SHARED_SECRET') or _envfile.get('PBX_SHARED_SECRET', '')


def consume_agi_env():
    while True:
        if not sys.stdin.readline().rstrip('\r\n'):
            return


def set_var(key, value):
    # Anfuehrungszeichen, Backslash und Zeilenumbrueche wuerden das AGI-Protokoll
    # brechen; die API filtert sie schon, hier nochmal hart.
    val = re.sub(r'[\x00-\x1f\x7f"\\]', '', str(value))
    print(f'SET VARIABLE {key} "{val}"')
    sys.stdout.flush()
    sys.stdin.readline()


def log(msg):
    print(f'VERBOSE "[vm-person] {msg}" 1')
    sys.stdout.flush()
    sys.stdin.readline()


def main():
    consume_agi_env()
    a = sys.argv[1:] + ['', '', '', '']
    nummer, pfad, uid, anrufer = a[0], a[1], a[2], a[3]
    if not re.fullmatch(r'3[0-9]{5}', nummer) or not os.path.isfile(pfad):
        log(f'nichts aufgenommen ({nummer})')
        return
    if os.path.getsize(pfad) < 2048:  # nur Stille/aufgelegt
        os.remove(pfad)
        log('Aufnahme zu kurz, verworfen')
        return
    try:
        r = requests.post(f'{API_BASE}/api/pbx/voicemail-person', headers={'X-PBX-Secret': PBX_SECRET}, timeout=6,
                          json={'nummer': nummer, 'pfad': pfad, 'uniqueid': uid, 'caller_id': anrufer[:40]})
        log(f'{nummer}: Voicemail eingetragen ({r.status_code})')
    except Exception as e:  # noqa: BLE001
        log(f'API-Fehler: {e}')


if __name__ == '__main__':
    main()
