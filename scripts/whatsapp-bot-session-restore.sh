#!/bin/bash
# Restore eines WhatsApp-Bot-Session-Backups.
#
# Verwendung (laeuft im LXC CT 201 = 100.64.2.24):
#   ssh root@100.64.2.24
#   ls /mnt/rosenweg-backup/archiv/whatsapp-bot-session/  # Backup auswaehlen
#   /opt/rosenweg-backup/whatsapp-bot-session-restore.sh wa-session-20260518-030001.tar.gz
#
# Effekt: stoppt den Bot, ersetzt das /data Volume mit dem Backup-Inhalt,
# startet den Bot wieder. Kein Re-Pairing noetig.

set -euo pipefail

BACKUP_NAME=${1:?'Usage: restore.sh <backup-filename>'}
VOL_PATH=/var/lib/docker/volumes/rosenweg_whatsapp-data/_data
MOUNT=/mnt/rosenweg-backup
BACKUP_SUBDIR=archiv/whatsapp-bot-session
BACKUP_FILE="$MOUNT/$BACKUP_SUBDIR/$BACKUP_NAME"

mkdir -p "$MOUNT"
# Credentials in /etc/rosenweg/cifs.cred (chmod 600), NICHT im Repo.
mountpoint -q "$MOUNT" || mount -t cifs //100.64.2.28/api "$MOUNT" \
  -o credentials=/etc/rosenweg/cifs.cred,vers=3.0,uid=0,gid=0

if [ ! -f "$BACKUP_FILE" ]; then
  echo "FEHLER: Backup-Datei nicht gefunden: $BACKUP_FILE"
  ls -la "$MOUNT/$BACKUP_SUBDIR/" || true
  exit 1
fi

echo "Backup: $BACKUP_FILE"
echo "Ziel:   $VOL_PATH"
read -p "Wirklich restoren? Volume wird ueberschrieben. [yes/no] " ANS
[ "$ANS" = "yes" ] || { echo "Abgebrochen."; exit 1; }

# Bot stoppen (lokal: wir sind ja schon in CT 201)
docker service scale rosenweg_whatsapp-bot=0

# Volume leeren + Backup einspielen
rm -rf "${VOL_PATH:?}"/*
rm -rf "${VOL_PATH:?}"/.[!.]*  2>/dev/null || true
tar -xzf "$BACKUP_FILE" -C "$VOL_PATH/"

# Locks pre-emptiv entfernen (Hostname im Lock war frueher gesperrt)
rm -f "$VOL_PATH"/session/SingletonLock "$VOL_PATH"/session/SingletonSocket "$VOL_PATH"/session/SingletonCookie 2>/dev/null || true

# Bot wieder hochfahren
docker service scale rosenweg_whatsapp-bot=1
echo "Restore fertig. Bot startet. Check Logs:"
echo "  docker service logs -f rosenweg_whatsapp-bot"
