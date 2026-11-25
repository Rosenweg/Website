#!/bin/bash
# Sichert die heutigen ACLs (und Besitzer/Gruppe) unter einer Wurzel, damit
# zurueck.sh den Stand vor anwenden.sh wiederherstellen kann.
#
#   sichern.sh --wurzel /mnt/cephfs-stage [--ziel /root/ordnerrechte-sicherung]
#
# Ausgabe: <ziel>/acl-<wurzelname>-<JJJJ-MM-TT-HHMMSS>.txt (Rechte 600).
# Ein getfacl -R mit absoluten Pfaden; .git/.github/.claude/.recycle fasst
# anwenden.sh nicht an, sie werden hier deshalb ausgelassen.
# Die Sicherung liegt bewusst lokal im Container und nicht im CephFS: dort
# koennte sie mit den Dokumenten verloren gehen oder ueber die Freigabe
# sichtbar werden. Danach auf den anderen Fileserver kopieren.
set -euo pipefail
WURZEL="" ZIEL=/root/ordnerrechte-sicherung
while [ $# -gt 0 ]; do
  case "$1" in
    --wurzel) WURZEL="${2%/}"; shift 2 ;;
    --ziel)   ZIEL="$2"; shift 2 ;;
    *) echo "Unbekannt: $1" >&2; exit 2 ;;
  esac
done
[ -d "$WURZEL" ] || { echo "Wurzel fehlt (--wurzel)" >&2; exit 2; }
umask 077
mkdir -p "$ZIEL"
datei="$ZIEL/acl-$(basename "$WURZEL")-$(date +%F-%H%M%S).txt"
find "$WURZEL" \( -name .git -o -name .github -o -name .claude -o -name .recycle \) -prune \
  -o \( -type d -o -type f \) -print0 \
  | xargs -0 -r getfacl -P -p --absolute-names >"$datei" 2>"$datei.fehler"
[ -s "$datei.fehler" ] || rm -f "$datei.fehler"
n=$(grep -c '^# file: ' "$datei")
echo "$datei ($n Eintraege)"
[ -e "$datei.fehler" ] && { echo "WARNUNG: Fehler beim Lesen, siehe $datei.fehler" >&2; exit 1; }
exit 0
