#!/usr/bin/env python3
"""
Rosenweg Syslog Collector — FPÜV Compliance
Receives syslog messages from UDM-Pro SIEM integration,
parses firewall/NAT/WiFi events, and stores them in PostgreSQL.
"""

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
DB_PASSWORD = os.environ.get('DB_PASSWORD', 'RwDb2026')
DB_NAME = os.environ.get('DB_NAME', 'rosenweg')
BATCH_SIZE = int(os.environ.get('BATCH_SIZE', '50'))
FLUSH_INTERVAL = int(os.environ.get('FLUSH_INTERVAL', '10'))  # seconds

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
# Firewall/NAT log: [UFW] or iptables format
RE_FIREWALL = re.compile(
    r'(?P<action>ALLOW|BLOCK|DROP|REJECT)\s+'
    r'IN=(?P<iface>\S*)\s+'
    r'.*?SRC=(?P<src_ip>\d+\.\d+\.\d+\.\d+)\s+'
    r'DST=(?P<dst_ip>\d+\.\d+\.\d+\.\d+)\s+'
    r'.*?PROTO=(?P<proto>\w+)'
    r'(?:.*?SPT=(?P<src_port>\d+))?'
    r'(?:.*?DPT=(?P<dst_port>\d+))?'
    r'(?:.*?MAC=(?P<mac>[0-9a-f:]+))?'
)

# WiFi associate/disassociate
RE_WIFI_ASSOC = re.compile(
    r'hostapd.*STA\s+(?P<mac>[0-9a-f:]{17}).*(?P<event>associated|disassociated)'
)

# DHCP lease
RE_DHCP = re.compile(
    r'dnsmasq-dhcp.*DHCPACK\((?P<iface>\S+)\)\s+(?P<ip>\d+\.\d+\.\d+\.\d+)\s+(?P<mac>[0-9a-f:]{17})\s*(?P<hostname>\S*)'
)

# conntrack/NAT new connection (if UDM logs these)
RE_CONNTRACK = re.compile(
    r'conntrack.*NEW.*src=(?P<src_ip>\d+\.\d+\.\d+\.\d+).*dst=(?P<dst_ip>\d+\.\d+\.\d+\.\d+).*sport=(?P<src_port>\d+).*dport=(?P<dst_port>\d+)'
)

# Buffer for batch inserts
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
    msg = data.decode('utf-8', errors='replace').strip()
    now = datetime.now(timezone.utc)

    # Try firewall/NAT log
    m = RE_FIREWALL.search(msg)
    if m:
        src_ip = m.group('src_ip')
        vlan, network = ip_to_vlan(src_ip)
        # Skip internal-only traffic (both src and dst in 100.64.x.x)
        dst_ip = m.group('dst_ip')
        if src_ip.startswith('100.64.') and dst_ip.startswith('100.64.'):
            return None  # Internal traffic, skip
        return {
            'timestamp': now, 'event_type': 'firewall',
            'source': 'syslog', 'mac': m.group('mac'),
            'ip': src_ip, 'dst_ip': dst_ip,
            'src_port': int(m.group('src_port')) if m.group('src_port') else None,
            'dst_port': int(m.group('dst_port')) if m.group('dst_port') else None,
            'proto': m.group('proto'),
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
    m = RE_CONNTRACK.search(msg)
    if m:
        src_ip = m.group('src_ip')
        dst_ip = m.group('dst_ip')
        if src_ip.startswith('100.64.') and dst_ip.startswith('100.64.'):
            return None
        vlan, network = ip_to_vlan(src_ip)
        return {
            'timestamp': now, 'event_type': 'nat',
            'source': 'syslog', 'ip': src_ip, 'dst_ip': dst_ip,
            'src_port': int(m.group('src_port')),
            'dst_port': int(m.group('dst_port')),
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


def main():
    global running

    print(f'[Syslog] Starting collector on UDP port {SYSLOG_PORT}', flush=True)
    print(f'[Syslog] DB: {DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME}', flush=True)

    # Create UDP socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(('0.0.0.0', SYSLOG_PORT))
    sock.settimeout(1.0)

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
        try:
            data, addr = sock.recvfrom(65535)
            stats['received'] += 1

            event = parse_syslog(data)
            if event:
                with buffer_lock:
                    event_buffer.append(event)
                stats['parsed'] += 1
            else:
                stats['skipped'] += 1
                # Log first 10 unparsed messages for debugging
                if stats['skipped'] <= 10:
                    msg = data.decode('utf-8', errors='replace').strip()
                    print(f'[Syslog] UNPARSED: {msg[:300]}', flush=True)

            # Print stats every 60s
            if time.time() - last_stats > 60:
                print(f"[Syslog] Stats: {stats['received']} received, {stats['parsed']} parsed, {stats['skipped']} skipped", flush=True)
                last_stats = time.time()

        except socket.timeout:
            continue
        except Exception as e:
            if running:
                print(f'[Syslog] Error: {e}', flush=True)

    # Final flush
    conn = get_db_connection()
    flush_buffer(conn)
    conn.close()
    sock.close()
    print('[Syslog] Stopped.', flush=True)


if __name__ == '__main__':
    main()
