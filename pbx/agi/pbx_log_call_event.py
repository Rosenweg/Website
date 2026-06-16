#!/usr/bin/env python3
"""
AGI-Script: Postet Call-Events an die Rosenweg-API.

Aufruf im Dialplan:
  AGI(pbx_log_call_event.py,start,${CALLERID(num)},${EXTEN},${UNIQUEID})
  AGI(pbx_log_call_event.py,answer,${DIALEDPEERNUMBER})
  AGI(pbx_log_call_event.py,end,${DIALSTATUS})

Erstes Argument ist Event-Typ (start|answer|end). Weitere Args je nach Event.
"""
import os
import sys

try: import requests
except ImportError: sys.exit(0)

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

# AGI-Env-Header aus stdin lesen (Asterisk sendet das vor unseren Commands)
agi_vars = {}
def consume_agi_env():
    while True:
        line = sys.stdin.readline().rstrip('\r\n')
        if not line: return
        if line.startswith('agi_'):
            k, _, v = line.partition(':')
            agi_vars[k.strip()] = v.strip()

def log(msg):
    print(f'VERBOSE "[call-event] {msg}" 1'); sys.stdout.flush(); sys.stdin.readline()

def main():
    consume_agi_env()
    args = sys.argv[1:]
    if not args:
        log('Kein Event-Type'); return
    event = args[0]
    uniqueid = agi_vars.get('agi_uniqueid', '')

    payload = { 'event': event, 'uniqueid': uniqueid }
    if event == 'start':
        payload['direction'] = 'inbound'
        payload['caller_id'] = agi_vars.get('agi_callerid') or (args[1] if len(args) > 1 else '')
        payload['dialed']    = agi_vars.get('agi_extension') or (args[2] if len(args) > 2 else '')
    elif event == 'answer':
        payload['answered_by'] = args[1] if len(args) > 1 else ''
    elif event == 'end':
        payload['hangup_cause'] = args[1] if len(args) > 1 else 'UNKNOWN'
    elif event == 'cdr':
        # Hangup-Handler: komplettes CDR (ausgehend/intern). args[1] = ^-getrennt:
        #   src ^ dst ^ disposition ^ billsec ^ start ^ uniqueid
        parts = ((args[1] if len(args) > 1 else '').split('^') + [''] * 6)[:6]
        src, dst, disp, billsec, start, cdr_uid = parts
        dst_digits = ''.join(c for c in dst if c.isdigit())
        outbound = dst.startswith('+') or dst.startswith('00') or (dst.startswith('0') and len(dst_digits) >= 10)
        payload.update({
            'uniqueid': cdr_uid or uniqueid,
            'direction': 'outbound' if outbound else 'internal',
            'caller_id': src,
            'dialed': dst,
            'hangup_cause': disp,
            'duration_seconds': int(billsec) if billsec.isdigit() else None,
            'started_at': start or None,
        })

    try:
        r = requests.post(f'{API_BASE}/api/pbx/call-event',
                          headers={'X-PBX-Secret': PBX_SECRET, 'Content-Type': 'application/json'},
                          json=payload, timeout=3)
        log(f"{event} → {r.status_code}")
    except Exception as e:
        log(f'Fehler: {e}')

if __name__ == '__main__': main()
