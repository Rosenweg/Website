#!/usr/bin/env python3
"""
AGI-Script: interne Direktwahl eines Ring-Group-Mitglieds (1000-1999).
Loest die gewaehlte Durchwahl (internal_ext) ueber die PBX-API zum Ziel auf und
setzt MEMBER_DIAL fuer ein anschliessendes Dial() im Dialplan.

  exten = _1XXX,n,AGI(pbx_dial_member.py,${EXTEN})
  exten = _1XXX,n,Dial(${MEMBER_DIAL},40,tT)
"""
import os
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


def log(msg):
    print(f'VERBOSE "[dial-member] {msg}" 1')
    sys.stdout.flush()
    sys.stdin.readline()


def main():
    consume_agi_env()
    ext = sys.argv[1] if len(sys.argv) > 1 else ''
    try:
        r = requests.get(f'{API_BASE}/api/pbx/ring-members/by-ext/{ext}',
                         headers={'X-PBX-Secret': PBX_SECRET}, timeout=5)
        if r.status_code == 200:
            m = r.json()
            target = f"PJSIP/{m['phone']}" if m.get('kind') == 'sip' else f"PJSIP/{m['phone']}@peoplefone"
            set_var('MEMBER_DIAL', target)
            log(f"{ext} -> {m.get('name')} ({target})")
        else:
            set_var('MEMBER_DIAL', '')
            log(f"{ext} nicht gefunden ({r.status_code})")
    except Exception as e:  # noqa: BLE001
        set_var('MEMBER_DIAL', '')
        log(f"Fehler: {e}")


if __name__ == '__main__':
    main()
