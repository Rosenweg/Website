#!/bin/bash
# PMG (CT 100.64.2.31): haelt den Rosenweg-Block in /etc/postfix/master.cf auf
# dem Sollstand. pmgconfig sync (z. B. beim Start oder nach Aenderungen in der
# PMG-Oberflaeche) schreibt master.cf aus der Vorlage neu und wirft den Block
# raus. Ausgeloest von pmg-restore-rosenweg.path (Aenderung an master.cf) und
# .timer. Idempotent: ist der Block gleich, passiert nichts.
#
# Seit 18.11.2026 ersetzt das Skript einen abweichenden Block (frueher nur
# "einfuegen, wenn er fehlt") und prueft vor dem Neuladen mit "postfix check".
#
# Block:
#   submission (587)  SASL gegen Mailcow-Dovecot (Port 10001), direkt vom UDM
#   smtps      (465)  dasselbe mit implizitem TLS (intern/direkt)
#   10465             wie smtps, aber mit PROXY-Protokoll fuer edge-traefik:
#                     Postfix sieht die echte Client-IP. Nur 100.64.2.40 darf
#                     verbinden (nft-Tabelle rw_pmg_proxy, pmg-proxy-fw.service),
#                     sonst koennte jeder eine Absenderadresse vortaeuschen.
set -euo pipefail
MASTER=/etc/postfix/master.cf
MARK_START="# >>> ROSENWEG-SUBMISSION (DO NOT EDIT BY HAND, see pmg-restore-rosenweg.path)"
MARK_END="# <<< ROSENWEG-SUBMISSION"

SOLL=$(cat <<MCF
$MARK_START
# Submission (587) fuer Roamer mit SASL gegen Mailcow Dovecot
submission inet n       -       y       -       -       smtpd
  -o syslog_name=postfix/submission
  -o smtpd_tls_cert_file=/etc/postfix/ssl-cert.pem
  -o smtpd_tls_key_file=/etc/postfix/ssl-key.pem
  -o smtpd_tls_security_level=encrypt
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_sasl_type=dovecot
  -o smtpd_sasl_path=inet:100.64.2.33:10001
  -o smtpd_relay_restrictions=permit_sasl_authenticated,reject
  -o smtpd_recipient_restrictions=permit_sasl_authenticated,reject
  -o smtpd_sender_login_maps=
  -o smtpd_client_restrictions=permit_sasl_authenticated,reject

# SMTPS (465, implicit TLS)
smtps inet n       -       y       -       -       smtpd
  -o syslog_name=postfix/smtps
  -o smtpd_tls_wrappermode=yes
  -o smtpd_tls_cert_file=/etc/postfix/ssl-cert.pem
  -o smtpd_tls_key_file=/etc/postfix/ssl-key.pem
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_sasl_type=dovecot
  -o smtpd_sasl_path=inet:100.64.2.33:10001
  -o smtpd_relay_restrictions=permit_sasl_authenticated,reject
  -o smtpd_recipient_restrictions=permit_sasl_authenticated,reject
  -o smtpd_client_restrictions=permit_sasl_authenticated,reject

# SMTPS ueber edge-traefik mit PROXY-Protokoll (echte Client-IP); nur vom Edge
10465 inet n       -       y       -       -       smtpd
  -o syslog_name=postfix/smtps-edge
  -o smtpd_upstream_proxy_protocol=haproxy
  -o smtpd_tls_wrappermode=yes
  -o smtpd_tls_cert_file=/etc/postfix/ssl-cert.pem
  -o smtpd_tls_key_file=/etc/postfix/ssl-key.pem
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_sasl_type=dovecot
  -o smtpd_sasl_path=inet:100.64.2.33:10001
  -o smtpd_relay_restrictions=permit_sasl_authenticated,reject
  -o smtpd_recipient_restrictions=permit_sasl_authenticated,reject
  -o smtpd_client_restrictions=permit_sasl_authenticated,reject
$MARK_END
MCF
)

IST=$(awk -v s="# >>> ROSENWEG-SUBMISSION" -v e="$MARK_END" \
  'index($0,s)==1{f=1} f{print} index($0,e)==1{f=0}' "$MASTER")
[ "$IST" = "$SOLL" ] && exit 0

echo "[$(date -Iseconds)] pmg-restore: Block fehlt oder weicht ab, setze Sollstand" >&2
SICHERUNG=$(mktemp /root/master.cf.vor-restore.XXXXXX)
cp -p "$MASTER" "$SICHERUNG"

# Alten Block (jede Fassung) entfernen, Sollstand anhaengen
NEU=$(mktemp)
awk -v s="# >>> ROSENWEG-SUBMISSION" -v e="$MARK_END" \
  'index($0,s)==1{f=1} !f{print} index($0,e)==1{f=0}' "$MASTER" > "$NEU"
# hoechstens eine Leerzeile am Ende, dann der Block
sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$NEU"
printf '\n%s\n' "$SOLL" >> "$NEU"
cat "$NEU" > "$MASTER"
rm -f "$NEU"

if ! postfix check 2>&1; then
  echo "[$(date -Iseconds)] pmg-restore: postfix check FEHLGESCHLAGEN, alte master.cf zurueck" >&2
  cp -p "$SICHERUNG" "$MASTER"
  exit 1
fi
systemctl reload postfix
sleep 1
echo "[$(date -Iseconds)] pmg-restore: Listener aktiv:" >&2
ss -tln | awk '/:25 |:465 |:587 |:10465 / {print "  " $0}' >&2 || true
