#!/usr/bin/env python3
"""PMG: SASL-Fehlanmeldungen (Submission 587, SMTPS 465/10465) an CrowdSec melden.

Folgt /var/log/mail.log und schickt je Fehlanmeldung NUR die Client-IP per
Syslog an den Edge (100.64.2.40:4514), im selben Format wie der Mailcow-Melder:
    mail-melder: mail_auth_failed ip=<adresse> dienst=sasl
Edge: Parser rosenweg/mail-melder, Szenario rosenweg/mail-bf.
Eigene Netze werden nicht gemeldet. Dienst: pmg-crowdsec-melder.service.
"""
import ipaddress
import re
import socket
import subprocess
import sys
import time

LOG = '/var/log/mail.log'
ZIEL = ('100.64.2.40', 4514)
HOST = socket.gethostname()
SASL = re.compile(r'warning: .*\[([0-9a-fA-F.:]+)\]: SASL \S+ authentication failed(?!.*Connection lost to authentication server)')
EIGENE = [ipaddress.ip_network(n) for n in (
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10',
    '127.0.0.0/8', '::1/128', 'fc00::/7', 'fe80::/10', '2a02:16a:1400::/48',
    '37.17.232.133/32', '37.17.232.136/32')]


def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    # tail -F folgt auch nach logrotate der neuen Datei; -n0 = nur Neues
    p = subprocess.Popen(['tail', '-F', '-n0', LOG], stdout=subprocess.PIPE, text=True, errors='replace')
    for zeile in p.stdout:
        m = SASL.search(zeile)
        if not m:
            continue
        try:
            a = ipaddress.ip_address(m.group(1))
        except ValueError:
            continue
        if any(a in n for n in EIGENE):
            continue
        zeit = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        sock.sendto(f'<13>1 {zeit} {HOST} mail-melder - - - mail_auth_failed ip={a} dienst=sasl'.encode(), ZIEL)
    return p.wait() or 1


if __name__ == '__main__':
    sys.exit(main())
