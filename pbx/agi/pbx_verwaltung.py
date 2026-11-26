#!/usr/bin/env python3
"""
AGI-Script: 4000er Kurzwahl der Hausverwaltung -> externe Nummer.
Setzt VERW_ZIEL (leer = unbekannt) und VERW_NAME.

  exten = _4XXX,1,AGI(pbx_verwaltung.py,${EXTEN})
"""
import os
import re
import sys

try:
    import requests
except ImportError:
    print('VERBOSE "[verwaltung] requests fehlt" 1')
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
    print(f'VERBOSE "[verwaltung] {msg}" 1')
    sys.stdout.flush()
    sys.stdin.readline()


def main():
    consume_agi_env()
    nummer = sys.argv[1] if len(sys.argv) > 1 else ''
    set_var('VERW_ZIEL', '')
    set_var('VERW_NAME', '')
    if not re.fullmatch(r'4[0-9]{3}', nummer):
        return
    try:
        r = requests.get(f'{API_BASE}/api/pbx/verwaltung/{nummer}', headers={'X-PBX-Secret': PBX_SECRET}, timeout=4)
        d = r.json() if r.ok else {}
    except Exception as e:  # noqa: BLE001
        log(f'API-Fehler: {e}')
        return
    ziel = d.get('ziel') or ''
    if d.get('ok') and re.fullmatch(r'\+?[0-9]{8,15}', ziel):
        set_var('VERW_ZIEL', ziel)
        set_var('VERW_NAME', d.get('name') or '')
        log(f'{nummer}: {d.get("name")}')
    else:
        log(f'{nummer}: unbekannt')


if __name__ == '__main__':
    main()
