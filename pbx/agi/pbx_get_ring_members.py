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
    except (FileNotFoundError, PermissionError, OSError): pass
    return env
_envfile = _load_env_file()
API_BASE   = os.environ.get('PBX_API_BASE')      or _envfile.get('PBX_API_BASE', 'http://127.0.0.1:8095')
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

def dial_target(m):
    """kind=sip -> direkt registriertes Endpoint; sonst ueber peoplefone-Trunk."""
    if m.get('kind') == 'sip':
        return f"PJSIP/{m['phone']}"
    return f"PJSIP/{m['phone']}@peoplefone"


def main():
    consume_agi_env()
    # Arg 1 = IS_OPEN (vom Dialplan). Ausserhalb der Geschaeftszeit liefert die
    # API nur Mitglieder mit bypass_hours=1 ("klingelt immer").
    is_open = '1'
    if len(sys.argv) > 1 and sys.argv[1] in ('0', '1'):
        is_open = sys.argv[1]
    try:
        r = requests.get(
            f'{API_BASE}/api/pbx/ring-members/active',
            params={'open': is_open},
            headers={'X-PBX-Secret': PBX_SECRET},
            timeout=5,
        )
        if not r.ok:
            log(f'API HTTP {r.status_code}')
            set_var('RING_LEVELS', '0')
            return
        members = r.json().get('members', [])
    except Exception as e:
        log(f'API-Fehler: {e}')
        set_var('RING_LEVELS', '0')
        return

    if not members:
        log(f'Keine aktiven Members (open={is_open})')
        set_var('RING_LEVELS', '0')
        return

    # Gruppiere Members nach priority. Gleiche Prio = parallel, unterschiedliche = sequenziell.
    by_prio = {}
    for m in members:
        by_prio.setdefault(int(m.get('priority', 100)), []).append(m)

    # Sortiere Levels: kleinste Prio zuerst. Max 4 Levels.
    levels = sorted(by_prio.keys())[:4]
    set_var('RING_LEVELS', str(len(levels)))
    for idx, prio in enumerate(levels, start=1):
        ms = by_prio[prio]
        dial_str = '&'.join(dial_target(m) for m in ms)
        set_var(f'RING_DIAL_{idx}', dial_str)
        log(f"Level {idx} (Prio {prio}): {', '.join(m['name'] for m in ms)}")

if __name__ == '__main__':
    main()
