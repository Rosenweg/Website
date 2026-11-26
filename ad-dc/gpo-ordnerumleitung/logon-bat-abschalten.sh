#!/bin/bash
# ============================================================================
# logon-bat-abschalten.sh - das alte Anmeldeskript logon.bat stilllegen (dc1)
# ============================================================================
# Seit der Richtlinie Rosenweg-Ordnerumleitung macht logon.bat nichts mehr,
# was nicht anders geregelt ist:
#   - Laufwerk A: und Drucker waren schon auskommentiert (Laufwerke und
#     Drucker kommen aus Rosenweg-Look Windows)
#   - :folderredir (nur stefan.mueller) ersetzt die Ordnerumleitung
#
# Schritte (nur mit --ausfuehren, sonst nur anzeigen):
#   1. den Cron-Job sync-logon-script abschalten - er setzt alle 5 Minuten
#      bei JEDEM Konto ohne scriptPath wieder "logon.bat" ein
#   2. scriptPath aller Konten sichern (LDIF) und entfernen
#   3. logon.bat im sysvol umbenennen (logon.bat.abgeschaltet-DATUM)
#
#   ./logon-bat-abschalten.sh               zeigt, was geschaehe
#   ./logon-bat-abschalten.sh --ausfuehren  macht es
#
# dc2: scriptPath kommt ueber die AD-Replikation, die Umbenennung im sysvol
# ueber sysvol-abgleich (Timer alle 10 Minuten, ad-dc/README.md). Der
# Cron-Job liegt nur auf dc1.
# ============================================================================
set -euo pipefail

SAM="/var/lib/samba/private/sam.ldb"
BASIS="DC=ad,DC=rosenweg4303,DC=ch"
SCRIPTS="/var/lib/samba/sysvol/ad.rosenweg4303.ch/scripts"
CRON="/etc/cron.d/sync-logon-script"
TAG="$(date +%Y%m%d)"
SICHERUNG="/root/ad-sicherung/scriptpath-vor-abschalten-$TAG.ldif"
ABLAGE="/root/abgeschaltet"

ausfuehren=0
[ "${1:-}" = "--ausfuehren" ] && ausfuehren=1

# Erst abschalten, wenn die Ordnerumleitung als Richtlinie steht - sonst
# verlaesst sich stefan.mueller noch auf :folderredir.
if ! samba-tool gpo listall -H "$SAM" | grep -qx 'display name : Rosenweg-Ordnerumleitung'; then
    echo "Richtlinie Rosenweg-Ordnerumleitung fehlt - zuerst einrichten.sh." >&2
    exit 1
fi

ldif_zeilen() { awk '/^ / { z = z substr($0, 2); next } { if (NR > 1) print z; z = $0 } END { print z }'; }

# Konten mit scriptPath: "dn<TAB>sAMAccountName<TAB>scriptPath"
liste="$(ldbsearch -H "$SAM" -b "$BASIS" "(scriptPath=*)" sAMAccountName scriptPath \
    | ldif_zeilen | awk '
        /^dn: /             { dn = substr($0, 5) }
        /^sAMAccountName: / { sam = substr($0, 17) }
        /^scriptPath: /     { sp = substr($0, 13) }
        /^$/ { if (dn != "" && sp != "") print dn "\t" sam "\t" sp; dn = sam = sp = "" }
        END  { if (dn != "" && sp != "") print dn "\t" sam "\t" sp }')"
anzahl="$(printf '%s\n' "$liste" | grep -c . || true)"
andere="$(printf '%s\n' "$liste" | awk -F'\t' '$3 != "" && tolower($3) != "logon.bat"')"

echo "Konten mit scriptPath: $anzahl"
printf '%s\n' "$liste" | awk -F'\t' 'NF { printf "  %-32s %s\n", $2, $3 }'
if [ -n "$andere" ]; then
    echo "Achtung: scriptPath ungleich logon.bat - diese Konten bleiben unberuehrt:" >&2
    printf '%s\n' "$andere" | awk -F'\t' '{ print "  " $2 ": " $3 }' >&2
fi
[ -f "$CRON" ] && echo "Cron-Job aktiv: $CRON (wird abgeschaltet)"
[ -f "$SCRIPTS/logon.bat" ] && echo "logon.bat liegt in $SCRIPTS (wird umbenannt)"

if [ "$ausfuehren" -ne 1 ]; then
    echo "Probelauf - nichts geaendert. Mit --ausfuehren wirklich abschalten."
    exit 0
fi

# --- 1. Cron-Job -------------------------------------------------------------
mkdir -p "$ABLAGE"
if [ -f "$CRON" ]; then
    mv "$CRON" "$ABLAGE/sync-logon-script.cron-$TAG"
    echo "Cron-Job nach $ABLAGE verschoben."
fi

# --- 2. scriptPath ------------------------------------------------------------
mkdir -p "$(dirname "$SICHERUNG")"
printf '%s\n' "$liste" | awk -F'\t' 'NF { print "dn: " $1; print "scriptPath: " $3; print "" }' > "$SICHERUNG"
echo "Sicherung: $SICHERUNG"
ldif="$(printf '%s\n' "$liste" | awk -F'\t' 'NF && tolower($3) == "logon.bat" {
    print "dn: " $1; print "changetype: modify"; print "delete: scriptPath"; print "-"; print "" }')"
if [ -n "$ldif" ]; then
    printf '%s\n' "$ldif" | ldbmodify -H "$SAM" >/dev/null
fi
rest="$(ldbsearch -H "$SAM" -b "$BASIS" "(scriptPath=logon.bat)" dn | grep -c '^dn: ' || true)"
echo "scriptPath entfernt; noch mit logon.bat: $rest"

# --- 3. logon.bat ---------------------------------------------------------------
# Umbenennen statt loeschen; die anderen Dateien in scripts/ bleiben
# (sync-ad-photo.ps1 gehoert zur Richtlinie "Rosenweg - AD Photo Sync").
if [ -f "$SCRIPTS/logon.bat" ]; then
    mv "$SCRIPTS/logon.bat" "$SCRIPTS/logon.bat.abgeschaltet-$TAG"
    echo "logon.bat umbenannt in logon.bat.abgeschaltet-$TAG."
fi
echo "Fertig. dc2 folgt ueber Replikation und sysvol-abgleich (bis 10 Minuten)."
