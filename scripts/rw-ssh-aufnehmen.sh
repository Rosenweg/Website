#!/bin/bash
# Rosenweg SSH-Zugang: einen Proxmox-Knoten und seine Container aufnehmen
#
# Auf einem pve-Knoten als root ausfuehren. Richtet den Knoten selbst
# ein und auf Wunsch gleich alle laufenden Container per pct — ohne dass
# man sich in jeden einzeln anmelden muesste.
#
# ERZEUGT von scripts/rw-ssh-aufnehmen-bauen.py am 2026-08-29.
# Nicht von Hand aendern — die Quellen liegen in scripts/.
#
#   ./rw-ssh-aufnehmen.sh --api https://www.rosenweg4303.ch --token GEHEIM
#   ./rw-ssh-aufnehmen.sh --api ... --token ... --auch-cts
#   ./rw-ssh-aufnehmen.sh --api ... --token ... --auch-cts --probelauf
#
# Wiederholbar: Ein zweiter Lauf aendert nichts, was schon stimmt.
set -euo pipefail

API_BASE=""; HOST_TOKEN=""; AUCH_CTS=0; PROBE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --api)       API_BASE="${2:-}"; shift 2 ;;
    --token)     HOST_TOKEN="${2:-}"; shift 2 ;;
    --auch-cts)  AUCH_CTS=1; shift ;;
    --probelauf) PROBE=1; shift ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$API_BASE" ] && [ -n "$HOST_TOKEN" ] || { echo "Fehlt: --api und --token" >&2; exit 2; }

sage() { printf '  %s\n' "$*"; }
tun()  { if [ "$PROBE" = 1 ]; then printf '  [Probelauf] %s\n' "$*"; else eval "$@"; fi; }

ABLAGE=$(mktemp -d /tmp/rw-ssh.XXXXXX)
trap 'rm -rf "$ABLAGE"' EXIT

# ── Die Dateien, unveraendert aus dem Repo ──────────────────────────

cat > "$ABLAGE/rw-authorized-keys" <<'RW_AUTHKEYS_EOF'
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
# Nicht jeder Container hat curl. Von 33 hatten es 11 — die uebrigen
# holten stillschweigend gar nichts, und die Aufnahme sah trotzdem
# erfolgreich aus. Also wird genommen, was da ist. Beide liefern 0 bei
# HTTP 200 und einen Fehler bei 4xx/5xx oder ausgefallenem Netz; die
# Unterscheidung "kein Zugang" gegen "nicht erreichbar" bleibt damit
# erhalten, und daran haengt, ob der Zwischenspeicher gilt.
hole() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time "${TIMEOUT:-3}" \
         -H "X-Host-Token: $HOST_TOKEN" -H "X-Host-Name: $HOST_NAME" "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O - -T "${TIMEOUT:-3}" \
         --header="X-Host-Token: $HOST_TOKEN" --header="X-Host-Name: $HOST_NAME" "$1" 2>/dev/null
  else
    return 127
  fi
}

if ANTWORT=$(hole "$API_BASE/api/ssh/authorized-keys/$LOGIN"); then
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
RW_AUTHKEYS_EOF

cat > "$ABLAGE/rw-konten-sync" <<'RW_KONTEN_EOF'
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
  # Fehlt sudo, weil es hier niemand haben soll, ist nichts zu tun.
  # Gewaehrt die Matrix aber jemandem sudo auf diesem Host, dann waere
  # Schweigen der dritte Fall derselben Sorte: eine Berechtigung, die im
  # Datensatz steht und nirgends wirkt. Also nachinstallieren — aber nur
  # dann, sonst legten wir auf jedem Frontend einen Rechteweg an, den
  # niemand braucht.
  if printf '%s' "$SOLL" | grep -q '|ja|'; then
    echo "rw-konten-sync: sudo ist vorgesehen, aber nicht installiert — wird nachgeholt"
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo >/dev/null 2>&1 || true
    elif command -v apk >/dev/null 2>&1; then apk add --no-cache sudo >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then dnf install -y -q sudo >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then yum install -y -q sudo >/dev/null 2>&1 || true
    fi
  fi
fi
if ! command -v visudo >/dev/null 2>&1; then
  if printf '%s' "$SOLL" | grep -q '|ja|'; then
    echo "rw-konten-sync: ACHTUNG — sudo laut Matrix vorgesehen, liess sich aber nicht installieren" >&2
  else
    echo "rw-konten-sync: kein sudo auf diesem Host, auch keines vorgesehen — uebersprungen"
  fi
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
RW_KONTEN_EOF

cat > "$ABLAGE/rw-konten-sync.service" <<'RW_SERVICE_EOF'
[Unit]
Description=Unix-Konten und sudo aus der Rosenweg-Zugriffsmatrix nachführen
Documentation=file:/usr/local/bin/rw-konten-sync
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/rw-konten-sync
# Ein Fehlschlag ist kein Notfall: Erreicht das Skript die API nicht,
# lässt es alles unverändert, und der nächste Lauf holt den Stand nach.
Nice=10
RW_SERVICE_EOF

cat > "$ABLAGE/rw-konten-sync.timer" <<'RW_TIMER_EOF'
[Unit]
Description=Zugriffsmatrix regelmässig in Konten und sudoers übertragen

[Timer]
# Alle 5 Minuten. SSH-Schlüssel wirken sofort, weil sshd bei jeder
# Anmeldung frisch fragt — Konten und sudo hängen dagegen an diesem
# Lauf. Wer neu freigegeben wird, wartet also höchstens fünf Minuten
# auf sein Konto, und ein Entzug greift ebenso schnell.
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30s
Persistent=true

[Install]
WantedBy=timers.target
RW_TIMER_EOF

chmod 0755 "$ABLAGE/rw-authorized-keys" "$ABLAGE/rw-konten-sync"

# ── Einrichten auf dem laufenden System ─────────────────────────────
# $1 = Name, unter dem sich der Host bei der API meldet
einrichten_hier() {
  local name="$1"

  # Nicht ueber tun(): Das druckt im Probelauf den ganzen Befehl, und
  # der enthaelt das Token. Ein Trockenlauf soll zeigen, was geschieht,
  # ohne dabei das Geheimnis auf den Bildschirm und ins Protokoll zu
  # legen — dort steht es dann laenger, als irgendwem lieb ist.
  if [ "$PROBE" = 1 ]; then
    sage "[Probelauf] /etc/rosenweg-ssh.conf schreiben (API_BASE=$API_BASE, HOST_NAME=$name, HOST_TOKEN verdeckt)"
  else
    printf '%s\n' "API_BASE=$API_BASE" "HOST_TOKEN=$HOST_TOKEN" "HOST_NAME=$name" > /etc/rosenweg-ssh.conf
    chmod 0640 /etc/rosenweg-ssh.conf
  fi

  # Eigener Benutzer fuer die Schluesselabfrage — nicht nobody, denn in
  # der Konfigurationsdatei liegt das Token.
  if ! id -u rw-keys >/dev/null 2>&1; then
    tun "useradd --system --no-create-home --shell /usr/sbin/nologin rw-keys"
  fi
  tun "chown root:rw-keys /etc/rosenweg-ssh.conf"
  tun "install -d -o rw-keys -g rw-keys -m 0750 /var/cache/rosenweg-ssh"
  tun "install -d -m 0750 /var/lib/rosenweg-ssh/gesperrt"

  tun "install -m 0755 '$ABLAGE/rw-authorized-keys' /usr/local/bin/rw-authorized-keys"
  tun "install -m 0755 '$ABLAGE/rw-konten-sync'     /usr/local/bin/rw-konten-sync"

  # sshd: bevorzugt ein Schnipsel in sshd_config.d — aber nur, wenn die
  # Hauptdatei es auch einliest. Aeltere Debian-Fassungen tun das nicht,
  # dort waere die Datei wirkungslos und wir haetten es nicht gemerkt.
  if [ -d /etc/ssh/sshd_config.d ] && grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config; then
    ziel=/etc/ssh/sshd_config.d/50-rosenweg.conf
  else
    ziel=/etc/ssh/sshd_config
  fi
  if grep -q 'rw-authorized-keys' "$ziel" 2>/dev/null; then
    sage "sshd: Eintrag steht bereits in $ziel"
  else
    tun "printf '%s\n' '' '# Rosenweg: Schluessel kommen aus dem Profil' 'AuthorizedKeysCommand /usr/local/bin/rw-authorized-keys %u' 'AuthorizedKeysCommandUser rw-keys' >> $ziel"
    sage "sshd: Eintrag in $ziel ergaenzt"
  fi

  # Auch der Knoten braucht ein Werkzeug, um die API zu fragen. Auf
  # einem pve ist curl praktisch immer da — aber "praktisch immer" ist
  # der Grund, warum es bei 22 Containern niemandem auffiel.
  if [ "$PROBE" = 0 ] && ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    sage "weder curl noch wget — wird nachinstalliert"
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl >/dev/null 2>&1 || true
    elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then dnf install -y -q curl >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then yum install -y -q curl >/dev/null 2>&1 || true
    fi
    if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
      sage "curl nachinstalliert"
    else
      echo "  ACHTUNG: weder curl noch wget — dieser Knoten kann keine Schluessel holen" >&2
    fi
  fi

  if [ "$PROBE" = 0 ]; then
  # sudo gehoert dazu: Technik hat laut Matrix auf JEDEM Host
  # passwortloses sudo — das ist fest verdrahtet, nicht verhandelbar.
  # Fehlt das Programm, ist diese Berechtigung eine Behauptung ohne
  # Wirkung, derselbe stille Fehler wie zuvor bei curl. Also mitbringen.
  if ! command -v visudo >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo >/dev/null 2>&1 || true
    elif command -v apk >/dev/null 2>&1; then apk add --no-cache sudo >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then dnf install -y -q sudo >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then yum install -y -q sudo >/dev/null 2>&1 || true
    fi
    command -v visudo >/dev/null 2>&1 \
      && echo "  sudo nachinstalliert" \
      || echo "  ACHTUNG: sudo liess sich nicht installieren — passwortloses sudo bleibt hier wirkungslos" >&2
  fi
  fi

  # Erst pruefen, dann neu laden. Eine kaputte sshd-Konfiguration sperrt
  # aus, und zwar genau den, der sie reparieren muesste.
  if [ "$PROBE" = 0 ]; then
    mkdir -p /run/sshd
    if sshd -t 2>/dev/null; then
      if systemctl is-active --quiet ssh.service 2>/dev/null; then
        timeout 20 systemctl reload ssh 2>/dev/null || sage "sshd: Neuladen abgebrochen, Konfiguration liegt bereit"
        sage "sshd: geprueft und neu geladen"
      elif systemctl is-active --quiet sshd.service 2>/dev/null; then
        timeout 20 systemctl reload sshd 2>/dev/null || sage "sshd: Neuladen abgebrochen, Konfiguration liegt bereit"
        sage "sshd: geprueft und neu geladen"
      else
        sage "sshd laeuft nicht als Dienst (socket-aktiviert) — kein Neuladen noetig"
      fi
    else
      echo "  ACHTUNG: sshd -t meldet einen Fehler — nicht neu geladen." >&2
      sshd -t || true
      return 1
    fi
  fi

  if [ -d /run/systemd/system ]; then
    tun "install -m 0644 '$ABLAGE/rw-konten-sync.service' '$ABLAGE/rw-konten-sync.timer' /etc/systemd/system/"
    tun "systemctl daemon-reload"
    tun "systemctl enable --now rw-konten-sync.timer"
    tun "systemctl start rw-konten-sync.service"
    sage "Konten-Abgleich: Timer laeuft"
  else
    sage "Konten-Abgleich: kein systemd — uebersprungen"
  fi

  if [ "$PROBE" = 0 ]; then
    if curl -fsS --max-time 10 -H "X-Host-Token: $HOST_TOKEN" -H "X-Host-Name: $name" \
         "$API_BASE/api/ssh/konten" >/dev/null 2>&1; then
      sage "API erreichbar — $name ist aufgenommen"
    else
      echo "  ACHTUNG: $name erreicht die API nicht ($API_BASE). Netz oder Token pruefen." >&2
    fi
  fi
}

# ── Einrichten in einem Container, von aussen per pct ────────────────
einrichten_ct() {
  local id="$1" name="$2"
  sage "→ CT $id ($name)"

  if [ "$PROBE" = 1 ]; then
    printf '  [Probelauf] pct push/exec fuer CT %s\n' "$id"; return 0
  fi

  pct push "$id" "$ABLAGE/rw-authorized-keys"       /usr/local/bin/rw-authorized-keys --perms 755
  pct push "$id" "$ABLAGE/rw-konten-sync"           /usr/local/bin/rw-konten-sync     --perms 755
  pct push "$id" "$ABLAGE/rw-konten-sync.service"   /etc/systemd/system/rw-konten-sync.service --perms 644
  pct push "$id" "$ABLAGE/rw-konten-sync.timer"     /etc/systemd/system/rw-konten-sync.timer   --perms 644

  # Das Einrichtungsskript wird als Datei hineingelegt und dort
  # ausgefuehrt. Frueher stand es hier als Here-Dokument an
  # `pct exec -- bash -s`, und das haengt: lxc-attach schliesst die
  # Eingabe nicht, die Shell im Container wartet ewig auf mehr Zeilen,
  # und der ganze Lauf steht still. Am 29. August 2026 so erlebt —
  # neunundzwanzig Minuten am allerersten Container, ohne ein Zeichen.
  # Das timeout ist der zweite Riegel: Ein einzelner stoerrischer
  # Container darf die anderen dreissig nicht aufhalten. Fuenf Minuten,
  # weil eine Paketinstallation ueber apt laenger braucht als zwei.
  cat > "$ABLAGE/ct-setup.sh" <<CTEOF
#!/bin/bash
set -e
printf '%s\n' 'API_BASE=$API_BASE' 'HOST_TOKEN=$HOST_TOKEN' 'HOST_NAME=$name' > /etc/rosenweg-ssh.conf
chmod 0640 /etc/rosenweg-ssh.conf
id -u rw-keys >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin rw-keys
chown root:rw-keys /etc/rosenweg-ssh.conf
install -d -o rw-keys -g rw-keys -m 0750 /var/cache/rosenweg-ssh
install -d -m 0750 /var/lib/rosenweg-ssh/gesperrt
if [ -d /etc/ssh/sshd_config.d ] && grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config; then
  ziel=/etc/ssh/sshd_config.d/50-rosenweg.conf
else
  ziel=/etc/ssh/sshd_config
fi
if ! grep -q 'rw-authorized-keys' "\$ziel" 2>/dev/null; then
  printf '%s\n' '' '# Rosenweg: Schluessel kommen aus dem Profil' 'AuthorizedKeysCommand /usr/local/bin/rw-authorized-keys %u' 'AuthorizedKeysCommandUser rw-keys' >> "\$ziel"
fi
# Ohne curl oder wget holt dieser Host nie einen Schluessel. Die
# Aufnahme sieht dann erfolgreich aus und ist es nicht — genau so bei
# 22 von 33 Containern geschehen, ohne dass es jemandem auffiel. Also
# wird nachinstalliert statt nur gewarnt.
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  echo "  weder curl noch wget — wird nachinstalliert"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl >/dev/null 2>&1 || true
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl >/dev/null 2>&1 || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q curl >/dev/null 2>&1 || true
  fi
  if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
    echo "  curl nachinstalliert"
  else
    echo "  ACHTUNG: Nachinstallation fehlgeschlagen — dieser Host kann keine Schluessel holen" >&2
  fi
fi
# sudo gehoert dazu: Technik hat laut Matrix auf JEDEM Host
# passwortloses sudo — das ist fest verdrahtet, nicht verhandelbar.
# Fehlt das Programm, ist diese Berechtigung eine Behauptung ohne
# Wirkung, derselbe stille Fehler wie zuvor bei curl. Also mitbringen.
if ! command -v visudo >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo >/dev/null 2>&1 || true
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache sudo >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q sudo >/dev/null 2>&1 || true
  elif command -v yum >/dev/null 2>&1; then yum install -y -q sudo >/dev/null 2>&1 || true
  fi
  command -v visudo >/dev/null 2>&1 \
    && echo "  sudo nachinstalliert" \
    || echo "  ACHTUNG: sudo liess sich nicht installieren — passwortloses sudo bleibt hier wirkungslos" >&2
fi
# sshd -t braucht /run/sshd, auch wenn es nur pruefen soll. In einem
# Container, in dem sshd nie lief, fehlt das Verzeichnis — der Test
# scheitert dann an "Missing privilege separation directory" und sagt
# ueber die Konfiguration gar nichts aus. Also vorher anlegen.
mkdir -p /run/sshd
if sshd -t 2>/dev/null; then
  # Mit Zeitgrenze. In CT 100 hing `systemctl reload ssh` mehr als eine
  # halbe Stunde, und weil systemd Auftraege aufreiht, stellte sich jeder
  # weitere Versuch dahinter an — der ganze Lauf stand. Kommt das Neuladen
  # nicht zurueck, liegt die Konfiguration trotzdem richtig und greift
  # beim naechsten Start von sshd.
  # Nur neu laden, was auch laeuft. Ist sshd socket-aktiviert, ist die
  # Unit inaktiv — ein reload darauf scheitert und hinterlaesst sie im
  # Fehlerzustand. Genau so habe ich am 29.08.2026 auf 31 Containern ein
  # "failed" erzeugt, das niemandem etwas tat ausser Laerm in der Wacht.
  # Noetig ist es dort ohnehin nicht: Bei Socket-Aktivierung startet
  # sshd je Verbindung neu und liest die Konfiguration dabei frisch.
  if systemctl is-active --quiet ssh.service 2>/dev/null; then
    timeout 20 systemctl reload ssh 2>/dev/null || echo "  Hinweis: Neuladen abgebrochen, Konfiguration liegt bereit"
  elif systemctl is-active --quiet sshd.service 2>/dev/null; then
    timeout 20 systemctl reload sshd 2>/dev/null || echo "  Hinweis: Neuladen abgebrochen, Konfiguration liegt bereit"
  else
    echo "  sshd laeuft nicht als Dienst (socket-aktiviert) — kein Neuladen noetig"
else
  echo "  ACHTUNG in CT $id: sshd -t meldet einen Fehler — nicht neu geladen." >&2
  exit 1
fi
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable --now rw-konten-sync.timer
  systemctl start rw-konten-sync.service || true
fi
CTEOF

  pct push "$id" "$ABLAGE/ct-setup.sh" /tmp/rw-setup.sh --perms 700
  if timeout 300 pct exec "$id" -- bash /tmp/rw-setup.sh; then
    sage "   fertig"
  else
    echo "  CT $id: Einrichtung fehlgeschlagen oder abgelaufen" >&2
  fi
  # Der Token steht in dieser Datei — sie darf nicht liegen bleiben.
  pct exec "$id" -- rm -f /tmp/rw-setup.sh 2>/dev/null || true
}

# ── Ablauf ──────────────────────────────────────────────────────────
NAME=$(hostname -s)
echo
echo "Rosenweg SSH-Zugang aufnehmen"
echo "  API:   $API_BASE"
echo "  Host:  $NAME"
[ "$PROBE" = 1 ] && echo "  MODUS: Probelauf — es wird nichts geaendert"
echo

sage "→ Knoten $NAME"
einrichten_hier "$NAME"

if [ "$AUCH_CTS" = 1 ]; then
  command -v pct >/dev/null 2>&1 || { echo "pct nicht gefunden — kein Proxmox-Knoten?" >&2; exit 1; }
  echo
  pct list | awk 'NR>1 && $2=="running" {print $1, $NF}' | while read -r id ctname; do
    einrichten_ct "$id" "${ctname:-ct$id}" || echo "  CT $id fehlgeschlagen — weiter" >&2
  done
fi

echo
echo "Fertig. Die Hosts erscheinen in der Zugriffsmatrix, sobald sie das"
echo "erste Mal Schluessel abholen — unter /ssh-zugriffsmatrix.html."
echo "WICHTIG: Diese Sitzung offen lassen und mit einer zweiten Anmeldung"
echo "pruefen, bevor du sie schliesst."
