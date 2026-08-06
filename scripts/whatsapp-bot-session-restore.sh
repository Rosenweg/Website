#!/bin/bash
# Restore eines WhatsApp-Bot-Session-Backups.
#
# Laeuft in CT 116 (whatsapp-bridge, pve3, 100.64.2.39). Frueher war das
# CT 201 = docker-pve1 mit Docker Swarm; seit der Umstellung von Swarm auf
# CTs heisst das Volume anders und der Bot wird per compose verwaltet, nicht
# per "docker service scale".
#
# Das Archiv holt man vorher her — der Schluessel der naechtlichen Sicherung
# taugt dafuer nicht, der darf nur abliefern:
#
#   # auf dem Fileserver nachsehen, welche es gibt:
#   ssh root@<pve2> 'pct exec 106 -- ls -la /mnt/cephfs-stage/archiv/whatsapp-bot-session/'
#   # gewuenschtes Archiv nach CT 116 bringen:
#   ssh root@<pve2> 'pct exec 106 -- cat /mnt/cephfs-stage/archiv/whatsapp-bot-session/<datei>' > /tmp/<datei>
#   scp -o 'ProxyJump root@<pve1>' /tmp/<datei> root@<pve3-cluster-ip>:/tmp/
#   ssh -J root@<pve1> root@<pve3-cluster-ip> 'pct push 116 /tmp/<datei> /tmp/<datei>'
#
#   # dann in CT 116:
#   /opt/rosenweg-backup/whatsapp-bot-session-restore.sh /tmp/<datei>
#
# Effekt: stoppt den Bot, ersetzt den Inhalt des Volumes, startet ihn wieder.
# Kein erneutes Pairing am Telefon noetig.

set -euo pipefail

BACKUP_FILE=${1:?'Aufruf: whatsapp-bot-session-restore.sh <pfad-zum-archiv>'}
VOL_PATH=/var/lib/docker/volumes/whatsapp-bot_whatsapp-data/_data
COMPOSE=/opt/whatsapp-bot/compose.yml
DIENST=whatsapp-bot

[ -f "$BACKUP_FILE" ] || { echo "FEHLER: Archiv nicht gefunden: $BACKUP_FILE"; exit 1; }
[ -d "$VOL_PATH" ]    || { echo "FEHLER: Volume nicht gefunden: $VOL_PATH"; exit 1; }

# Lieber jetzt merken als nach dem Loeschen: ein beschaedigtes Archiv wuerde
# sonst ein funktionierendes Volume gegen nichts eintauschen.
gzip -t "$BACKUP_FILE" || { echo "FEHLER: Archiv ist beschaedigt."; exit 1; }

echo "Archiv: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
echo "Ziel:   $VOL_PATH"
read -r -p "Wirklich zurueckspielen? Das Volume wird ueberschrieben. [ja/nein] " ANS
[ "$ANS" = "ja" ] || { echo "Abgebrochen."; exit 1; }

docker compose -f "$COMPOSE" stop "$DIENST"

rm -rf "${VOL_PATH:?}"/*
rm -rf "${VOL_PATH:?}"/.[!.]* 2>/dev/null || true
tar -xzf "$BACKUP_FILE" -C "$VOL_PATH/"

# Chromium legt Sperren an, die den Hostnamen des damaligen Laufs tragen.
# Bleiben sie liegen, startet die Sitzung nicht.
rm -f "$VOL_PATH"/session/SingletonLock \
      "$VOL_PATH"/session/SingletonSocket \
      "$VOL_PATH"/session/SingletonCookie 2>/dev/null || true

docker compose -f "$COMPOSE" start "$DIENST"
echo "Zurueckgespielt. Der Bot startet. Mitlesen:"
echo "  docker compose -f $COMPOSE logs -f $DIENST"
