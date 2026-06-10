#!/usr/bin/env python3
"""
AGI-Script: Prueft via API ob jetzt Geschaeftszeit ist (timezone-aware
Europe/Zurich auf API-Seite). Setzt IS_OPEN=1 oder 0 + RING_TIMEOUT.

Dialplan-Nutzung:
  exten = _X.,n,AGI(pbx_check_hours.py)
  exten = _X.,n,GotoIf($["${IS_OPEN}" = "1"]?open:closed)
"""
import os
import sys

try: import requests
except ImportError:
    print('VERBOSE "[hours] requests fehlt" 1'); sys.exit(0)

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
API_BASE   = os.environ.get('API_BASE')          or _envfile.get('API_BASE',   'http://100.64.2.27:3000')
PBX_SECRET = os.environ.get('PBX_SHARED_SECRET') or _envfile.get('PBX_SHARED_SECRET', '')

def consume_agi_env():
    while True:
        line = sys.stdin.readline().rstrip('\r\n')
        if not line: return

def set_var(key, value):
    val = str(value).replace('"', '\\"')
    print(f'SET VARIABLE {key} "{val}"')
    sys.stdout.flush()
    sys.stdin.readline()

def log(msg):
    print(f'VERBOSE "[hours] {msg}" 1')
    sys.stdout.flush()
    sys.stdin.readline()

def main():
    consume_agi_env()
    # Fallback ist CLOSED: bei API-Ausfall soll der Anruf NICHT die ganze
    # Ring-Group nachts aufwecken; lieber in die Voicemail laufen.
    try:
        r = requests.get(f'{API_BASE}/api/pbx/hours/check',
                          headers={'X-PBX-Secret': PBX_SECRET}, timeout=5)
        if not r.ok:
            log(f'API HTTP {r.status_code} — closed by default')
            set_var('IS_OPEN', '0')
            set_var('RING_TIMEOUT', '30')
            return
        d = r.json()
        log(f"now={d.get('now_local')} {d.get('weekday')} | {d.get('from')}-{d.get('to')} | open={d.get('is_open')}")
        set_var('IS_OPEN', '1' if d.get('is_open') else '0')
        set_var('RING_TIMEOUT', str(d.get('ring_timeout', 30)))
    except Exception as e:
        log(f'Fehler: {e} — closed by default')
        set_var('IS_OPEN', '0')
        set_var('RING_TIMEOUT', '30')

if __name__ == '__main__': main()
