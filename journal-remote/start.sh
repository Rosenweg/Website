#!/bin/sh
# nginx (TLS + Client-Zertifikat) vor systemd-journal-remote (HTTP, nur lokal);
# einmal täglich alles weg, was älter als JOURNAL_AUFBEWAHRUNG ist.
set -eu

TLS="${JOURNAL_TLS_DIR:-/tls}"
ZIEL="${JOURNAL_ZIEL:-/var/log/journal/remote}"
AUFBEWAHRUNG="${JOURNAL_AUFBEWAHRUNG:-30d}"

for f in server.key server.crt ca.crt; do
    [ -r "$TLS/$f" ] || { echo "journal-remote: $TLS/$f fehlt — backend-lxc/core/journal-ca-anlegen.sh ausführen." >&2; exit 1; }
done
mkdir -p "$ZIEL"

(
    while :; do
        journalctl --directory="$ZIEL" --vacuum-time="$AUFBEWAHRUNG" >/dev/null 2>&1 || true
        sleep 86400
    done
) &

nginx -t
nginx

# Eine gemeinsame Datei: hinter nginx sieht journal-remote jeden Absender als
# 127.0.0.1, --split-mode=host trennte also ohnehin nichts. Gefiltert wird beim
# Lesen nach _HOSTNAME (= Stations-ID).
exec /usr/lib/systemd/systemd-journal-remote \
    --listen-http=127.0.0.1:19531 \
    --split-mode=none \
    --output="$ZIEL/stationen.journal"
