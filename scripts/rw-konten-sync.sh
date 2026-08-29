#!/bin/bash
# Unix-Konten und passwortloses sudo aus der Rosenweg-Zugriffsmatrix
#
# Laeuft als root ueber einen systemd-Timer (rw-konten-sync.timer),
# installiert als /usr/local/bin/rw-konten-sync. Holt die Liste der auf
# diesem Host Berechtigten und bringt das System in Deckung:
#
#   * fehlende Konten anlegen
#   * entzogene Konten sperren, spaeter loeschen
#   * /etc/sudoers.d/90-rosenweg neu schreiben
#
# Warum ueberhaupt Konten angelegt werden muessen: sshd weist eine
# Anmeldung fuer einen unbekannten Benutzer ab, bevor es je nach
# Schluesseln fragt. Ohne Konto nuetzt der schoenste Schluessel nichts.
#
# ── Die Regeln, an denen nicht zu ruetteln ist ──────────────────────
#
#   1. Wir fassen nur an, was wir selbst angelegt haben. Marker ist die
#      Gruppe rw-verwaltet. Ein von Hand angelegtes Konto gleichen
#      Namens bleibt unberuehrt — auch wenn es in der Matrix steht.
#   2. Nie Systemkonten. UID unter 1000 und root sind tabu, egal was
#      die Liste sagt.
#   3. Entzug wirkt sofort, die Loeschung folgt. Wer aus der Matrix
#      faellt, wird sofort gesperrt (keine Anmeldung, kein sudo) und
#      nach der Schonfrist samt Heimatverzeichnis entfernt. Das ist
#      endgueltig — von hier aus gibt es kein Zurueck und kein Backup.
#      Die Schonfrist ist die einzige Sicherung dagegen, dass ein
#      Fehler in der Matrix Daten kostet; 0 loescht beim naechsten Lauf.
#   4. Erreicht die API nicht, geschieht gar nichts. Ein Netzausfall
#      darf keine Konten sperren.
#   5. Nie ohne visudo -c installieren. Eine kaputte Datei in sudoers.d
#      macht sudo unbrauchbar — auch fuer den, der sie reparieren will.
set -euo pipefail

KONF=${RW_SSH_KONF:-/etc/rosenweg-ssh.conf}
[ -r "$KONF" ] || { echo "rw-konten-sync: $KONF fehlt" >&2; exit 1; }
# shellcheck disable=SC1090
. "$KONF"

: "${API_BASE:=}" "${HOST_TOKEN:=}" "${HOST_NAME:=$(hostname -s)}"
[ -n "$API_BASE" ] && [ -n "$HOST_TOKEN" ] || { echo "rw-konten-sync: API_BASE/HOST_TOKEN fehlen" >&2; exit 1; }

# Gesperrte Konten nach der Schonfrist endgueltig entfernen, mitsamt
# Heimatverzeichnis. KONTEN_LOESCHEN=nein belaesst es beim Sperren.
: "${KONTEN_LOESCHEN:=ja}"
: "${KONTEN_SCHONFRIST_TAGE:=30}"
: "${KONTEN_SHELL:=/bin/bash}"
# Namen, die nie angefasst werden, komma- oder leerzeichengetrennt.
: "${KONTEN_TABU:=root}"

GRUPPE=rw-verwaltet
STAND=/var/lib/rosenweg-ssh
ZIEL=/etc/sudoers.d/90-rosenweg
LOGIN_MUSTER='^[a-z_][a-z0-9._-]{0,31}$'

mkdir -p "$STAND/gesperrt"

tabu() {
  local l="$1"
  for t in ${KONTEN_TABU//,/ }; do [ "$l" = "$t" ] && return 0; done
  return 1
}

# Gehoert das Konto uns? Nur dann fassen wir es an.
unser() {
  local l="$1"
  id -nG "$l" 2>/dev/null | tr ' ' '\n' | grep -qx "$GRUPPE"
}

# ── Liste holen ─────────────────────────────────────────────────────
# Nimmt, was der Host hat. Von 33 Containern hatten nur 11 curl — die
# uebrigen holten stillschweigend nichts, und niemand merkte es.
hole() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 20 \
         -H "X-Host-Token: $HOST_TOKEN" -H "X-Host-Name: $HOST_NAME" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O - -T 20 \
         --header="X-Host-Token: $HOST_TOKEN" --header="X-Host-Name: $HOST_NAME" "$1"
  else
    echo "rw-konten-sync: weder curl noch wget vorhanden" >&2
    return 127
  fi
}

ANTWORT=$(hole "$API_BASE/api/ssh/konten") || {
    echo "rw-konten-sync: API nicht erreichbar — es wird nichts geaendert" >&2; exit 0; }

# Zu Zeilen "login|sudo|name". Die API filtert bereits, aber was hier
# in useradd und in eine sudoers-Datei geht, pruefen wir selbst.
SOLL=$(printf '%s' "$ANTWORT" | python3 -c '
import json, re, sys
m = re.compile(r"^[a-z_][a-z0-9._-]{0,31}$")
d = json.load(sys.stdin)
for k in d.get("konten", []):
    l = str(k.get("login", ""))
    if not m.match(l):
        continue
    name = re.sub(r"[^\w .-]", "", str(k.get("name", l)))[:60]
    print(f"{l}|{'"'"'ja'"'"' if k.get('"'"'sudo'"'"') else '"'"'nein'"'"'}|{name}")
') || { echo "rw-konten-sync: Antwort der API unlesbar" >&2; exit 1; }

SOLL_LOGINS=$(printf '%s' "$SOLL" | cut -d'|' -f1 | sort -u)

# ── 1. Anlegen, was fehlt ───────────────────────────────────────────
angelegt=0
if [ -n "$SOLL" ]; then
  getent group "$GRUPPE" >/dev/null 2>&1 || groupadd --system "$GRUPPE"
  while IFS='|' read -r login sudo_ja name; do
    [ -n "$login" ] || continue
    tabu "$login" && continue
    if id -u "$login" >/dev/null 2>&1; then
      # Konto da. Falls es unseres ist und gesperrt war: entsperren.
      if unser "$login" && [ -e "$STAND/gesperrt/$login" ]; then
        usermod --unlock --expiredate '' "$login" 2>/dev/null || true
        rm -f "$STAND/gesperrt/$login"
        echo "rw-konten-sync: $login wieder freigegeben"
      fi
      continue
    fi
    useradd --create-home --shell "$KONTEN_SHELL" \
            --groups "$GRUPPE" --comment "$name (Rosenweg)" "$login"
    # Kein Passwort setzen — die Anmeldung laeuft ueber den Schluessel.
    # '!' als Hash heisst: Passwort-Anmeldung unmoeglich, Konto aber aktiv.
    usermod --password '!' "$login" 2>/dev/null || true
    angelegt=$((angelegt + 1))
    echo "rw-konten-sync: $login angelegt"
  done <<< "$SOLL"
fi

# ── 2. Sperren, was nicht mehr in der Liste steht ───────────────────
gesperrt=0
if getent group "$GRUPPE" >/dev/null 2>&1; then
  # Nur Mitglieder unserer Gruppe, nur echte Benutzer-UIDs.
  for login in $(getent group "$GRUPPE" | cut -d: -f4 | tr ',' '\n' | grep -v '^$'; \
                 getent passwd | awk -F: -v g="$(getent group "$GRUPPE" | cut -d: -f3)" '$4==g{print $1}'); do
    tabu "$login" && continue
    uid=$(id -u "$login" 2>/dev/null || echo 0)
    [ "$uid" -ge 1000 ] 2>/dev/null || continue
    if printf '%s\n' "$SOLL_LOGINS" | grep -qx "$login"; then continue; fi
    if [ ! -e "$STAND/gesperrt/$login" ]; then
      usermod --lock --expiredate 1 "$login" 2>/dev/null || true
      date -Is > "$STAND/gesperrt/$login"
      gesperrt=$((gesperrt + 1))
      echo "rw-konten-sync: $login gesperrt (kein Zugriff mehr laut Matrix)"
    fi
  done
fi

# ── 3. Nach der Schonfrist loeschen, wenn eingeschaltet ─────────────
geloescht=0
if [ "$KONTEN_LOESCHEN" = "ja" ]; then
  for marke in "$STAND"/gesperrt/*; do
    [ -e "$marke" ] || continue
    login=$(basename "$marke")
    tabu "$login" && continue
    id -u "$login" >/dev/null 2>&1 || { rm -f "$marke"; continue; }
    unser "$login" || continue
    uid=$(id -u "$login")
    [ "$uid" -ge 1000 ] || continue
    faellig=nein
    if [ "$KONTEN_SCHONFRIST_TAGE" -eq 0 ]; then
      faellig=ja
    elif [ -n "$(find "$marke" -mtime +"$KONTEN_SCHONFRIST_TAGE" 2>/dev/null)" ]; then
      faellig=ja
    fi
    if [ "$faellig" = ja ]; then
      # --remove nimmt Heimatverzeichnis und Mail-Spool mit. Laufende
      # Sitzungen muessen vorher enden, sonst weigert sich userdel.
      pkill -KILL -u "$login" 2>/dev/null || true
      if userdel --remove "$login" 2>/dev/null; then
        rm -f "$marke"
        geloescht=$((geloescht + 1))
        echo "rw-konten-sync: $login endgueltig geloescht, Heimatverzeichnis entfernt"
      fi
    fi
  done
fi

# ── 4. sudoers schreiben ────────────────────────────────────────────
# Ohne sudo gibt es kein passwortloses sudo einzurichten — dann ist hier
# nichts zu tun, und das ist kein Fehler. Frueher brach das Skript an
# dieser Stelle ab, weil visudo fehlte, und liess damit auch das Anlegen
# der Konten als fehlgeschlagen erscheinen. Auf den Frontend-Containern
# traf das jeden einzelnen.
if ! command -v visudo >/dev/null 2>&1; then
  echo "rw-konten-sync: kein sudo auf diesem Host — sudoers uebersprungen"
  echo "rw-konten-sync: fertig — $angelegt angelegt, $gesperrt gesperrt, $geloescht geloescht"
  exit 0
fi

TMP=$(mktemp /tmp/rw-sudo.XXXXXX)
trap 'rm -f "$TMP"' EXIT
{
  echo "# Erzeugt von rw-konten-sync — nicht von Hand aendern."
  echo "# Quelle: Zugriffsmatrix auf $API_BASE, Host $HOST_NAME"
  echo "# Stand: $(date -Is)"
  eintraege=0
  if [ -n "$SOLL" ]; then
    while IFS='|' read -r login sudo_ja _name; do
      [ "$sudo_ja" = "ja" ] || continue
      tabu "$login" && continue
      if id -u "$login" >/dev/null 2>&1; then
        echo "$login ALL=(ALL) NOPASSWD: ALL"
        eintraege=$((eintraege + 1))
      fi
    done <<< "$SOLL"
  fi
  [ "$eintraege" -eq 0 ] && echo "# Zurzeit hat niemand passwortloses sudo auf diesem Host."
} > "$TMP"

chmod 0440 "$TMP"
if ! visudo -cf "$TMP" >/dev/null; then
  echo "rw-konten-sync: erzeugte sudoers-Datei ist fehlerhaft — $ZIEL bleibt unveraendert" >&2
  exit 1
fi
if [ ! -f "$ZIEL" ] || ! cmp -s "$TMP" "$ZIEL"; then
  install -m 0440 -o root -g root "$TMP" "$ZIEL"
  echo "rw-konten-sync: $ZIEL aktualisiert"
fi

echo "rw-konten-sync: fertig — $angelegt angelegt, $gesperrt gesperrt, $geloescht geloescht"
