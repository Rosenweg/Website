#!/bin/sh
# Legt CA und Serverzertifikat für das Stationsjournal an (journal-remote).
# Auf CT 128 als root ausführen; idempotent — Vorhandenes bleibt unangetastet.
# Ablage: /opt/rosenweg-core/journal-tls (0700). Nie ins Repo.
set -eu
D="${1:-/opt/rosenweg-core/journal-tls}"
IP="${JOURNAL_SERVER_IP:-100.64.2.52}"
install -d -m 0700 "$D"
cd "$D"

if [ ! -s ca.key ]; then
    openssl genrsa -out ca.key 4096 2>/dev/null
    openssl req -x509 -new -key ca.key -sha256 -days 3650 \
        -subj "/O=Rosenweg/CN=Rosenweg Stationsjournal CA" -out ca.crt
    echo "CA angelegt."
fi

if [ ! -s server.key ]; then
    openssl genrsa -out server.key 2048 2>/dev/null
    openssl req -new -key server.key -subj "/O=Rosenweg/CN=journal-remote" -out server.csr
    printf 'subjectAltName=IP:%s,DNS:core-backend\nextendedKeyUsage=serverAuth\n' "$IP" > server.ext
    openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
        -days 3650 -sha256 -extfile server.ext -out server.crt
    rm -f server.csr server.ext
    echo "Serverzertifikat angelegt (IP $IP)."
fi

# Beide Container laufen als root; Schlüssel nur für root lesbar.
chmod 0600 server.key ca.key
chmod 0644 ca.crt server.crt
ls -l "$D"
