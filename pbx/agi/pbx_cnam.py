#!/usr/bin/env python3
"""
AGI-Script: Caller-Name-Lookup (CNAM) fuer eingehende Anrufe.
Fragt die Haupt-API (/api/pbx/cnam/<nummer>) — Telefonbuch (personen/handwerker/
verwaltungen) + search.ch — und setzt CALLERID(name), damit der Name auf den
klingelnden Telefonen, im Anruf-Log und in der WhatsApp-Meldung erscheint.

  exten = _X.,n,AGI(pbx_cnam.py,${CALLERID(num)})
"""
import os
import sys

try:
    import requests
except ImportError:
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
# CNAM braucht die personen-DB -> Haupt-API (nicht die lokale PBX-API).
MAIN_API   = os.environ.get('MAIN_API_BASE')     or _envfile.get('MAIN_API_BASE', 'http://100.64.2.52:3000')
PBX_SECRET = os.environ.get('PBX_SHARED_SECRET') or _envfile.get('PBX_SHARED_SECRET', '')


def consume_agi_env():
    while True:
        if not sys.stdin.readline().rstrip('\r\n'):
            return


def set_var(key, value):
    val = str(value).replace('"', '\\"')
    print(f'SET VARIABLE {key} "{val}"')
    sys.stdout.flush()
    sys.stdin.readline()


def log(msg):
    print(f'VERBOSE "[cnam] {msg}" 1')
    sys.stdout.flush()
    sys.stdin.readline()


def main():
    consume_agi_env()
    num = sys.argv[1] if len(sys.argv) > 1 else ''
    if not num or num in ('unknown', 'anonymous', ''):
        return
    try:
        r = requests.get(f'{MAIN_API}/api/pbx/cnam/{num}',
                         headers={'X-PBX-Secret': PBX_SECRET}, timeout=5)
        name = r.json().get('name') if r.ok else None
        if name:
            # CALLERID(name) + Marker CNAM setzen (Marker: macro-techring laesst
            # den Namen stehen statt ihn mit "Rosenweg" zu ueberschreiben).
            for cmd in (f'SET VARIABLE CALLERID(name) "{name}"', f'SET VARIABLE CNAM "{name}"'):
                print(cmd)
                sys.stdout.flush()
                sys.stdin.readline()
            log(f"{num} -> {name}")
        else:
            log(f"{num} -> kein Name")
    except Exception as e:  # noqa: BLE001
        log(f"Fehler: {e}")


if __name__ == '__main__':
    main()
