#!/bin/bash
# Taegliches Backup der WhatsApp-Bot-LocalAuth-Session.
#
# Hintergrund: Die WhatsApp-Pairing-Session liegt im Docker-Volume
# rosenweg_whatsapp-data auf docker-pve1. Bei Volume-Loss (z.B. Disk-
# Crash, versehentliches docker volume rm) muesste neu gepairt werden.
# Dieses Skript snapshotted das Volume taeglich auf den Fileserver.
#
# Restore-Verfahren: siehe scripts/whatsapp-bot-session-restore.sh
#
# Installation (laeuft im LXC CT 201 = docker-pve1 = 100.64.2.24):
#   scp scripts/whatsapp-bot-session-backup.sh root@100.64.2.24:/opt/rosenweg-backup/
#   ssh root@100.64.2.24 chmod +x /opt/rosenweg-backup/whatsapp-bot-session-backup.sh
#   ssh root@100.64.2.24 'echo "0 3 * * * root /opt/rosenweg-backup/whatsapp-bot-session-backup.sh" > /etc/cron.d/whatsapp-bot-backup'

set -euo pipefail

VOL_PATH=/var/lib/docker/volumes/rosenweg_whatsapp-data/_data
MOUNT=/mnt/rosenweg-backup
BACKUP_SUBDIR=archiv/whatsapp-bot-session
TS=$(date +%Y%m%d-%H%M%S)
LOG=/var/log/whatsapp-bot-backup.log

log() { echo "[$(date +%FT%T)] $*" | tee -a "$LOG"; }

if [ ! -d "$VOL_PATH" ]; then
  log "FEHLER: Volume $VOL_PATH nicht gefunden (laeuft Bot auf anderer Node?)"
  exit 1
fi

mkdir -p "$MOUNT"
if ! mountpoint -q "$MOUNT"; then
  mount -t cifs //100.64.2.28/api "$MOUNT" \
    -o username=api-svc,password=RwApiCifs2026,vers=3.0,uid=0,gid=0,file_mode=0664,dir_mode=0775 \
    || { log "FEHLER: CIFS-Mount fehlgeschlagen"; exit 1; }
  MOUNTED_HERE=1
else
  MOUNTED_HERE=0
fi

mkdir -p "$MOUNT/$BACKUP_SUBDIR"
TARGET="$MOUNT/$BACKUP_SUBDIR/wa-session-$TS.tar.gz"

# cp -a auf Snapshot-Dir, dann tar — vermeidet inkonsistente Reads,
# wenn Chromium gerade in den Session-Dateien schreibt.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ "$MOUNTED_HERE" = "1" ] && umount "$MOUNT" 2>/dev/null || true' EXIT

cp -a "$VOL_PATH/." "$TMP/" 2>>"$LOG" || log "WARN: cp meldete Fehler"
tar -czf "$TARGET" -C "$TMP" . 2>>"$LOG"
SIZE=$(du -h "$TARGET" | cut -f1)
log "OK: Backup geschrieben $TARGET ($SIZE)"

# Retention: 14 Tage
find "$MOUNT/$BACKUP_SUBDIR" -name 'wa-session-*.tar.gz' -mtime +14 -delete 2>>"$LOG" || true
KEPT=$(ls -1 "$MOUNT/$BACKUP_SUBDIR"/wa-session-*.tar.gz 2>/dev/null | wc -l)
log "Retention: $KEPT Backups behalten (>14 Tage geloescht)"
