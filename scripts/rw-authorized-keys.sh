#!/bin/sh
# AuthorizedKeysCommand fuer die Rosenweg-Hosts
#
# sshd ruft dieses Skript bei jedem Anmeldeversuch mit dem Login als
# Argument auf und nimmt, was auf stdout steht, als authorized_keys.
# Installation als /usr/local/bin/rw-authorized-keys (Modus 0755, root).
#
# Zwei Eigenheiten, die hier wichtig sind:
#
#   * Es laeuft im Anmeldepfad. Jede Sekunde Wartezeit ist eine Sekunde,
#     die jede Anmeldung auf diesem Host laenger dauert — daher das
#     knappe Timeout und der Zwischenspeicher.
#   * Faellt die API aus, wuerde eine leere Antwort alle aussperren.
#     Darum: bei jedem Fehlschlag der letzte bekannte Stand aus dem
#     Zwischenspeicher. Erst wenn auch der fehlt, gibt es nichts.
#
# Es bleibt dabei: /root/.ssh/authorized_keys wird von sshd zusaetzlich
# gelesen und von hier nie angetastet. Das ist der Notweg.
set -eu

# Der Pfad ist ueberschreibbar, damit sich das Skript testen laesst.
KONF=${RW_SSH_KONF:-/etc/rosenweg-ssh.conf}
[ -r "$KONF" ] || exit 0
# shellcheck disable=SC1090
. "$KONF"

: "${API_BASE:=}" "${HOST_TOKEN:=}" "${HOST_NAME:=$(hostname -s)}"
[ -n "$API_BASE" ] && [ -n "$HOST_TOKEN" ] || exit 0

LOGIN="${1:-}"
# Eng gefasst: Der Wert geht in einen Pfad und in eine URL. Punkte sind
# erlaubt, weil die Anmeldenamen aus dem Verzeichnis so aussehen
# (stefan.mueller) — aber '.' und '..' allein waeren Verzeichnisnamen
# und muessen ausdruecklich raus, bevor sie in einen Pfad geraten.
case "$LOGIN" in
  '' | . | .. ) exit 0 ;;
  *[!a-z0-9._-]* ) exit 0 ;;
esac

CACHE_DIR=${CACHE_DIR:-/var/cache/rosenweg-ssh}
CACHE="$CACHE_DIR/$LOGIN.keys"

# Entscheidend ist der Exitcode, nicht der Text. Eine leere Antwort mit
# Status 200 heisst "diese Person darf hier nicht mehr" — der Cache muss
# dann weg, sonst greift ein Entzug nie. Nur wenn curl selbst scheitert
# (kein Netz, API tot, 5xx), gilt der letzte bekannte Stand.
if ANTWORT=$(curl -fsS --max-time "${TIMEOUT:-3}" \
       -H "X-Host-Token: $HOST_TOKEN" \
       -H "X-Host-Name: $HOST_NAME" \
       "$API_BASE/api/ssh/authorized-keys/$LOGIN" 2>/dev/null); then
  printf '%s' "$ANTWORT"
  if [ -d "$CACHE_DIR" ] && [ -w "$CACHE_DIR" ]; then
    if [ -n "$ANTWORT" ]; then
      # Ueber eine temporaere Datei, damit ein gleichzeitiger
      # Anmeldeversuch nie eine halbe Datei liest.
      TMP="$CACHE.$$"
      printf '%s' "$ANTWORT" > "$TMP" 2>/dev/null && mv -f "$TMP" "$CACHE" 2>/dev/null || rm -f "$TMP"
    else
      rm -f "$CACHE" 2>/dev/null || true
    fi
  fi
  exit 0
fi

# Ab hier: Die API war nicht erreichbar. Der letzte bekannte Stand gilt,
# aber nicht ewig — ein Host, der seit Wochen niemanden mehr fragen kann,
# soll nicht auf unbestimmte Zeit Zugaenge offenhalten, die laengst
# entzogen sein koennten.
if [ -r "$CACHE" ]; then
  MAX_TAGE=${CACHE_MAX_TAGE:-7}
  if [ -z "$(find "$CACHE" -mtime +"$MAX_TAGE" 2>/dev/null)" ]; then
    cat "$CACHE"
  fi
fi
exit 0
