#!/usr/bin/env python3
"""
AGI-Script: Wer ist an einem geteilten Telefon angemeldet?

Fragt die PBX-API nach der Sitzung des Endpunkts und setzt TELEFON_NAME
(leer = niemand angemeldet bzw. API nicht erreichbar -> Dialplan sperrt).

  exten = _[0-9*+#].,1,AGI(pbx_telefon_sitzung.py,${CHANNEL(endpoint)})
  same  = n,GotoIf($["${TELEFON_NAME}" = ""]?gesperrt)

Der Endpunkt kommt aus CHANNEL(endpoint), nicht aus der Caller-ID: die kann
ein Telefon selbst setzen, den authentifizierten Endpunkt nicht.
"""
import os
import re
import sys

try:
    import requests
except ImportError:
    print('VERBOSE "[telefon] requests fehlt" 1')
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
    print(f'VERBOSE "[telefon] {msg}" 1')
    sys.stdout.flush()
    sys.stdin.readline()


def main():
    consume_agi_env()
    ext = sys.argv[1] if len(sys.argv) > 1 else ''
    set_var('TELEFON_NAME', '')
    if not re.fullmatch(r'[0-9]{2,8}', ext):
        log(f'ungueltiger Endpunkt {ext!r}')
        return
    try:
        r = requests.get(f'{API_BASE}/api/pbx/telefon/{ext}/sitzung',
                         headers={'X-PBX-Secret': PBX_SECRET}, timeout=4)
        d = r.json() if r.ok else {}
    except Exception as e:  # noqa: BLE001
        log(f'API-Fehler: {e}')
        return
    if d.get('angemeldet'):
        set_var('TELEFON_NAME', d.get('name') or '')
        log(f'{ext}: angemeldet {d.get("name")}')
    else:
        log(f'{ext}: niemand angemeldet')


if __name__ == '__main__':
    main()
