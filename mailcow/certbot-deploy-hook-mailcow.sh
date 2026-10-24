#!/bin/bash
# Certbot-Deploy-Hook auf CT 240 (/etc/letsencrypt/renewal-hooks/deploy/mailcow.sh):
# zieht das erneuerte LE-Zertifikat in Mailcow nach und laedt die Dienste neu.
#
# Mailcow bedient mehrere Domains mit eigenen Hostnamen. Dovecot waehlt das
# Zertifikat per SNI aus data/assets/ssl/<host>/ (sni.conf). Bis 24.10.2026
# erneuerte dieser Hook nur das Hauptzertifikat; die Host-Verzeichnisse blieben
# auf dem Stand vom Juni und liefen am 10.9.2026 ab (IMAP-Warnungen, ZEV-Poller
# 6 Wochen tot). Jetzt bekommt jedes Host-Verzeichnis, dessen Name im
# Zertifikat steht, dasselbe frische Zertifikat.
set -euo pipefail
LIVE=/etc/letsencrypt/live/mailcow.rosenweg9.ch
SSL=/opt/mailcow-dockerized/data/assets/ssl
cd /opt/mailcow-dockerized

install -m 644 "$LIVE/fullchain.pem" "$SSL/cert.pem"
install -m 600 "$LIVE/privkey.pem"   "$SSL/key.pem"

SAN=$(openssl x509 -in "$LIVE/fullchain.pem" -noout -ext subjectAltName | tr ',' '\n' | sed -n 's/.*DNS://p')
for dir in "$SSL"/*/; do
  host=$(basename "$dir")
  [ -f "$dir/cert.pem" ] || continue
  if printf '%s\n' "$SAN" | grep -qxF "$host"; then
    install -m 644 "$LIVE/fullchain.pem" "$dir/cert.pem"
    install -m 600 "$LIVE/privkey.pem"   "$dir/key.pem"
  else
    echo "WARNUNG: $host steht nicht im Zertifikat — nicht erneuert" >&2
  fi
done

# Postfix bettet die SNI-Zertifikate per postmap -F in sni.map.db ein — ohne
# Neubau liefert SMTP (465/587) nach dem Reload weiter das alte Zertifikat.
docker compose exec -T postfix-mailcow sh -c 'postmap -F hash:/opt/postfix/conf/sni.map && postfix reload' </dev/null >/dev/null 2>&1 || true
docker compose exec -T dovecot-mailcow doveadm reload </dev/null >/dev/null 2>&1 || true
docker compose exec -T nginx-mailcow  nginx -s reload </dev/null >/dev/null 2>&1 || true
echo "$(date -Is) mailcow cert refreshed (Haupt + Host-Verzeichnisse)" >> /var/log/mailcow-cert-renew.log
