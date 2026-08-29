#!/bin/bash
# Dienstwacht: schaut in jeden Container und meldet, was klemmt
#
# Auf einem Proxmox-Knoten als root, ueber rw-dienstwacht.timer.
# Installiert als /usr/local/bin/rw-dienstwacht.
#
# Warum es das braucht: Proxmox weiss nur, ob ein Container laeuft. Das
# ist zu wenig. Am 29. August 2026 standen drei Ausfaelle zwischen vier
# und siebzehn Tagen unbemerkt — leere VLAN-Tabellen im VPN, ein
# haengendes networking.service, ein toter Domaenencontroller. Alle drei
# Container liefen dabei tadellos. Kaputt war der Dienst darin, und
# dafuer schaute niemand hin.
#
# Gesucht wird zweierlei:
#
#   * Units im Zustand "failed" — der offensichtliche Fall.
#   * Units, die zu lange "activating" sagen. Das ist der heimtueckische:
#     systemd reiht Auftraege auf, und ein Dienst, der nie fertig wird,
#     blockiert alle nachfolgenden. Auf CT 100 wartete networking.service
#     vier Tage auf einen DHCP-Server, den es nicht gibt, und siebzehn
#     andere Auftraege standen dahinter. Nichts davon war "failed".
set -euo pipefail

KONF=${RW_SSH_KONF:-/etc/rosenweg-ssh.conf}
[ -r "$KONF" ] || { echo "rw-dienstwacht: $KONF fehlt" >&2; exit 1; }
# shellcheck disable=SC1090
. "$KONF"

: "${API_BASE:=}" "${HOST_TOKEN:=}" "${HOST_NAME:=$(hostname -s)}"
[ -n "$API_BASE" ] && [ -n "$HOST_TOKEN" ] || { echo "rw-dienstwacht: API_BASE/HOST_TOKEN fehlen" >&2; exit 1; }

# Ab wann gilt "activating" als haengend. Ein Dienst darf beim Start
# ruhig eine Weile brauchen; nach fuenf Minuten wartet er nicht mehr,
# sondern haengt.
: "${ACTIVATING_GRENZE_S:=300}"
# Wie lange wir einem Container Zeit geben. Er soll die Wacht nicht
# aufhalten — wer nicht antwortet, ist selbst ein Befund.
: "${CT_TIMEOUT_S:=20}"

BERICHT=$(mktemp /tmp/rw-wacht.XXXXXX)
trap 'rm -f "$BERICHT"' EXIT
: > "$BERICHT"

# Units, die in einem LXC praktisch immer scheitern, weil der Container
# den Kernel nicht anfassen darf. Sie zu melden hiesse, die Wacht mit
# Rauschen zu fuellen — beim ersten Lauf waren 32 von 74 Befunden von
# dieser Sorte, und eine Meldung, in der man suchen muss, liest bald
# niemand mehr. Das ist keine Bequemlichkeit, sondern die Bedingung
# dafuer, dass die uebrigen Befunde auffallen.
IGNORIEREN="tmp.mount run-lock.mount dev-mqueue.mount dev-hugepages.mount
sys-kernel-config.mount sys-kernel-debug.mount sys-kernel-tracing.mount
systemd-journald-audit.socket proc-sys-fs-binfmt_misc.mount"

uninteressant() {
  case " $(echo $IGNORIEREN) " in *" $1 "*) return 0 ;; esac
  return 1
}

# Sammelt Befunde eines Systems. $1 = Anzeigename, $2 = Praefix fuer den
# Aufruf (leer = hier, sonst "pct exec <id> --").
sammeln() {
  local name="$1"; shift
  local ausgabe

  # failed: der klare Fall.
  ausgabe=$("$@" systemctl list-units --state=failed --no-legend --plain 2>/dev/null | awk '{print $1}' || true)
  while IFS= read -r unit; do
    [ -n "$unit" ] || continue
    uninteressant "$unit" && continue
    printf '%s\t%s\t%s\n' "$name" "$unit" "failed" >> "$BERICHT"
  done <<< "$ausgabe"

  # activating: nur, wenn es zu lange dauert. systemd nennt die
  # Zeitmarke in Mikrosekunden seit dem Start des Vorgangs.
  ausgabe=$("$@" systemctl list-units --state=activating --no-legend --plain 2>/dev/null | awk '{print $1}' || true)
  while IFS= read -r unit; do
    [ -n "$unit" ] || continue
    uninteressant "$unit" && continue
    local seit jetzt alter
    seit=$("$@" systemctl show "$unit" -p InactiveExitTimestampMonotonic --value 2>/dev/null || echo 0)
    jetzt=$("$@" sh -c 'cut -d" " -f1 /proc/uptime' 2>/dev/null || echo 0)
    # Monotonic in Sekunden gegen die Laufzeit des Systems rechnen.
    alter=$(awk -v s="${seit:-0}" -v j="${jetzt:-0}" 'BEGIN{ printf "%d", j - (s/1000000) }' 2>/dev/null || echo 0)
    if [ "${alter:-0}" -ge "$ACTIVATING_GRENZE_S" ] 2>/dev/null; then
      printf '%s\t%s\t%s\n' "$name" "$unit" "activating" >> "$BERICHT"
    fi
  done <<< "$ausgabe"
}

# ── Der Knoten selbst ───────────────────────────────────────────────
sammeln "$HOST_NAME" env

# ── Seine Container ─────────────────────────────────────────────────
if command -v pct >/dev/null 2>&1; then
  while read -r id ctname; do
    [ -n "$id" ] || continue
    # Ohne systemd gibt es nichts zu holen — kein Befund, kein Fehler.
    if ! timeout "$CT_TIMEOUT_S" pct exec "$id" -- test -d /run/systemd/system 2>/dev/null; then
      continue
    fi
    sammeln "ct$id-${ctname:-unbenannt}" timeout "$CT_TIMEOUT_S" pct exec "$id" --
  done < <(pct list | awk 'NR>1 && $2=="running" {print $1, $NF}')
fi

# ── Melden ──────────────────────────────────────────────────────────
KOERPER=$(python3 -c '
import json, sys
befunde = []
for zeile in sys.stdin:
    teile = zeile.rstrip("\n").split("\t")
    if len(teile) != 3:
        continue
    host, unit, zustand = teile
    befunde.append({
        "host": host[:120],
        "unit": unit[:160],
        "zustand": zustand,
        "ebene": "knoten" if "-" not in host and not host.startswith("ct") else "container",
    })
print(json.dumps({"knoten": sys.argv[1], "befunde": befunde}))
' "$HOST_NAME" < "$BERICHT")

melden() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 20 -X POST \
      -H "X-Host-Token: $HOST_TOKEN" -H "X-Host-Name: $HOST_NAME" \
      -H "Content-Type: application/json" --data "$KOERPER" \
      "$API_BASE/api/ssh/dienste"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O - -T 20 --method=POST \
      --header="X-Host-Token: $HOST_TOKEN" --header="X-Host-Name: $HOST_NAME" \
      --header="Content-Type: application/json" --body-data="$KOERPER" \
      "$API_BASE/api/ssh/dienste"
  else
    echo "rw-dienstwacht: weder curl noch wget" >&2; return 127
  fi
}

if ! ANTWORT=$(melden); then
  echo "rw-dienstwacht: Meldung an $API_BASE fehlgeschlagen" >&2
  exit 1
fi
echo "rw-dienstwacht: $(wc -l < "$BERICHT") Befunde gemeldet — $ANTWORT"
