#!/usr/bin/env python3
"""Baut scripts/rw-ssh-aufnehmen.sh aus den Host-Dateien daneben.

Das Aufnahme-Skript muss sich selbst genuegen: Es wird einmal auf einen
Proxmox-Knoten kopiert und richtet von dort den Knoten und seine
Container ein. Also traegt es Kopien der Host-Dateien in sich — und
Kopien laufen auseinander, wenn man sie von Hand pflegt. Darum werden
sie hier eingesetzt statt abgeschrieben.

    python3 scripts/rw-ssh-aufnehmen-bauen.py

Nach jeder Aenderung an rw-authorized-keys.sh, rw-konten-sync.sh oder
den Unit-Dateien neu laufen lassen.
"""
import pathlib
import datetime

HIER = pathlib.Path(__file__).resolve().parent

TEILE = [
    ("rw-authorized-keys", "rw-authorized-keys.sh", "RW_AUTHKEYS_EOF", "0755"),
    ("rw-konten-sync", "rw-konten-sync.sh", "RW_KONTEN_EOF", "0755"),
    ("rw-konten-sync.service", "rw-konten-sync.service", "RW_SERVICE_EOF", "0644"),
    ("rw-konten-sync.timer", "rw-konten-sync.timer", "RW_TIMER_EOF", "0644"),
]

KOPF = '''#!/bin/bash
# Rosenweg SSH-Zugang: einen Proxmox-Knoten und seine Container aufnehmen
#
# Auf einem pve-Knoten als root ausfuehren. Richtet den Knoten selbst
# ein und auf Wunsch gleich alle laufenden Container per pct — ohne dass
# man sich in jeden einzeln anmelden muesste.
#
# ERZEUGT von scripts/rw-ssh-aufnehmen-bauen.py am {datum}.
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
    --api)       API_BASE="${{2:-}}"; shift 2 ;;
    --token)     HOST_TOKEN="${{2:-}}"; shift 2 ;;
    --auch-cts)  AUCH_CTS=1; shift ;;
    --probelauf) PROBE=1; shift ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$API_BASE" ] && [ -n "$HOST_TOKEN" ] || {{ echo "Fehlt: --api und --token" >&2; exit 2; }}

sage() {{ printf '  %s\\n' "$*"; }}
tun()  {{ if [ "$PROBE" = 1 ]; then printf '  [Probelauf] %s\\n' "$*"; else eval "$@"; fi; }}

ABLAGE=$(mktemp -d /tmp/rw-ssh.XXXXXX)
trap 'rm -rf "$ABLAGE"' EXIT
'''

RUMPF = r'''
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

  # Erst pruefen, dann neu laden. Eine kaputte sshd-Konfiguration sperrt
  # aus, und zwar genau den, der sie reparieren muesste.
  if [ "$PROBE" = 0 ]; then
    if sshd -t 2>/dev/null; then
      systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
      sage "sshd: geprueft und neu geladen"
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

  pct exec "$id" -- bash -s <<CTEOF
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
if sshd -t 2>/dev/null; then
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
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
  sage "   fertig"
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
'''


def bauen() -> str:
    stuecke = [KOPF.format(datum=datetime.date.today().isoformat())]
    stuecke.append("\n# ── Die Dateien, unveraendert aus dem Repo ──────────────────────────\n")
    for zielname, quelle, marke, _modus in TEILE:
        inhalt = (HIER / quelle).read_text(encoding="utf-8")
        if marke in inhalt:
            raise SystemExit(f"{quelle} enthaelt die Begrenzung {marke} — Generator anpassen")
        stuecke.append(f'\ncat > "$ABLAGE/{zielname}" <<\'{marke}\'\n{inhalt}{marke}\n')
    stuecke.append('\nchmod 0755 "$ABLAGE/rw-authorized-keys" "$ABLAGE/rw-konten-sync"\n')
    stuecke.append(RUMPF)
    return "".join(stuecke)


if __name__ == "__main__":
    ziel = HIER / "rw-ssh-aufnehmen.sh"
    ziel.write_text(bauen(), encoding="utf-8")
    ziel.chmod(0o755)
    print(f"{ziel} erzeugt ({len(ziel.read_text().splitlines())} Zeilen)")
