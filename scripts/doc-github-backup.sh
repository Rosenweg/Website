#!/bin/bash
# GitHub-Backup fuer den Rosenweg-Fileserver
#
# Laeuft auf CT 106 (fileserver, 100.64.2.28) als /usr/local/bin/doc-github-backup.sh.
# /mnt/cephfs-stage ist zugleich die Samba-Freigabe "dokumente" UND ein
# Arbeitsverzeichnis des Repos Rosenweg/documents — dieses Skript haelt beide
# im Gleichschritt.
#
#   Default   stuendlich 07-22 Uhr: holen, aufnehmen, committen, pushen
#   --full    taeglich 03:30 Uhr: zusaetzlich git gc
#
# Einspielen:
#   scp scripts/doc-github-backup.sh root@<pve2>:/tmp/
#   pct push 106 /tmp/doc-github-backup.sh /usr/local/bin/doc-github-backup.sh
#   pct exec 106 -- chmod 755 /usr/local/bin/doc-github-backup.sh
# Zeitplan in /etc/cron.d/rosenweg-documents.
#
# Am 6. August 2026 an drei Stellen repariert; die Begruendungen stehen jeweils
# an Ort und Stelle im Code:
#
#   * Reihenfolge: erst fetch, dann add -A. Umgekehrt galt alles, was auf
#     GitHub entstanden war, als geloescht — 44 Dateien standen bereit.
#   * Alarme: ueber PMG Port 26 mit Absender technik@, und das Ergebnis wird
#     protokolliert. Vorher meldete das Log "Alert gesendet", ohne hinzusehen;
#     zugestellt wurde in Wahrheit keine einzige.
#   * gc ohne --aggressive. Damit lief seit dem 11. Mai 2026 keine Wartung mehr
#     durch, und die losen Objekte wuchsen auf 9,5 GB.

REPO_DIR=/mnt/cephfs-stage
LOG=/var/log/doc-github-backup.log
LOCK=/tmp/doc-github-backup.lock
ALERT_TO="technik@rosenweg4303.ch"
# Absender technik@ und nicht noreply@: mailcow kennt noreply@ nicht und weist
# es ab —
#   550 5.1.0 <noreply@rosenweg4303.ch>: Sender address rejected:
#             User unknown in virtual mailbox table
# Deshalb ist bis zum 6. August 2026 KEINE Warnung dieses Skripts je zugestellt
# worden: PMG nahm sie an, mailcow liess sie fallen. Bekannt sind dort nur
# technik@ und archiv@. Wird noreply@ einmal angelegt, kann es hier zurueck.
ALERT_FROM="technik@rosenweg4303.ch"
# PMG (CT 230), Port 26.
#
# 26 und nicht 25: PMG trennt die Richtungen nach Port. Auf 25 kommt Post von
# aussen an, und dort prueft es SPF — eine Mail vom Fileserver als
# noreply@rosenweg4303.ch wird deshalb abgewiesen:
#   554 5.7.1 Rejected by SPF: 100.64.2.28 is not a designated mailserver
# Port 26 ist der Ausgang fuer das eigene Netz und nimmt sie an. Am Relay
# musste dafuer nichts geaendert werden; 100.64.2.0/24 steht dort laengst in
# mynetworks.
RELAY="100.64.2.31"
RELAY_PORT="26"
MODE="diff"
[ "$1" = "--full" ] && MODE="full"

send_alert() {
  local subject="$1"
  local body="$2"
  local mail rc
  mail=$(mktemp)
  {
    printf 'From: %s\n' "$ALERT_FROM"
    printf 'To: %s\n' "$ALERT_TO"
    printf 'Subject: %s\n' "$subject"
    printf 'Date: %s\n' "$(date -R)"
    printf '\n%s\n' "$body"
  } > "$mail"
  curl -s --max-time 30 --url "smtp://$RELAY:$RELAY_PORT" \
    --mail-from "$ALERT_FROM" --mail-rcpt "$ALERT_TO" \
    --upload-file "$mail" >> $LOG 2>&1
  rc=$?
  rm -f "$mail"

  # Das Ergebnis MUSS ins Log. Vorher stand hier immer "Alert gesendet",
  # egal was curl sagte — 66 angebliche Warnungen in einer Woche, von denen
  # keine ankam, und niemand konnte es dem Protokoll ansehen.
  if [ "$rc" = "0" ]; then
    echo "$(date): Alert verschickt ueber PMG: $subject" >> $LOG
    return
  fi
  echo "$(date): FEHLER - Alert NICHT verschickt (curl $rc): $subject" >> $LOG
}

if [ -f "$LOCK" ]; then
  pid=$(cat "$LOCK")
  if kill -0 "$pid" 2>/dev/null; then
    echo "$(date) [$MODE]: Backup laeuft bereits (PID $pid), uebersprungen" >> $LOG
    exit 0
  fi
  rm -f "$LOCK"
fi
echo $$ > "$LOCK"
trap "rm -f $LOCK" EXIT

cd $REPO_DIR || {
  echo "$(date) [$MODE]: FEHLER - $REPO_DIR nicht erreichbar" >> $LOG
  send_alert "[Rosenweg Backup] FEHLER: Verzeichnis nicht erreichbar" "Das Backup-Verzeichnis $REPO_DIR ist nicht erreichbar."
  exit 1
}

[ -d .git ] || { echo "$(date) [$MODE]: Kein git repo, uebersprungen" >> $LOG; exit 0; }

# ERST holen, DANN aufnehmen.
#
# Umgekehrt — so stand es bis zum 6. August 2026 hier — macht "git add -A"
# eine Momentaufnahme der Freigabe, bevor irgendjemand nachgesehen hat, was
# auf GitHub inzwischen entstanden ist. Alles, was dort neu ist und hier
# folglich fehlt, wird als Loeschung aufgenommen; beim Rebase gewinnt sie.
# So standen 44 Loeschungen bereit: der AEW-Workflow, die Hausordnungen aller
# STWEGs, der Stromtarif. Dass die Pushes seit Mai scheiterten, hat sie
# gerettet. Die Freigabe ist die Wahrheit fuer das, was auf ihr liegt — nicht
# fuer das, was es nur auf GitHub gibt.
if ! git fetch origin main >> $LOG 2>&1; then
  echo "$(date) [$MODE]: FEHLER - git fetch fehlgeschlagen" >> $LOG
  send_alert "[Rosenweg Backup] FEHLER: GitHub nicht erreichbar" "git fetch origin main ist fehlgeschlagen."
  exit 1
fi

# Der Normalfall: nichts Eigenes offen, also einfach nachziehen.
git merge --ff-only origin/main >> $LOG 2>&1

# Das Sicherheitsnetz fuer den anderen Fall (eigene Commits liegen an, ein
# Rebase steht noch aus): was origin/main kennt und hier fehlt, zurueckholen,
# BEVOR add -A daraus eine Loeschung macht.
FEHLEND=$(mktemp)
git ls-tree -r origin/main --name-only -z | while IFS= read -r -d "" f; do
  [ -e "$f" ] || printf "%s\0" "$f"
done > "$FEHLEND"
if [ -s "$FEHLEND" ]; then
  ANZAHL=$(tr -cd "\0" < "$FEHLEND" | wc -c)
  echo "$(date) [$MODE]: $ANZAHL Datei(en) von GitHub zurueckgeholt, die hier fehlten" >> $LOG
  xargs -0 -r git checkout origin/main -- < "$FEHLEND" >> $LOG 2>&1
fi
rm -f "$FEHLEND"

git add -A
if git diff --cached --quiet; then
  HAS_LOCAL_CHANGES=0
else
  COMMIT_PREFIX="Auto-backup"
  [ "$MODE" = "full" ] && COMMIT_PREFIX="Daily-full"
  git commit -m "$COMMIT_PREFIX $(date +%Y-%m-%d_%H:%M)" >> $LOG 2>&1
  HAS_LOCAL_CHANGES=1
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
BASE=$(git merge-base HEAD origin/main)

NEEDS_PUSH=1
if [ "$LOCAL" = "$REMOTE" ]; then
  NEEDS_PUSH=0
  echo "$(date) [$MODE]: Alles synchron" >> $LOG
fi

if [ "$REMOTE" != "$BASE" ] && [ "$LOCAL" != "$REMOTE" ]; then
  echo "$(date) [$MODE]: Remote hat neue Commits, starte Rebase..." >> $LOG
  if ! git rebase origin/main >> $LOG 2>&1; then
    echo "$(date) [$MODE]: FEHLER - Rebase-Konflikt! Breche ab." >> $LOG
    git rebase --abort >> $LOG 2>&1
    git reset --soft origin/main >> $LOG 2>&1
    git add -A
    if ! git diff --cached --quiet; then
      git commit -m "Auto-backup $(date +%Y-%m-%d_%H:%M) (nach Konflikt)" >> $LOG 2>&1
    fi
    send_alert "[Rosenweg Backup] Rebase-Konflikt aufgeloest" "Konflikt automatisch aufgeloest, bitte pruefen."
  fi
fi

if [ "$NEEDS_PUSH" = "1" ]; then
  if ! git push origin main >> $LOG 2>&1; then
    echo "$(date) [$MODE]: FEHLER - Push fehlgeschlagen" >> $LOG
    send_alert "[Rosenweg Backup] FEHLER: Push fehlgeschlagen" "git push origin main fehlgeschlagen. Log: $(tail -5 $LOG)"
    exit 1
  fi
  echo "$(date) [$MODE]: Push erfolgreich" >> $LOG
fi

# Full-Modus: Repository-Wartung (gc + repack), erst NACH Push
if [ "$MODE" = "full" ]; then
  # Ohne --aggressive: das rechnet saemtliche Deltas neu und braucht dafuer
  # mehr Speicher, als der Container hat (2 GB). Seit dem 11. Mai 2026 ist
  # kein gc mehr durchgelaufen, und die losen Objekte wuchsen auf 9,5 GB.
  echo "$(date) [full]: git gc --prune=now ..." >> $LOG
  git gc --prune=now >> $LOG 2>&1
  echo "$(date) [full]: gc fertig, Repo-Groesse: $(du -sh .git | cut -f1)" >> $LOG
fi
