#!/usr/bin/env bash
# Platz machen — und dafuer sorgen, dass er bleibt.
#
# Am 11.09.2026 standen zwei Container auf 100%: edge-traefik (CT245) mit
# einem 5.7-GB-Zugriffsprotokoll ohne jede logrotate-Regel, und die PBX
# (CT220) mit 2.6 GB rotierter, aber nie komprimierter Asterisk-Logs. Die
# Dienstwacht meldete davon vier Befunde als vier Probleme — es war eines.
#
# Dieses Skript laeuft IN einem Container und macht vier Dinge, alle
# verlustfrei:
#   1. apt-Cache leeren
#   2. Journal auf 200 MB deckeln (dauerhaft, nicht nur einmalig)
#   3. rotierte, aber unkomprimierte Logs komprimieren
#   4. fuer grosse Logdateien OHNE logrotate-Regel eine Regel anlegen
#
# Es loescht nichts. Was es nicht selbst loesen kann, meldet es am Ende
# unter "OFFEN" — das gehoert dann angeschaut, nicht wegautomatisiert.
set -uo pipefail

: "${JOURNAL_MAX:=200M}"
: "${LOG_GROSS_MB:=100}"
NUR_ZEIGEN=0
[ "${1:-}" = "--trocken" ] && NUR_ZEIGEN=1

tun() { [ "$NUR_ZEIGEN" = 1 ] && return 0; "$@"; }
# Damit ein Trockenlauf nicht behauptet, er haette etwas getan.
sagen() { [ "$NUR_ZEIGEN" = 1 ] && echo "   [waere] $*" || echo "   $*"; }
frei() { df -P / 2>/dev/null | awk 'NR==2{print $4}'; }
benutzt() { df -P / 2>/dev/null | awk 'NR==2{print $5}'; }

VORHER=$(frei)
echo "== $(hostname) — vorher $(benutzt) belegt"

# ── 1. apt-Cache ────────────────────────────────────────────────────
if command -v apt-get >/dev/null 2>&1; then
  tun apt-get clean >/dev/null 2>&1; sagen "apt-Cache geleert"
fi

# ── 2. Journal deckeln ──────────────────────────────────────────────
# Der Deckel ist wichtiger als das einmalige Aufraeumen: ohne ihn waechst
# das Journal wieder bis 10% der Partition.
if command -v journalctl >/dev/null 2>&1 && [ -d /var/log/journal ]; then
  if [ ! -f /etc/systemd/journald.conf.d/rw-groesse.conf ]; then
    tun mkdir -p /etc/systemd/journald.conf.d
    [ "$NUR_ZEIGEN" = 0 ] && printf '# Gesetzt von rw-platz-machen.sh\n[Journal]\nSystemMaxUse=%s\n' \
      "$JOURNAL_MAX" > /etc/systemd/journald.conf.d/rw-groesse.conf
    tun systemctl restart systemd-journald >/dev/null 2>&1
    sagen "Journal-Deckel gesetzt ($JOURNAL_MAX)"
  fi
  tun journalctl --vacuum-size="$JOURNAL_MAX" >/dev/null 2>&1
fi

# ── 3. Rotierte, aber unkomprimierte Logs ───────────────────────────
# delaycompress laesst die .1 unkomprimiert liegen. Scheitert die naechste
# Rotation (z.B. weil die Platte voll ist), bleibt sie das fuer immer.
ANZ=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if [ "$NUR_ZEIGEN" = 1 ]; then ANZ=$((ANZ + 1)); else gzip -9 "$f" 2>/dev/null && ANZ=$((ANZ + 1)); fi
done < <(find /var/log -type f -size +10M \
           \( -name '*.[0-9]' -o -name '*.log.[0-9]' \) ! -name '*.gz' 2>/dev/null)
[ "$ANZ" -gt 0 ] && sagen "$ANZ rotierte Logs komprimiert"

# ── 4. Grosse Logs ohne Regel ───────────────────────────────────────
# logrotate -d listet jede Datei, die von irgendeiner Regel erfasst wird.
# Was gross ist und dort NICHT vorkommt, waechst unbegrenzt — genau das
# war der Fall bei Traefik.
if command -v logrotate >/dev/null 2>&1; then
  # 2>&1, NICHT 2>/dev/null: logrotate schreibt seine Debug-Ausgabe
  # vollstaendig auf stderr. Mit 2>/dev/null blieb die Liste leer, jede
  # grosse Datei galt als unerfasst — und die angelegte Regel kollidierte
  # mit der bestehenden ("duplicate log entry"), womit logrotate die Datei
  # komplett uebersprang. Aus einer Aufraeumhilfe wurde so ein Ausfall.
  ERFASST=$(logrotate -d /etc/logrotate.conf 2>&1 | sed -n 's/^considering log //p')
  if [ -z "$ERFASST" ]; then
    echo "   OFFEN: logrotate -d liefert nichts — Regelanlage uebersprungen"
    ERFASST=$'\x01'   # unmoeglicher Pfad: nichts gilt als unerfasst
  fi
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case $'\n'"$ERFASST"$'\n' in *$'\n'"$f"$'\n'*) continue ;; esac
    name="rw-$(printf '%s' "$(basename "$f" .log)" | tr -c 'A-Za-z0-9_-' '-')"
    [ -f "/etc/logrotate.d/$name" ] && continue
    if [ "$NUR_ZEIGEN" = 0 ]; then
      # copytruncate, weil der schreibende Dienst den Dateideskriptor haelt:
      # ohne das schreibt er nach der Rotation in die geloeschte Datei
      # weiter und der Platz kommt nie zurueck.
      cat > "/etc/logrotate.d/$name" <<REGEL
# Angelegt von rw-platz-machen.sh — diese Datei war gross und von keiner
# Regel erfasst.
$f {
    daily
    maxsize ${LOG_GROSS_MB}M
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su root root
}
REGEL
    fi
    sagen "Regel angelegt fuer $f ($(du -h "$f" 2>/dev/null | cut -f1))"
  done < <(find /var/log -type f -size +"${LOG_GROSS_MB}"M ! -name '*.gz' 2>/dev/null)
fi

# ── Bericht ─────────────────────────────────────────────────────────
echo "== $(hostname) — nachher $(benutzt) belegt (vorher $VORHER frei, jetzt $(frei))"

# Was jetzt noch gross ist, ist keine Logdatei und gehoert angeschaut.
OFFEN=$(find / -xdev -type f -size +500M ! -path '/var/log/*' -printf '%s\t%p\n' 2>/dev/null \
        | sort -rn | head -5 | awk '{printf "   OFFEN: %.0f MB  %s\n", $1/1048576, $2}')
[ -n "$OFFEN" ] && echo "$OFFEN"
BELEGT=$(benutzt | tr -d '%')
[ "${BELEGT:-0}" -ge 85 ] && echo "   OFFEN: immer noch ${BELEGT}% belegt — reicht nicht, bitte ansehen"
exit 0
