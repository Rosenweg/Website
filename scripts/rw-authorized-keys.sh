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

# Schluessel nur fuer Konten, die rw-konten-sync angelegt hat (Gruppe
# rw-verwaltet). Sonst bekaeme ein lokales Betriebskonto (claude, ansible,
# github, ubuntu, pi ...) die Portal-Schluessel einer Person gleichen
# Namens. Ausnahmen je Host nur ausdruecklich in der Konfiguration:
# SCHLUESSEL_AUCH_FUER="stefan.mueller andere.person" (leerzeichengetrennt).
: "${SCHLUESSEL_AUCH_FUER:=}"
_erlaubt=0
if id -nG "$LOGIN" 2>/dev/null | tr ' ' '\n' | grep -qx rw-verwaltet; then
  _erlaubt=1
else
  for _a in $SCHLUESSEL_AUCH_FUER; do
    [ "$_a" = "$LOGIN" ] && _erlaubt=1
  done
fi
if [ "$_erlaubt" != 1 ]; then
  rm -f "$CACHE" 2>/dev/null || true
  exit 0
fi

# Entscheidend ist der Exitcode, nicht der Text. Eine leere Antwort mit
# Status 200 heisst "diese Person darf hier nicht mehr" — der Cache muss
# dann weg, sonst greift ein Entzug nie. Nur wenn curl selbst scheitert
# (kein Netz, API tot, 5xx), gilt der letzte bekannte Stand.
# Nicht jeder Container hat curl. Von 33 hatten es 11 — die uebrigen
# holten stillschweigend gar nichts, und die Aufnahme sah trotzdem
# erfolgreich aus. Also wird genommen, was da ist. Beide liefern 0 bei
# HTTP 200 und einen Fehler bei 4xx/5xx oder ausgefallenem Netz; die
# Unterscheidung "kein Zugang" gegen "nicht erreichbar" bleibt damit
# erhalten, und daran haengt, ob der Zwischenspeicher gilt.
#
# curl: Der Host-Token geht ueber stdin (-K -, Konfig-Zeile "header = ..."),
# nicht als Argument — sonst steht er fuer jeden lokalen Benutzer in der
# Prozessliste (/proc/*/cmdline). -K - statt -H @- (R3-Ie): -H @- kennt
# curl erst ab 7.55, aeltere Container haetten den Token gar nicht gesendet.
# Der Statuscode haengt als letzte Zeile an der Antwort: 400/404 heisst "gibt
# es nicht / ungueltig" und ist eine endgueltige Absage — dann darf auch der
# Zwischenspeicher nicht mehr gelten. Nur Netz-, 5xx- und Token-Fehler
# (401/403, Fehlkonfiguration des Hosts) fallen auf den letzten Stand zurueck.
# hole setzt ANTWORT direkt (kein $(...)), damit ABSAGE nicht in einer
# Subshell verloren geht.
ABSAGE=0
ANTWORT=
# Wert fuer eine curl-Konfigzeile in "...": \ und " maskieren.
kq() { printf '%s' "$1" | sed 's/[\\"]/\\&/g'; }
hole() {
  if command -v curl >/dev/null 2>&1; then
    _roh=$(printf 'header = "X-Host-Token: %s"\nheader = "X-Host-Name: %s"\n' "$(kq "$HOST_TOKEN")" "$(kq "$HOST_NAME")" | \
      curl -sS --max-time "${TIMEOUT:-3}" -K - -w '\n%{http_code}' "$1" 2>/dev/null) || return 1
    _code=$(printf '%s' "$_roh" | tail -n 1)
    _text=$(printf '%s' "$_roh" | sed '$d')
    case "$_code" in
      2??) ANTWORT=$_text; return 0 ;;
      400|404) ABSAGE=1; return 1 ;;
      *) return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    # wget kennt keinen Header aus stdin; der Token steht hier kurz in der
    # Prozessliste. curl nachinstallieren behebt das.
    # Statuscode aus den Serverkopfzeilen (-S, stderr) lesen (R3-Ia): wget
    # endet bei 400/404 genauso mit Fehler wie bei 5xx — ohne Unterscheidung
    # galt fuer ein entzogenes/geloeschtes Login weiter der Zwischenspeicher.
    # GNU- und BusyBox-wget schreiben beide eine Zeile "HTTP/1.1 404 ...".
    _err=$(mktemp "${TMPDIR:-/tmp}/rw-keys.XXXXXX" 2>/dev/null) || return 1
    if ANTWORT=$(wget -q -S -O - -T "${TIMEOUT:-3}" \
         --header="X-Host-Token: $HOST_TOKEN" --header="X-Host-Name: $HOST_NAME" "$1" 2>"$_err"); then
      rm -f "$_err"
      return 0
    fi
    _code=$(grep -oE 'HTTP/[0-9.]+ [0-9]{3}' "$_err" 2>/dev/null | tail -n 1 | grep -oE '[0-9]{3}$' || true)
    rm -f "$_err"
    case "$_code" in
      400|404) ABSAGE=1 ;;
    esac
    return 1
  else
    return 127
  fi
}

if hole "$API_BASE/api/ssh/authorized-keys/$LOGIN"; then
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

# Endgueltige Absage der API: kein Zugang, auch nicht aus dem Zwischenspeicher.
if [ "$ABSAGE" = 1 ]; then
  rm -f "$CACHE" 2>/dev/null || true
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
