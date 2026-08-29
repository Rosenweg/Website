#!/bin/sh
# Sitzung an- und abmelden — für Stationen und Laptops
#
# Gehört ins Repo os-stationen, nicht hierher. Es liegt hier nur, damit
# die beiden Enden zusammen entstehen und niemand raten muss, welchen
# Vertrag die Gegenseite erwartet.
#
# Installation auf der Station als /usr/local/bin/rw-sitzung-melden,
# aufgerufen von PAM bei An- und Abmeldung:
#
#   # /etc/pam.d/common-session (oder die Datei der Anzeigeverwaltung)
#   session optional pam_exec.so quiet /usr/local/bin/rw-sitzung-melden
#
# PAM setzt dabei PAM_USER und PAM_TYPE (open_session / close_session).
#
# ── Warum überhaupt ──────────────────────────────────────────────────
#
# Ein Server steht dauerhaft; eine Station gehört während einer Sitzung
# einem Menschen. Der SSH-Zugang soll deshalb mit der Anmeldung
# entstehen und mit der Abmeldung vergehen. Die Zugriffsmatrix bleibt
# gültig, bekommt aber eine zweite Bedingung.
#
# Technik ist davon ausgenommen — eine Station, an der niemand sitzt,
# wäre sonst für niemanden erreichbar, und ausgerechnet dann braucht man
# sie am ehesten.
#
# ── Was hier bewusst nicht passiert ──────────────────────────────────
#
# Das Skript blockiert nie und scheitert nie laut. Es hängt im
# Anmeldepfad: Wer sich an der Station anmeldet, wartet darauf. Eine
# unerreichbare API darf niemanden vom eigenen Rechner aussperren, also
# ist das Zeitlimit knapp und jeder Fehler folgenlos.
set -u

KONF=${RW_SSH_KONF:-/etc/rosenweg-ssh.conf}
[ -r "$KONF" ] || exit 0
# shellcheck disable=SC1090
. "$KONF"

: "${API_BASE:=}" "${HOST_TOKEN:=}" "${HOST_NAME:=$(hostname -s)}"
[ -n "$API_BASE" ] && [ -n "$HOST_TOKEN" ] || exit 0

LOGIN=$(printf '%s' "${PAM_USER:-${1:-}}" | tr '[:upper:]' '[:lower:]')
TYP=${PAM_TYPE:-${2:-open_session}}

# Dienstkonten und alles Ungewöhnliche gehen uns nichts an.
case "$LOGIN" in
  '' | . | .. | root | rw-keys ) exit 0 ;;
  *[!a-z0-9._-]* ) exit 0 ;;
esac

case "$TYP" in
  open_session)  METHODE=POST ;;
  close_session) METHODE=DELETE ;;
  *) exit 0 ;;
esac

# Zwei Sekunden. Mehr darf eine Anmeldung an dieser Stelle nicht kosten.
ZEIT=${SITZUNG_TIMEOUT_S:-2}

if command -v curl >/dev/null 2>&1; then
  curl -fsS --max-time "$ZEIT" -X "$METHODE" \
    -H "X-Host-Token: $HOST_TOKEN" -H "X-Host-Name: $HOST_NAME" \
    -H "Content-Type: application/json" \
    --data "{\"login\":\"$LOGIN\"}" \
    "$API_BASE/api/ssh/sitzung" >/dev/null 2>&1 || true
elif command -v wget >/dev/null 2>&1; then
  wget -q -O - -T "$ZEIT" --method="$METHODE" \
    --header="X-Host-Token: $HOST_TOKEN" --header="X-Host-Name: $HOST_NAME" \
    --header="Content-Type: application/json" \
    --body-data="{\"login\":\"$LOGIN\"}" \
    "$API_BASE/api/ssh/sitzung" >/dev/null 2>&1 || true
fi

exit 0
