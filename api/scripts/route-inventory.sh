#!/usr/bin/env bash
# Route-Inventar fuer den inkrementellen Router-Split.
# Listet alle (METHOD /voller/pfad) aus server.js + routes/*.js, normalisiert + sortiert.
# Fuer Router-Dateien wird der Mount-Prefix /api/<dateiname> vor die relativen Pfade gesetzt
# (Konvention: routes/<domain>.js wird in server.js unter /api/<domain> gemountet).
#
# Nutzung:
#   api/scripts/route-inventory.sh            # gibt die sortierte Liste aus
#   api/scripts/route-inventory.sh | wc -l    # Anzahl Routes
# Safety-Net: vor und nach jeder Extraktion ausfuehren -> die Listen MUESSEN identisch sein.
set -euo pipefail
cd "$(dirname "$0")/.."   # -> api/

server_routes() {
  grep -oE "app\.(get|post|put|delete|patch)\('[^']+'" server.js \
    | sed -E "s/app\.([a-z]+)\('(.*)'/\U\1\E \2/"
}

router_routes() {
  local f base
  for f in routes/*.js; do
    [ -e "$f" ] || continue
    base="$(basename "$f" .js)"
    grep -oE "(router|r)\.(get|post|put|delete|patch)\('[^']*'" "$f" \
      | sed -E "s/[a-z]+\.([a-z]+)\('(.*)'/\U\1\E \2/" \
      | awk -v p="/api/$base" '{ m=$1; sub(/^[^ ]+ /,""); rel=$0; if (rel=="/") rel=""; printf "%s %s%s\n", m, p, rel }'
  done
}

{ server_routes; router_routes; } | sort -u
