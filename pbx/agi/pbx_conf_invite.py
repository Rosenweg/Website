#!/usr/bin/env python3
"""
AGI-Script: Eroeffnet die Technik-Konferenz, indem es alle aktiven Ring-Member
in die ConfBridge 'technik' hineinwaehlt.

Aufruf im Dialplan (Extension 100):
  exten = 100,1,Answer()
  exten = 100,n,AGI(pbx_conf_invite.py)        ; holt Mitglieder, dialt sie rein
  exten = 100,n,ConfBridge(technik)            ; der Anrufer selbst joint auch

Mechanik: schreibt Asterisk-Call-Files (kein AMI noetig -> robust, auch wenn
AMI gerade nicht authentifiziert). Jede angenommene Verbindung landet im
Context conf-join und joint dieselbe ConfBridge 'technik'.
"""
import os
import re
import sys
import time

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
API_BASE   = os.environ.get('PBX_API_BASE')      or _envfile.get('PBX_API_BASE', 'http://127.0.0.1:8095')
PBX_SECRET = os.environ.get('PBX_SHARED_SECRET') or _envfile.get('PBX_SHARED_SECRET', '')

SPOOL_TMP = '/var/spool/asterisk/tmp'
SPOOL_OUT = '/var/spool/asterisk/outgoing'


def consume_agi_env():
    while True:
        if not sys.stdin.readline().rstrip('\r\n'):
            return


def agi_sauber(v, maxlen=60):
    """Wert fuer eine AGI-Befehlszeile: ohne Steuerzeichen (ein Zeilenumbruch
    waere ein zweiter AGI-Befehl, D-4), ohne Anfuehrungszeichen/Backslash, kurz."""
    v = re.sub(r'[\x00-\x1f\x7f"\\]', ' ', str(v or ''))
    return re.sub(r'\s+', ' ', v).strip()[:maxlen]


def log(msg):
    # Meldung enthaelt API-Namen/Fehlertexte -> bereinigen (R2-Dd).
    print(f'VERBOSE "[conf-invite] {agi_sauber(msg, 200)}" 1')
    sys.stdout.flush()
    sys.stdin.readline()


def dial_target(m):
    # Ziel landet in einem Call-File (zeilenweise): nur Nummer bzw. SIP-Name (D-5).
    phone = str(m.get('phone') or '')
    if m.get('kind') == 'sip':
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', phone):
            raise ValueError('ungueltige SIP-Extension')
        return f"PJSIP/{phone}"
    if m.get('kind') == 'person':   # persoenliche Nummer: alle Geraete der Person (ohne Voicemail)
        if not re.fullmatch(r'3[0-9]{5}', phone):
            raise ValueError('ungueltige persoenliche Nummer')
        return f"Local/{phone}@ring-person/n"
    if not re.fullmatch(r'\+?[0-9]{3,20}', phone):
        raise ValueError('ungueltige Telefonnummer')
    return f"PJSIP/{phone}@peoplefone"


def write_call_file(idx, target, name, room):
    os.makedirs(SPOOL_TMP, exist_ok=True)
    content = (
        f"Channel: {target}\n"
        "CallerID: Technik-Konferenz <100>\n"
        "MaxRetries: 0\n"
        "WaitTime: 30\n"
        "Context: conf-join\n"
        "Extension: s\n"
        "Priority: 1\n"
        f"Setvar: CONF_ROOM={room}\n"
    )
    tmp = os.path.join(SPOOL_TMP, f"conf-{int(time.time())}-{idx}.call")
    with open(tmp, 'w') as f:
        f.write(content)
    # Atomar in den outgoing-Spool verschieben -> Asterisk dialt.
    os.rename(tmp, os.path.join(SPOOL_OUT, os.path.basename(tmp)))
    log(f"einladen: {re.sub(r'[^A-Za-z0-9 ._-]', ' ', str(name))[:60]} ({target}) -> {room}")


def main():
    consume_agi_env()
    # Arg 1 = exclude (Telefon/Extension, das schon in der Konferenz ist -> nicht
    #          nochmal anrufen). Arg 2 = Konferenzraum (default 'technik').
    exclude = sys.argv[1].strip() if len(sys.argv) > 1 and sys.argv[1].strip() else None
    room = sys.argv[2].strip() if len(sys.argv) > 2 and sys.argv[2].strip() else 'technik'
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', room):
        room = 'technik'
    try:
        r = requests.get(f'{API_BASE}/api/pbx/conference/members',
                         headers={'X-PBX-Secret': PBX_SECRET}, timeout=5)
        members = r.json().get('members', []) if r.ok else []
    except Exception as e:  # noqa: BLE001
        log(f'API-Fehler: {e}')
        members = []
    if not members:
        log('Keine aktiven Mitglieder zum Einladen')
        return
    for idx, m in enumerate(members):
        if exclude and str(m.get('phone', '')).lstrip('+') == exclude.lstrip('+'):
            log(f"ueberspringe {m.get('name')} (bereits in Konferenz)")
            continue
        try:
            write_call_file(idx, dial_target(m), m.get('name', '?'), room)
        except Exception as e:  # noqa: BLE001
            log(f"Call-File-Fehler fuer {m.get('name')}: {e}")


if __name__ == '__main__':
    main()
