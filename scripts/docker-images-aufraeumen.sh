#!/bin/bash
# ============================================================================
# docker-images-aufraeumen — die Bau-Reste in CT 128 wegräumen
# ============================================================================
# Läuft auf core-backend (CT 128, 100.64.2.52).
#
# Jeder CI-Lauf baut ein neues `ghcr.io/rosenweg/rosenweg-api`-Image. Beim
# Pull wandert der Name `:latest` auf das neue; das alte behält seine Schichten,
# verliert aber den Namen und bleibt als namenloses Image liegen. Aufgeräumt
# hat das nie jemand.
#
# Am 5. August 2026 stand deshalb die ganze Siedlungs-Software still:
#
#     135 Images, 21,5 GB — davon 129 namenlos
#     /dev/rbd6  24G  23G  0  100% /
#
#     PANIC: could not write to file
#            "pg_logical/replorigin_checkpoint.tmp": No space left on device
#
# Postgres kam damit nicht mehr aus der Wiederherstellung: starten, Checkpoint
# versuchen, am vollen Dateisystem scheitern, von vorn. Nicht nur die
# Stationsverwaltung hing daran — jede Seite, die Daten braucht.
#
# Entfernt werden AUSSCHLIESSLICH namenlose Images ('docker image prune' ohne
# '-a'). Absichtlich nicht mehr:
#
#   * Ein benanntes Image kann die Rückfallebene sein. Wer '-a' nimmt, räumt
#     genau das weg, was man nach einem misslungenen Ausrollen braucht.
#   * Was ein laufender Container benutzt, fasst Docker ohnehin nicht an.
#
# Namenlose Images sind Reste ersetzter Bauten. Wird eines doch gebraucht,
# holt ein `docker compose pull` es aus der Registry zurück.
#
#   docker-images-aufraeumen.sh [--probe] [--schwelle 80]
#     --probe      nur zeigen, nichts entfernen
#     --schwelle   ab dieser Belegung in Prozent wird gewarnt (Vorgabe 80)
# ============================================================================

set -uo pipefail

PROBE=0
SCHWELLE=80

while [ $# -gt 0 ]; do
    case "$1" in
        --probe)    PROBE=1; shift ;;
        --schwelle) SCHWELLE="${2:?}"; shift 2 ;;
        -h|--help)  sed -n '2,40p' "$0"; exit 0 ;;
        *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
    esac
done

sag() {
    echo "$*"
    command -v logger >/dev/null 2>&1 && logger -t docker-aufraeumen "$*"
}

command -v docker >/dev/null 2>&1 || { sag "docker nicht gefunden — hier läuft nichts."; exit 0; }

belegung() { df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9'; }
frei()     { df -h --output=avail / 2>/dev/null | tail -1 | tr -d ' '; }

vorher_prozent="$(belegung)"
vorher_frei="$(frei)"
namenlos="$(docker images -f dangling=true -q 2>/dev/null | wc -l)"

if [ "$namenlos" -eq 0 ]; then
    sag "Nichts aufzuräumen (${vorher_prozent:-?} % belegt, $vorher_frei frei)."
    nachher_prozent="$vorher_prozent"
elif [ "$PROBE" -eq 1 ]; then
    sag "Würde $namenlos namenlose Images entfernen (${vorher_prozent:-?} % belegt)."
    nachher_prozent="$vorher_prozent"
else
    # Die Ausgabe von prune endet mit "Total reclaimed space: …" — die Zeile
    # ist das, was man im Journal lesen will.
    geholt="$(docker image prune -f 2>&1 | grep -i 'reclaimed' | tail -1)"
    nachher_prozent="$(belegung)"
    sag "$namenlos namenlose Images entfernt. ${geholt:-Nichts freigegeben.} Jetzt ${nachher_prozent:-?} % belegt, $(frei) frei."
fi

# Der eigentliche Zweck, und deshalb steht das hier AUSSERHALB der Zweige
# oben: dass es nicht wieder unbemerkt eng wird. Ein erster Entwurf stieg bei
# "nichts aufzuräumen" sofort aus — ausgerechnet im Fall „Platte voll, aber
# nicht wegen der Images" wäre er also still geblieben.
#
# Ein voller Datenträger sieht in den Logs der API wie ein Fehler der API aus.
# Am 5. August ging der Blick deshalb zuerst auf den frisch ausgerollten Code.
if [ -n "${nachher_prozent:-}" ] && [ "$nachher_prozent" -ge "$SCHWELLE" ]; then
    sag "ACHTUNG: $nachher_prozent % belegt, Schwelle $SCHWELLE %. Das räumen die Images nicht weg — hier liegt etwas anderes."
    exit 1
fi

exit 0
