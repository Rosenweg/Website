#!/bin/sh
# Startet systemd-journal-remote (HTTPS, Client-Zertifikat Pflicht) und räumt
# einmal täglich alles weg, was älter als JOURNAL_AUFBEWAHRUNG ist.
set -eu

TLS="${JOURNAL_TLS_DIR:-/tls}"
ZIEL="${JOURNAL_ZIEL:-/var/log/journal/remote}"
AUFBEWAHRUNG="${JOURNAL_AUFBEWAHRUNG:-30d}"

for f in server.key server.crt ca.crt; do
    [ -r "$TLS/$f" ] || { echo "journal-remote: $TLS/$f fehlt — backend-lxc/core/journal-ca-anlegen.sh ausführen." >&2; exit 1; }
done
mkdir -p "$ZIEL"

# Aufräumen: beim Start und danach alle 24 Stunden. journal-remote selbst
# begrenzt nur die Grösse (journal-remote.conf), nicht das Alter.
(
    while :; do
        journalctl --directory="$ZIEL" --vacuum-time="$AUFBEWAHRUNG" >/dev/null 2>&1 || true
        sleep 86400
    done
) &

# --split-mode=host: eine Datei je Station (nach _HOSTNAME), so lässt sich
# eine Station gezielt lesen. --trust erzwingt Client-Zertifikate der
# Stations-CA: ohne gültiges Zertifikat nimmt der Dienst nichts an.
exec /usr/lib/systemd/systemd-journal-remote \
    --listen-https=0.0.0.0:19532 \
    --key="$TLS/server.key" \
    --cert="$TLS/server.crt" \
    --trust="$TLS/ca.crt" \
    --split-mode=host \
    --output="$ZIEL/"
