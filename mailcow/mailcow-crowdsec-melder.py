#!/usr/bin/env python3
"""Mailcow-Fehlanmeldungen an CrowdSec auf dem Edge melden (Mailcow CT 240).

Mailcows eigene Sperre (netfilter-mailcow) sperrt auf CT 240 selbst. Seit IMAPS
mit PROXY-Protokoll ueber edge-traefik laeuft, kommen die Pakete aber vom Edge;
eine Sperre auf CT 240 greift dann nicht. Gesperrt werden muss am Edge.

Der Melder liest denselben Redis-Kanal wie netfilter-mailcow (F2B_CHANNEL),
wendet dieselben Muster an (Dovecot-Login, Postfix-SASL, SOGo) und schickt je
Fehlanmeldung NUR die Client-IP per Syslog an den Edge:
    mail-melder: mail_auth_failed ip=<adresse> dienst=<imap|sasl|sogo>
Eigene Netze (privat, 100.64.0.0/10, Docker) werden nicht gemeldet.

Laeuft als systemd-Dienst mailcow-crowdsec-melder.service (Restart=always).
"""
import ipaddress
import os
import re
import socket
import subprocess
import sys
import time

MAILCOW = '/opt/mailcow-dockerized'
ZIEL = ('100.64.2.40', 4514)
HOST = socket.gethostname()

MUSTER = [
    # Dovecot 2.3 (Disconnected/Aborted login) und 2.4 (Login aborted)
    (re.compile(r'-login: (?:Disconnected|Aborted login|Login aborted).*?\((?:auth failed|tried to use disallowed)[^)]*\).*?rip=([0-9a-fA-F.:]+)'), 'imap'),
    (re.compile(r'warning: .*\[([0-9a-fA-F.:]+)\]: SASL .+ authentication failed(?!.*Connection lost to authentication server)'), 'sasl'),
    (re.compile(r"SOGo.* Login from '(?:[0-9a-fA-F.:]+, )*([0-9a-fA-F.:]+)' for user .+ might not have worked"), 'sogo'),
]
EIGENE = [ipaddress.ip_network(n) for n in (
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10',
    '127.0.0.0/8', '::1/128', 'fc00::/7', 'fe80::/10', '2a02:16a:1400::/48',
    '37.17.232.133/32')]


def redis_pass():
    for line in open(f'{MAILCOW}/mailcow.conf', encoding='utf-8'):
        if line.startswith('REDISPASS='):
            return line.split('=', 1)[1].strip()
    return ''


def melden(sock, ip, dienst):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return
    if any(a in n for n in EIGENE):
        return
    # RFC 5424, wie logger(1) es schickt (so liest CrowdSec es sicher)
    zeit = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    zeile = f'<13>1 {zeit} {HOST} mail-melder - - - mail_auth_failed ip={a} dienst={dienst}'
    sock.sendto(zeile.encode(), ZIEL)


def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    # Passwort ueber die Umgebung (REDISCLI_AUTH), nie als Argument: Argumente
    # stehen fuer jeden lokalen Nutzer in ps / /proc/<pid>/cmdline.
    env = dict(os.environ, REDISCLI_AUTH=redis_pass())
    cmd = ['docker', 'compose', 'exec', '-T', '-e', 'REDISCLI_AUTH', 'redis-mailcow',
           'redis-cli', 'SUBSCRIBE', 'F2B_CHANNEL']
    p = subprocess.Popen(cmd, cwd=MAILCOW, env=env, stdout=subprocess.PIPE, text=True, errors='replace')
    for zeile in p.stdout:
        for rx, dienst in MUSTER:
            m = rx.search(zeile)
            if m:
                melden(sock, m.group(1), dienst)
                break
    return p.wait() or 1


if __name__ == '__main__':
    sys.exit(main())
