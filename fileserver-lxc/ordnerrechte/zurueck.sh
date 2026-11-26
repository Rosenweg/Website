#!/bin/bash
# Rueckweg: stellt die mit sichern.sh gesicherten ACLs, Besitzer und
# Gruppen wieder her.
#
#   zurueck.sh /root/ordnerrechte-sicherung/acl-…txt [--trocken]
#
# setfacl --restore setzt genau die gesicherten Eintraege. Dateien, die
# erst nach der Sicherung entstanden sind, stehen nicht in der Sicherung
# und behalten ihre (geerbten) ACLs - die zeigt das Skript am Ende an.
set -euo pipefail
DATEI="${1:-}"; TROCKEN=0; [ "${2:-}" = --trocken ] && TROCKEN=1
[ -f "$DATEI" ] || { echo "Aufruf: zurueck.sh <sicherung> [--trocken]" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "Bitte als root" >&2; exit 2; }
n=$(grep -c '^# file: ' "$DATEI")
fehlt=$(grep '^# file: ' "$DATEI" | sed 's/^# file: //' | while IFS= read -r p; do [ -e "$p" ] || echo x; done | wc -l)
echo "Sicherung: $DATEI - $n Eintraege, davon $fehlt inzwischen nicht mehr vorhanden"
if [ "$TROCKEN" = 1 ]; then echo "TROCKENLAUF: wuerde setfacl --restore ausfuehren"; exit 0; fi
# Nicht mehr vorhandene Pfade wuerde setfacl als Fehler melden und weitermachen
setfacl --restore="$DATEI" || echo "Hinweis: einige Eintraege liessen sich nicht setzen (meist geloeschte Dateien)" >&2
echo "Wiederhergestellt."
