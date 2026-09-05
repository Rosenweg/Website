#!/usr/bin/env python3
"""
PMG-Outbound-Usage-Tracker.

Liest periodisch die postfix-Logs (seit letztem Lauf), zaehlt erfolgreich
ausgelieferte Mails pro (sender_domain, jahr-monat) und schickt das Delta
an unsere API /api/isp/outbound-usage/ingest.

State wird in /var/lib/pmg-usage-tracker/state.json gehalten.
Config (URL + Secret) in /etc/default/pmg-usage-tracker.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error
from collections import defaultdict
from datetime import datetime, timezone, timedelta

STATE_FILE = '/var/lib/pmg-usage-tracker/state.json'
CONF_FILE = '/etc/default/pmg-usage-tracker'

def load_conf():
    conf = {}
    try:
        with open(CONF_FILE) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                conf[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return conf

def load_state():
    if os.path.exists(STATE_FILE):
        try:
            return json.load(open(STATE_FILE))
        except Exception:
            pass
    return {}

def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)

def parse_journal(since_iso):
    """Yield (timestamp_iso, queue_id, kind, payload) for relevant postfix log lines.

    kind = 'from' (with sender), or 'sent' (with recipient).
    Wir filtern hier explizit nur postfix/smtp[ — d.h. NICHT lmtp
    (das ist amavis-Inter-Hop) und NICHT smtpd/smtps (das sind Receiver,
    haben kein status=sent) — und nur Sends mit relay=...smtp2go...,
    denn nur die kosten Kontingent.
    """
    cmd = ['journalctl', '--since', since_iso, '--no-pager', '-o', 'short-iso']
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    # Timezone-Format: short-iso schreibt '+0000' ohne Doppelpunkt.
    ts_re = re.compile(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+\-]\d{4})')
    qmgr_re = re.compile(r'postfix/qmgr\[\d+\]: ([0-9A-F]{6,16}): from=<([^>]*)>')
    # Nur, was wirklich ueber SMTP2GO ging: relay=...smtp2go.... Alles andere —
    # der eigene Relay-VPS, Mailcow, interne Ziele — verbraucht kein Kontingent.
    # Bis 5.9.2026 zaehlte die Zeile jeden postfix/smtp-Send; der Zaehler stand
    # bei 199, waehrend SMTP2GO selbst 1 meldete.
    sent_re = re.compile(r'postfix/smtp\[\d+\]: ([0-9A-F]{6,16}):.*?relay=[^ ,]*smtp2go[^ ,]*.*?status=sent')
    for line in proc.stdout.splitlines():
        m = ts_re.match(line)
        ts = m.group(1) if m else None
        m = qmgr_re.search(line)
        if m:
            yield (ts, m.group(1), 'from', m.group(2).lower())
            continue
        m = sent_re.search(line)
        if m:
            yield (ts, m.group(1), 'sent', None)

def relay_status():
    """Zustand der Postfix-Warteschlange dieses Hosts: Gesamtzahl, aufgeschoben,
    aktiv, Alter des aeltesten Eintrags, letzte erfolgreiche Zustellung. Faellt
    still aus, wenn etwas fehlt — der Zaehler darf daran nicht scheitern."""
    st = {'host': os.uname().nodename.split('.')[0]}
    try:
        spool = '/var/spool/postfix'
        def zaehle(unter):
            n, aelt = 0, None
            for root, _d, files in os.walk(os.path.join(spool, unter)):
                for f in files:
                    n += 1
                    try:
                        m = os.stat(os.path.join(root, f)).st_mtime
                        aelt = m if aelt is None or m < aelt else aelt
                    except OSError:
                        pass
            return n, aelt
        d, d_alt = zaehle('deferred'); a, a_alt = zaehle('active'); i, i_alt = zaehle('incoming')
        st.update({'deferred': d, 'active': a + i, 'queue_total': d + a + i})
        aeltester = min([x for x in (d_alt, a_alt, i_alt) if x is not None], default=None)
        st['oldest_s'] = int(datetime.now(timezone.utc).timestamp() - aeltester) if aeltester else 0
        out = subprocess.run(['journalctl', '--since', '-2days', '--no-pager', '-o', 'short-iso',
                              '-g', 'postfix/smtp\\[.*status=sent'], capture_output=True, text=True, check=False).stdout
        letzte = [l[:24] for l in out.splitlines() if l[:4].isdigit()]
        st['last_sent_at'] = letzte[-1] if letzte else None
    except Exception as e:  # noqa: BLE001
        st['fehler'] = str(e)[:200]
    return st


def melde_status(api_url, secret):
    """Der Zustand geht an /api/isp/relay-status/ingest — die Adresse leitet
    sich aus der Ingest-URL des Zaehlers ab."""
    url = api_url.replace('/outbound-usage/ingest', '/relay-status/ingest')
    if url == api_url:
        return
    req = urllib.request.Request(url, data=json.dumps(relay_status()).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'X-Tracker-Secret': secret,
                                          'User-Agent': 'pmg-usage-tracker/1.1 (rosenweg)'})
    try:
        with urllib.request.urlopen(req, timeout=15):
            pass
    except Exception as e:  # noqa: BLE001
        print(f'WARN: relay-status nicht gemeldet: {e}', file=sys.stderr)


def main():
    conf = load_conf()
    api_url = conf.get('API_URL') or os.environ.get('API_URL')
    secret  = conf.get('TRACKER_SHARED_SECRET') or os.environ.get('TRACKER_SHARED_SECRET')
    if not api_url or not secret:
        print(f'ERR: API_URL und TRACKER_SHARED_SECRET muessen in {CONF_FILE} stehen', file=sys.stderr)
        sys.exit(1)

    melde_status(api_url, secret)
    state = load_state()
    last_run = state.get('last_run')
    if not last_run:
        last_run = datetime.now(timezone.utc) - timedelta(hours=1)
    else:
        # state hat ISO-Format, journalctl mag nur "YYYY-MM-DD HH:MM:SS"
        last_run = datetime.fromisoformat(last_run.replace('Z', '+00:00'))
    # Auf UTC normalisieren und im journalctl-Format formatieren.
    last_run = last_run.astimezone(timezone.utc)
    last_run = last_run.strftime('%Y-%m-%d %H:%M:%S UTC')

    qid_from = {}
    counts = defaultdict(int)
    for ts, qid, kind, payload in parse_journal(last_run):
        if kind == 'from':
            if payload and '@' in payload:
                qid_from[qid] = payload.split('@', 1)[1]
        elif kind == 'sent':
            dom = qid_from.get(qid)
            if not dom:
                continue
            ym = ts[:7] if ts else datetime.now(timezone.utc).strftime('%Y-%m')
            counts[(dom, ym)] += 1

    events = [{'sender_domain': d, 'year_month': ym, 'count_delta': c}
              for (d, ym), c in counts.items()]
    if events:
        body = json.dumps({'events': events}).encode()
        req = urllib.request.Request(
            api_url,
            data=body,
            headers={'Content-Type': 'application/json',
                     'X-Tracker-Secret': secret,
                     # CF blockt Default-Python-UA per Bot-Filter; eigener UA
                     'User-Agent': 'pmg-usage-tracker/1.1 (rosenweg)'},
            method='POST',
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                print(r.read().decode())
        except urllib.error.HTTPError as e:
            print(f'HTTP {e.code}: {e.read().decode()[:200]}', file=sys.stderr)
            sys.exit(2)
    else:
        print('no events to send')

    state['last_run'] = datetime.now(timezone.utc).isoformat()
    save_state(state)

if __name__ == '__main__':
    main()
