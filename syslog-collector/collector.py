#!/usr/bin/env python3
"""
Rosenweg Syslog Collector — FPÜV Compliance
Receives syslog messages from UDM-Pro SIEM integration,
parses firewall/NAT/WiFi events, and stores them in PostgreSQL.
"""

import json
import os
import re
import socket
import signal
import sys
import time
import threading
from datetime import datetime, timezone

import psycopg2
from psycopg2.extras import execute_values

# Config
SYSLOG_PORT = int(os.environ.get('SYSLOG_PORT', '5514'))
DB_HOST = os.environ.get('DB_HOST', 'postgres')
DB_PORT = int(os.environ.get('DB_PORT', '5432'))
DB_USER = os.environ.get('DB_USER', 'rosenweg')
DB_PASSWORD = os.environ.get('DB_PASSWORD', '')
DB_NAME = os.environ.get('DB_NAME', 'rosenweg')
BATCH_SIZE = int(os.environ.get('BATCH_SIZE', '50'))
FLUSH_INTERVAL = int(os.environ.get('FLUSH_INTERVAL', '10'))  # seconds
# Quellfilter (D-8): Komma-Liste erlaubter Absender-IPs (exakt, oder Praefix mit
# abschliessendem "." / ":"), z. B. die UDM. Leer = alle (Warnung beim Start).
# Wirkt nur, wenn der Port die echte Quell-IP sieht (Swarm-Ingress maskiert sie;
# dort Port im mode: host veroeffentlichen).
ALLOWED_SOURCES = [x.strip().lower() for x in os.environ.get('SYSLOG_ALLOWED_SOURCES', '').split(',') if x.strip()]
MAX_TCP_CLIENTS = int(os.environ.get('SYSLOG_MAX_TCP_CLIENTS', '20'))
MAX_LINE_BYTES = 65536  # TCP-Zeile ohne Zeilenende -> Verbindung schliessen statt endlos puffern
# Untaetige TCP-Verbindung schliessen (R2-Db): sonst belegen 20 stille Verbindungen
# alle Slots dauerhaft. Echte Sender verbinden sich bei Bedarf neu.
# 600 s statt 60 s (R3-Df): ruhige Dauer-TCP-Sender (rsyslog/UniFi) sollen
# nicht staendig getrennt werden; gegen Slot-Belegung reicht das weiterhin.
TCP_IDLE_TIMEOUT = float(os.environ.get('SYSLOG_TCP_IDLE_TIMEOUT', '600'))


def source_allowed(ip):
    if not ALLOWED_SOURCES:
        return True
    ip = str(ip or '').lower()
    if ip.startswith('::ffff:'):
        ip = ip[7:]
    return any(ip.startswith(e) if e.endswith(('.', ':')) else ip == e for e in ALLOWED_SOURCES)

# VLAN → Network name mapping (populated from DB or hardcoded)
VLAN_NETWORKS = {
    2: 'RK-Dienste', 3: 'RK-Technik', 8: 'Rosenweg-Guest', 9: 'RK-Clients',
    19: 'RW1-Clients', 20: 'RW2-Technik', 29: 'RW2-Clients',
    49: 'RW4-Clients', 59: 'RW5-Clients', 69: 'RW6-Clients',
    89: 'RW8-Clients', 90: 'RW9-Technik', 91: 'RW9-Dienste',
    92: 'RW9-Kameras', 99: 'RW9-Clients',
    109: 'RW10-Clients', 129: 'RW12-Clients', 139: 'RW13-Clients',
    149: 'RW14-Clients', 169: 'RW16-Clients', 179: 'RW17-Clients',
    189: 'RW18-Clients',
}

# Regex patterns for UDM syslog messages
#
# D-4-1: Die frueheren Ein-Regex-Muster mit mehreren verketteten .*? / .*
# (RE_FIREWALL, RE_CONNTRACK) liefen bei gezielt gebauten Zeilen in
# polynomielles Backtracking (7 KB -> 83 s); ein einziges UDP-Paket legte den
# Collector lahm. Jetzt: Nachricht auf MAX_MSG_CHARS kuerzen und die Felder
# einzeln und in fester Reihenfolge suchen. Die Ergebnisse entsprechen den
# alten Mustern (inkl. "." ohne Zeilenumbruch, lazy = erstes / greedy =
# letztes Vorkommen).
MAX_MSG_CHARS = 2048

# Firewall/NAT log: [UFW ALLOW/BLOCK] or iptables format
FW_ANKER = re.compile(r'(?:\[UFW\s+)?(?P<action>ALLOW|BLOCK|DROP|REJECT)\]?\s*IN=(?P<iface>\S*)\s+')
FW_SRCDST = re.compile(r'SRC=(?P<src_ip>\d+\.\d+\.\d+\.\d+)\s+DST=(?P<dst_ip>\d+\.\d+\.\d+\.\d+)\s+')
FW_PROTO = re.compile(r'PROTO=(?P<v>\w+)')
FW_SPT = re.compile(r'SPT=(?P<v>\d+)')
FW_DPT = re.compile(r'DPT=(?P<v>\d+)')
FW_MAC = re.compile(r'MAC=(?P<v>[0-9a-f:]+)')


def _naechstes(muster, msg, pos):
    """Wie '.*?MUSTER' ab pos: erstes Vorkommen, das vor dem naechsten
    Zeilenumbruch beginnt ('.' matcht kein \\n). Linear."""
    nl = msg.find('\n', pos)
    m = muster.search(msg, pos)
    if m and (nl < 0 or m.start() <= nl):
        return m
    return None


def match_firewall(msg):
    """Ersatz fuer RE_FIREWALL.search(msg): dict der Gruppen oder None."""
    for anker in FW_ANKER.finditer(msg):
        sd = _naechstes(FW_SRCDST, msg, anker.end())
        if not sd:
            continue
        pr = _naechstes(FW_PROTO, msg, sd.end())
        if not pr:
            continue
        g = {'action': anker.group('action'), 'iface': anker.group('iface'),
             'src_ip': sd.group('src_ip'), 'dst_ip': sd.group('dst_ip'),
             'proto': pr.group('v'), 'src_port': None, 'dst_port': None, 'mac': None}
        pos = pr.end()
        for name, muster in (('src_port', FW_SPT), ('dst_port', FW_DPT), ('mac', FW_MAC)):
            m = _naechstes(muster, msg, pos)
            if m:
                g[name] = m.group('v')
                pos = m.end()
        return g
    return None


# WiFi associate/disassociate
RE_WIFI_ASSOC = re.compile(
    r'hostapd.*STA\s+(?P<mac>[0-9a-f:]{17}).*(?P<event>associated|disassociated)'
)

# DHCP lease
RE_DHCP = re.compile(
    r'dnsmasq-dhcp.*DHCPACK\((?P<iface>\S+)\)\s+(?P<ip>\d+\.\d+\.\d+\.\d+)\s+(?P<mac>[0-9a-f:]{17})\s*(?P<hostname>\S*)'
)

# conntrack/NAT new connection (if UDM logs these)
# Frueher: conntrack.*NEW.*src=IP.*dst=IP.*sport=N.*dport=N (greedy) — also
# innerhalb einer Zeile jeweils das LETZTE passende Vorkommen. Hier rueckwaerts
# ab dem letzten dport= ermittelt.
CT_SRC = re.compile(r'src=(\d+\.\d+\.\d+\.\d+)')
CT_DST = re.compile(r'dst=(\d+\.\d+\.\d+\.\d+)')
CT_SPORT = re.compile(r'sport=(\d+)')
CT_DPORT = re.compile(r'dport=(\d+)')


def _letztes(muster, zeile, start, ende):
    """Letztes Vorkommen von muster mit start <= Beginn und Ende <= ende."""
    best = None
    for m in muster.finditer(zeile, start):
        if m.start() >= ende:
            break
        if m.end() <= ende:
            best = m
    return best


def match_conntrack(msg):
    """Ersatz fuer RE_CONNTRACK.search(msg): dict der Gruppen oder None."""
    for zeile in msg.split('\n'):
        c = zeile.find('conntrack')
        if c < 0:
            continue
        c += len('conntrack')
        dp = _letztes(CT_DPORT, zeile, c, len(zeile))
        if not dp:
            continue
        sp = _letztes(CT_SPORT, zeile, c, dp.start())
        if not sp:
            continue
        ds = _letztes(CT_DST, zeile, c, sp.start())
        if not ds:
            continue
        sr = _letztes(CT_SRC, zeile, c, ds.start())
        if not sr:
            continue
        neu = zeile.find('NEW', c)
        if neu < 0 or neu + 3 > sr.start():
            continue
        return {'src_ip': sr.group(1), 'dst_ip': ds.group(1),
                'src_port': sp.group(1), 'dst_port': dp.group(1)}
    return None

# Buffer for batch inserts (max 10000 to prevent OOM on bursts)
MAX_BUFFER_SIZE = 10000
event_buffer = []
buffer_lock = threading.Lock()
running = True


def get_db_connection():
    """Create a new database connection."""
    for attempt in range(5):
        try:
            conn = psycopg2.connect(
                host=DB_HOST, port=DB_PORT,
                user=DB_USER, password=DB_PASSWORD,
                dbname=DB_NAME,
            )
            conn.autocommit = True
            return conn
        except psycopg2.OperationalError as e:
            print(f'DB connection attempt {attempt+1} failed: {e}', flush=True)
            time.sleep(5)
    print('Could not connect to database, exiting.', flush=True)
    sys.exit(1)


def ip_to_vlan(ip):
    """Guess VLAN from IP address (100.64.X.Y → VLAN X)."""
    if not ip:
        return None, None
    m = re.match(r'100\.64\.(\d+)\.\d+', ip)
    if m:
        vlan = int(m.group(1))
        return vlan, VLAN_NETWORKS.get(vlan)
    return None, None


def parse_syslog(data):
    """Parse a syslog message and return event dict or None."""
    # Kuerzen vor jeder Regex (D-4-1): UDM-Zeilen sind deutlich kuerzer
    msg = data[:MAX_MSG_CHARS * 4].decode('utf-8', errors='replace').strip()[:MAX_MSG_CHARS]
    now = datetime.now(timezone.utc)

    # Try firewall/NAT log
    m = match_firewall(msg)
    if m:
        src_ip = m['src_ip']
        vlan, network = ip_to_vlan(src_ip)
        # Skip internal-only traffic (both src and dst in 100.64.x.x)
        dst_ip = m['dst_ip']
        if src_ip.startswith('100.64.') and dst_ip.startswith('100.64.'):
            return None  # Internal traffic, skip
        return {
            'timestamp': now, 'event_type': 'firewall',
            'source': 'syslog', 'mac': m['mac'],
            'ip': src_ip, 'dst_ip': dst_ip,
            'src_port': int(m['src_port']) if m['src_port'] else None,
            'dst_port': int(m['dst_port']) if m['dst_port'] else None,
            'proto': m['proto'],
            'network_name': network, 'vlan': vlan,
            'raw_message': msg[:500],
        }

    # Try WiFi associate/disassociate
    m = RE_WIFI_ASSOC.search(msg)
    if m:
        event = 'connect' if 'associated' == m.group('event') else 'disconnect'
        return {
            'timestamp': now, 'event_type': event,
            'source': 'syslog', 'mac': m.group('mac'),
            'raw_message': msg[:500],
        }

    # Try DHCP
    m = RE_DHCP.search(msg)
    if m:
        ip = m.group('ip')
        vlan, network = ip_to_vlan(ip)
        return {
            'timestamp': now, 'event_type': 'dhcp',
            'source': 'syslog', 'mac': m.group('mac'),
            'ip': ip, 'hostname': m.group('hostname') or None,
            'network_name': network, 'vlan': vlan,
            'raw_message': msg[:500],
        }

    # Try conntrack
    m = match_conntrack(msg)
    if m:
        src_ip = m['src_ip']
        dst_ip = m['dst_ip']
        if src_ip.startswith('100.64.') and dst_ip.startswith('100.64.'):
            return None
        vlan, network = ip_to_vlan(src_ip)
        return {
            'timestamp': now, 'event_type': 'nat',
            'source': 'syslog', 'ip': src_ip, 'dst_ip': dst_ip,
            'src_port': int(m['src_port']),
            'dst_port': int(m['dst_port']),
            'network_name': network, 'vlan': vlan,
            'raw_message': msg[:500],
        }

    return None


def flush_buffer(conn):
    """Write buffered events to database."""
    global event_buffer
    with buffer_lock:
        if not event_buffer:
            return
        batch = event_buffer[:]
        event_buffer = []

    cols = [
        'timestamp', 'event_type', 'source', 'mac', 'ip', 'hostname',
        'network_name', 'vlan', 'ap_name', 'ap_mac', 'is_wired',
        'signal_dbm', 'rx_bytes', 'tx_bytes',
        'dst_ip', 'dst_port', 'src_port', 'proto', 'raw_message',
    ]

    values = []
    for e in batch:
        values.append(tuple(e.get(c) for c in cols))

    try:
        execute_values(
            conn.cursor(),
            f"INSERT INTO connection_log ({','.join(cols)}) VALUES %s",
            values,
            template='(' + ','.join(['%s'] * len(cols)) + ')',
        )
        print(f'[Syslog] Flushed {len(batch)} events', flush=True)
    except Exception as ex:
        print(f'[Syslog] DB write error: {ex}', flush=True)
        # Re-queue failed events (up to buffer limit)
        with buffer_lock:
            remaining = MAX_BUFFER_SIZE - len(event_buffer)
            if remaining > 0:
                event_buffer.extend(batch[:remaining])
        # Reconnect on next flush
        try:
            conn.close()
        except:
            pass


def flush_loop(conn_factory):
    """Periodically flush the event buffer."""
    conn = conn_factory()
    while running:
        time.sleep(FLUSH_INTERVAL)
        try:
            flush_buffer(conn)
        except Exception as e:
            print(f'[Syslog] Flush error: {e}', flush=True)
            try:
                conn.close()
            except:
                pass
            conn = conn_factory()


def parse_json_event(msg):
    """Parse JSON-formatted SIEM event from UniFi."""
    try:
        data = json.loads(msg)
    except (json.JSONDecodeError, ValueError):
        return None

    now = datetime.now(timezone.utc)
    event_type = None
    result = {'timestamp': now, 'source': 'syslog', 'raw_message': msg[:500]}

    # UniFi SIEM JSON format varies — extract what we can
    src_ip = data.get('src_ip') or data.get('srcip') or data.get('inner_alert_action', {}).get('src_ip')
    dst_ip = data.get('dest_ip') or data.get('dstip') or data.get('dst_ip')
    src_port = data.get('src_port') or data.get('srcport')
    dst_port = data.get('dest_port') or data.get('dstport') or data.get('dst_port')
    proto = data.get('proto') or data.get('protocol')
    mac = data.get('mac') or data.get('src_mac')
    hostname = data.get('hostname') or data.get('host')
    action = data.get('action') or data.get('event_type') or data.get('key', '')
    ip = data.get('ip') or src_ip

    # Determine event type
    key = str(data.get('key', data.get('event_type', data.get('_type', '')))).lower()
    if any(k in key for k in ['fw', 'firewall', 'ips', 'threat', 'anomaly']):
        event_type = 'firewall'
    elif any(k in key for k in ['sta_connect', 'assoc', 'wifi', 'client']):
        event_type = 'connect' if 'disconnect' not in key else 'disconnect'
    elif 'dhcp' in key:
        event_type = 'dhcp'
    elif src_ip and dst_ip:
        event_type = 'traffic'
    else:
        event_type = 'siem'

    # Skip internal-only traffic
    if src_ip and dst_ip:
        if str(src_ip).startswith('100.64.') and str(dst_ip).startswith('100.64.'):
            return None

    if ip:
        vlan, network = ip_to_vlan(str(ip))
        result['vlan'] = vlan
        result['network_name'] = network

    result.update({
        'event_type': event_type,
        'mac': str(mac)[:17] if mac else None,
        'ip': str(ip) if ip else (str(src_ip) if src_ip else None),
        'hostname': str(hostname) if hostname else None,
        'dst_ip': str(dst_ip) if dst_ip else None,
        'src_port': int(src_port) if src_port else None,
        'dst_port': int(dst_port) if dst_port else None,
        'proto': str(proto).upper()[:10] if proto else None,
    })
    return result


def handle_message(data, stats):
    """Parse a received message (syslog or JSON)."""
    msg = data.decode('utf-8', errors='replace').strip()

    # Try JSON first (SIEM format)
    event = parse_json_event(msg)
    if event:
        return event

    # Try classic syslog
    event = parse_syslog(data)
    if event:
        return event

    # Unparsed
    if stats['skipped'] <= 20:
        print(f'[Syslog] UNPARSED: {msg[:300]}', flush=True)
    return None


def handle_tcp_client(conn, addr, stats):
    """Handle a TCP connection (one or more newline-delimited messages)."""
    buf = b''
    conn.settimeout(5.0)
    letzte_daten = time.monotonic()
    try:
        while running:
            try:
                chunk = conn.recv(65535)
                if not chunk:
                    break
                letzte_daten = time.monotonic()
                buf += chunk
                if b'\n' not in buf and len(buf) > MAX_LINE_BYTES:
                    print(f'[Syslog] TCP {addr[0]}: Zeile zu lang, Verbindung geschlossen', flush=True)
                    break
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    if line.strip():
                        stats['received'] += 1
                        event = handle_message(line, stats)
                        if event:
                            with buffer_lock:
                                if len(event_buffer) < MAX_BUFFER_SIZE:
                                    event_buffer.append(event)
                            stats['parsed'] += 1
                        else:
                            stats['skipped'] += 1
            except socket.timeout:
                if time.monotonic() - letzte_daten > TCP_IDLE_TIMEOUT:
                    break
                continue
    except Exception as e:
        if running:
            print(f'[Syslog] TCP client error: {e}', flush=True)
    finally:
        conn.close()
        tcp_slots.release()


# Begrenzt gleichzeitige TCP-Verbindungen (je eine Thread) — sonst beliebig viele.
tcp_slots = threading.BoundedSemaphore(MAX_TCP_CLIENTS)


def main():
    global running

    print(f'[Syslog] Starting collector on UDP+TCP port {SYSLOG_PORT}', flush=True)
    print(f'[Syslog] DB: {DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME}', flush=True)
    if not ALLOWED_SOURCES:
        print('[Syslog] WARNUNG: SYSLOG_ALLOWED_SOURCES nicht gesetzt — jede Quelle darf einliefern', flush=True)

    # Create UDP socket
    udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    udp_sock.bind(('0.0.0.0', SYSLOG_PORT))
    udp_sock.settimeout(1.0)

    # Create TCP socket
    tcp_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    tcp_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    tcp_sock.bind(('0.0.0.0', SYSLOG_PORT))
    tcp_sock.listen(5)
    tcp_sock.settimeout(1.0)

    # Start flush thread
    flush_thread = threading.Thread(target=flush_loop, args=(get_db_connection,), daemon=True)
    flush_thread.start()

    # Signal handler
    def shutdown(sig, frame):
        global running
        print(f'[Syslog] Shutting down...', flush=True)
        running = False

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    stats = {'received': 0, 'parsed': 0, 'skipped': 0}
    last_stats = time.time()

    while running:
        # UDP
        try:
            data, addr = udp_sock.recvfrom(65535)
            if not source_allowed(addr[0]):
                continue
            stats['received'] += 1
            event = handle_message(data, stats)
            if event:
                with buffer_lock:
                    # Obergrenze wie bei TCP: bei DB-Ausfall nicht unbegrenzt wachsen.
                    if len(event_buffer) < MAX_BUFFER_SIZE:
                        event_buffer.append(event)
                stats['parsed'] += 1
            else:
                stats['skipped'] += 1
        except socket.timeout:
            pass
        except Exception as e:
            if running:
                print(f'[Syslog] UDP error: {e}', flush=True)

        # TCP — accept new connections
        try:
            conn, addr = tcp_sock.accept()
            if not source_allowed(addr[0]):
                conn.close()
                continue
            if not tcp_slots.acquire(blocking=False):
                conn.close()
                continue
            print(f'[Syslog] TCP connection from {addr[0]}', flush=True)
            t = threading.Thread(target=handle_tcp_client, args=(conn, addr, stats), daemon=True)
            t.start()
        except socket.timeout:
            pass
        except Exception as e:
            if running:
                print(f'[Syslog] TCP accept error: {e}', flush=True)

        # Stats
        if time.time() - last_stats > 60:
            print(f"[Syslog] Stats: {stats['received']} received, {stats['parsed']} parsed, {stats['skipped']} skipped", flush=True)
            last_stats = time.time()

    # Final flush
    conn = get_db_connection()
    flush_buffer(conn)
    conn.close()
    udp_sock.close()
    tcp_sock.close()
    print('[Syslog] Stopped.', flush=True)


if __name__ == '__main__':
    main()
