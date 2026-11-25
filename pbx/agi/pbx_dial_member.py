#!/usr/bin/env python3
"""
AGI-Script: interne Direktwahl eines Ring-Group-Mitglieds (1000-1999).
Loest die gewaehlte Durchwahl (internal_ext) ueber die PBX-API zum Ziel auf und
setzt MEMBER_DIAL fuer ein anschliessendes Dial() im Dialplan.

  exten = _1XXX,n,AGI(pbx_dial_member.py,${EXTEN})
  exten = _1XXX,n,Dial(${MEMBER_DIAL},40,tT)
"""
import os
import re
import sys

try:
    import requests
except ImportError:
    print('VERBOSE "[dial-member] requests fehlt" 1')
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
API_BASE   = os.environ.get('PBX_API_BASE')      or _envfile.get('PBX_API_BASE', 'http://127.0.0.1:8095')
PBX_SECRET = os.environ.get('PBX_SHARED_SECRET') or _envfile.get('PBX_SHARED_SECRET', '')


def consume_agi_env():
    while True:
        if not sys.stdin.readline().rstrip('\r\n'):
            return


def set_var(key, value):
    print(f'SET VARIABLE {key} "{str(value)}"')
    sys.stdout.flush()
    sys.stdin.readline()


def agi_sauber(v, maxlen=60):
    """Wert fuer eine AGI-Befehlszeile: ohne Steuerzeichen (ein Zeilenumbruch
    waere ein zweiter AGI-Befehl, D-4), ohne Anfuehrungszeichen/Backslash, kurz."""
    v = re.sub(r'[\x00-\x1f\x7f"\\]', ' ', str(v or ''))
    return re.sub(r'\s+', ' ', v).strip()[:maxlen]


def log(msg):
    # Meldung enthaelt API-Namen/Fehlertexte -> bereinigen (R2-Dd).
    print(f'VERBOSE "[dial-member] {agi_sauber(msg, 200)}" 1')
    sys.stdout.flush()
    sys.stdin.readline()


def main():
    consume_agi_env()
    ext = sys.argv[1] if len(sys.argv) > 1 else ''
    if not re.fullmatch(r'[0-9]{1,8}', ext):
        set_var('MEMBER_DIAL', '')
        return
    try:
        r = requests.get(f'{API_BASE}/api/pbx/ring-members/by-ext/{ext}',
                         headers={'X-PBX-Secret': PBX_SECRET}, timeout=5)
        if r.status_code == 200:
            m = r.json()
            phone = str(m.get('phone') or '')
            # Ziel landet im Dial-String/AGI-Befehl: nur Nummer bzw. SIP-Name (D-5).
            gueltig = re.fullmatch(r'3[0-9]{5}', phone) if m.get('kind') == 'person' else \
                re.fullmatch(r'[A-Za-z0-9_-]{1,32}', phone) if m.get('kind') == 'sip' \
                else re.fullmatch(r'\+?[0-9]{3,20}', phone)
            if not gueltig:
                set_var('MEMBER_DIAL', '')
                log(f"{ext} -> ungueltiges Ziel, nicht gewaehlt")
                return
            target = (f"Local/{phone}@ring-person/n" if m.get('kind') == 'person'
                      else f"PJSIP/{phone}" if m.get('kind') == 'sip' else f"PJSIP/{phone}@peoplefone")
            set_var('MEMBER_DIAL', target)
            log(f"{ext} -> {re.sub(r'[^A-Za-z0-9 ._-]', ' ', str(m.get('name') or ''))[:60]} ({target})")
        else:
            set_var('MEMBER_DIAL', '')
            log(f"{ext} nicht gefunden ({r.status_code})")
    except Exception as e:  # noqa: BLE001
        set_var('MEMBER_DIAL', '')
        log(f"Fehler: {e}")


if __name__ == '__main__':
    main()
