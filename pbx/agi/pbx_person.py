#!/usr/bin/env python3
"""
AGI-Script: persoenliche Nummer (3HHWWP) im Dialplan aufloesen.

Setzt PERSON_OK (1/0), PERSON_NAME, PERSON_DIAL (z.B. PJSIP/310201-2102&PJSIP/2003 —
alle Geraete, an denen die Person angemeldet ist: der persoenliche Zugang in Rosenweg
Telefon, wenn er registriert ist, sonst die Nebenstelle des Geraets), WL_MODUS (aus|immer|
nicht_erreichbar), WL_ZIEL, WL_SEK und PERSON_VM (1/0).

  exten = _3XXXXX,1,AGI(pbx_person.py,${EXTEN})
"""
import os
import re
import sys

try:
    import requests
except ImportError:
    print('VERBOSE "[person] requests fehlt" 1')
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
    print(f'VERBOSE "[person] {msg}" 1')
    sys.stdout.flush()
    sys.stdin.readline()


def main():
    consume_agi_env()
    nummer = sys.argv[1] if len(sys.argv) > 1 else ''
    # Anrufendes Geraet nicht mitklingeln lassen (wer sich selbst anruft, landet sonst bei sich)
    # (Nebenstelle 2102, persoenlicher Zugang 310201-2102 oder eigenes Handy 310201-p3)
    ohne = sys.argv[2] if len(sys.argv) > 2 and re.fullmatch(r'[0-9]{2,8}(-p?[0-9]{1,8})?', sys.argv[2]) else ''
    for k in ('PERSON_OK', 'PERSON_NAME', 'PERSON_DIAL', 'WL_MODUS', 'WL_ZIEL', 'WL_SEK', 'PERSON_VM'):
        set_var(k, '')
    if not re.fullmatch(r'3[0-9]{5}', nummer):
        log(f'ungueltige Nummer {nummer!r}')
        return
    try:
        r = requests.get(f'{API_BASE}/api/pbx/person/{nummer}', params={'ohne': ohne},
                         headers={'X-PBX-Secret': PBX_SECRET}, timeout=4)
        d = r.json() if r.ok else {}
    except Exception as e:  # noqa: BLE001
        log(f'API-Fehler: {e}')
        return
    if not d.get('ok'):
        log(f'{nummer}: unbekannt')
        return
    dial = d.get('dial') or ''
    if not re.fullmatch(r'(PJSIP/[0-9]{2,8}(-[0-9]{2,8})?)(&PJSIP/[0-9]{2,8}(-[0-9]{2,8})?)*', dial or 'x'):
        dial = ''
    ziel = d.get('ziel') or ''
    if not re.fullmatch(r'\+?[0-9]{8,15}', ziel or 'x'):
        ziel = ''
    set_var('PERSON_OK', '1')
    set_var('PERSON_NAME', d.get('name') or '')
    set_var('PERSON_DIAL', dial)
    set_var('WL_MODUS', d.get('weiterleitung') if ziel else 'aus')
    set_var('WL_ZIEL', ziel)
    set_var('WL_SEK', str(int(d.get('sekunden') or 20)))
    set_var('PERSON_VM', '1' if d.get('voicemail') else '0')
    log(f'{nummer}: {d.get("name")} -> {dial or "kein Geraet"}, Weiterleitung {d.get("weiterleitung")}')


if __name__ == '__main__':
    main()
