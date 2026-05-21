#!/usr/bin/env python3
"""
AGI-Script: Holt aktive Ring-Member-Liste von der Rosenweg-API und
baut den Dial-String fuer Asterisks Dial()-Anwendung.

Verwendung im Dialplan:
  exten = _X.,n,AGI(pbx_get_ring_members.py)
  exten = _X.,n,Dial(${RING_DIAL},${RING_TIMEOUT},tT)

Wenn keine aktiven Members oder API unerreichbar:
  → RING_DIAL bleibt leer → Dial scheitert sofort → Fallback Voicemail
"""
import os
import sys

try:
    import requests
except ImportError:
    print('VERBOSE "[get-ring] requests-Modul fehlt" 1')
    sys.exit(0)

# ENV aus /etc/default/asterisk-env lesen wenn nicht im Prozess-ENV
# (Asterisk-Start via init.d reicht EnvironmentFile nicht durch)
def _load_env_file(path='/etc/default/asterisk-env'):
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'): continue
                if '=' in line:
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError: pass
    return env
_envfile = _load_env_file()
API_BASE   = os.environ.get('API_BASE')   or _envfile.get('API_BASE',   'http://100.64.2.27:3000')
PBX_SECRET = os.environ.get('PBX_SHARED_SECRET') or _envfile.get('PBX_SHARED_SECRET', '')

# AGI-Protokoll: stdin liest Header bis Leerzeile, dann Commands auf stdout
def consume_agi_env():
    while True:
        line = sys.stdin.readline().rstrip('\r\n')
        if not line:
            return

def set_var(key, value):
    val = value.replace('"', '\\"')
    print(f'SET VARIABLE {key} "{val}"')
    sys.stdout.flush()
    # consume response
    sys.stdin.readline()

def log(msg):
    print(f'VERBOSE "[get-ring] {msg}" 1')
    sys.stdout.flush()
    sys.stdin.readline()

def main():
    consume_agi_env()
    try:
        r = requests.get(
            f'{API_BASE}/api/pbx/ring-members/active',
            headers={'X-PBX-Secret': PBX_SECRET},
            timeout=5,
        )
        if not r.ok:
            log(f'API HTTP {r.status_code}')
            set_var('RING_DIAL', '')
            return
        members = r.json().get('members', [])
    except Exception as e:
        log(f'API-Fehler: {e}')
        set_var('RING_DIAL', '')
        return

    if not members:
        log('Keine aktiven Members')
        set_var('RING_DIAL', '')
        return

    # Build Dial-String: "PJSIP/+41xxx@peoplefone&PJSIP/+41yyy@peoplefone"
    dial_parts = [f"PJSIP/{m['phone']}@peoplefone" for m in members]
    dial_str = '&'.join(dial_parts)
    log(f'{len(members)} Members: {", ".join(m["name"] for m in members)}')
    set_var('RING_DIAL', dial_str)

if __name__ == '__main__':
    main()
