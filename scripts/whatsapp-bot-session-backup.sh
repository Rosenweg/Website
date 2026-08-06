#!/bin/bash
# Taegliches Backup der WhatsApp-Bot-LocalAuth-Session.
#
# Hintergrund: Die WhatsApp-Pairing-Session liegt im Docker-Volume
# whatsapp-bot_whatsapp-data. Geht es verloren, muss jemand am Telefon neu
# pairen — und bis dahin steht der Messenger-Draht ins Haus still.
#
# Laeuft in CT 116 (whatsapp-bridge, pve3, 100.64.2.39). Docker laeuft dort
# INNERHALB des LXC; die Umstellung von Swarm auf CTs hat den Volume-Namen
# geaendert (frueher rosenweg_whatsapp-data auf CT 201 = docker-pve1).
#
# Restore-Verfahren: siehe scripts/whatsapp-bot-session-restore.sh
#
# Installation:
#   scp scripts/whatsapp-bot-session-backup.sh root@<pve1>:/tmp/
#   ssh -J root@<pve1> root@<pve3-cluster-ip> \
#     'pct push 116 /tmp/whatsapp-bot-session-backup.sh /opt/rosenweg-backup/whatsapp-bot-session-backup.sh'
#   pct exec 116 -- chmod 755 /opt/rosenweg-backup/whatsapp-bot-session-backup.sh
#   pct exec 116 -- bash -c 'echo "0 3 * * * root /opt/rosenweg-backup/whatsapp-bot-session-backup.sh" > /etc/cron.d/whatsapp-bot-backup'
#
# Der Weg zum Fileserver laeuft ueber SSH, nicht mehr ueber CIFS. Frueher lag
# dafuer das Passwort von api-svc in /etc/rosenweg/cifs.cred auf diesem Host.
# Jetzt gibt es einen eigenen Schluessel (/root/.ssh/wa-backup), und auf der
# Gegenseite haengt daran ein erzwungener Befehl: der Schluessel kann genau
# ein Archiv abliefern, sonst nichts. Dateiname, Ablageort und Aufbewahrung
# entscheidet der Fileserver — siehe dort /usr/local/bin/wa-session-empfangen.

set -euo pipefail

VOL_PATH=/var/lib/docker/volumes/whatsapp-bot_whatsapp-data/_data
ZIEL_HOST=100.64.2.28
ZIEL_USER=root
SCHLUESSEL=/root/.ssh/wa-backup
LOG=/var/log/whatsapp-bot-backup.log

log() { echo "[$(date +%FT%T)] $*" | tee -a "$LOG"; }

if [ ! -d "$VOL_PATH" ]; then
  log "FEHLER: Volume $VOL_PATH nicht gefunden — laeuft der Bot woanders?"
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Erst kopieren, dann packen: Chromium schreibt waehrenddessen in die
# Session-Dateien, und ein tar ueber ein laufendes Profil liest sich
# inkonsistent zusammen.
cp -a "$VOL_PATH/." "$TMP/" 2>>"$LOG" || log "WARN: cp meldete Fehler"

# Das Archiv geht durch die Leitung, nicht ueber die Platte — es waere sonst
# eine halbe Gigabyte-Kopie auf einem Host, der sie nicht braucht.
ANTWORT=$(tar -czf - -C "$TMP" . 2>>"$LOG" \
  | ssh -i "$SCHLUESSEL" -o BatchMode=yes -o ConnectTimeout=20 \
        -o StrictHostKeyChecking=accept-new "$ZIEL_USER@$ZIEL_HOST" 2>>"$LOG") || {
  log "FEHLER: Uebertragung zum Fileserver fehlgeschlagen"
  exit 1
}
log "$ANTWORT"
