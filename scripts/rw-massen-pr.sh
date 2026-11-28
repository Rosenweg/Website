#!/bin/bash
# Massen-PR: CI-Aenderungen ueber viele Repos gestaffelt, ohne die Runner zu verstopfen
#
# Laeuft auf dem Arbeitsplatz (gh angemeldet). Regeln (Stefan, 28.11.2026, nach dem Stau
# durch 45 gleichzeitige Pull Requests):
#   * hoechstens 6 Repos gleichzeitig in der Pruefung (offener PR mit laufenden Checks),
#   * ein neuer Push/Neustart nur, wenn weniger als 15 Jobs auf unsere Runner warten UND
#     weniger als 2 Release-Laeufe laufen (je Release belegen macOS + iOS 2 der 5 macOS-
#     Plaetze; sonst bremsen Releases nicht),
#   * sonst wartet das Skript (alle 60 s neue Pruefung).
# Die Lage kommt aus dem NOC (Bericht des Runner-Waechters), wenn NOC_URL und NOC_TOKEN
# gesetzt sind; sonst zaehlt es selbst wartende Laeufe in den Repos (langsamer, mehr API).
#
# Aufruf:
#   rw-massen-pr.sh neu    --zweig ci/xyz --titel "..." --skript ./aendern.sh repo1 repo2 ...
#       Je Repo: Clone, Zweig von der Standardlinie, "skript" im Clone ausfuehren (aendert
#       Dateien), commit, push, PR. Keine Aenderung = Repo uebersprungen.
#   rw-massen-pr.sh anstossen --zweig ci/xyz [--mergen] repo1 repo2 ...
#       Bestehende PRs: fehlgeschlagene/abgebrochene Laeufe neu starten, gruene PRs bei
#       --mergen zusammenfuehren (squash). Ein roter PR bleibt offen und wird gemeldet.
#   Mit --trocken nur anzeigen.
# Umgebung: ORG (Rosenweg), NOC_URL (https://www.rosenweg4303.ch), NOC_TOKEN, ARBEIT (Clones),
#           MAX_PARALLEL (6), MAX_WARTEND (15), MAX_RELEASES (2), WARTEN_S (60).
set -uo pipefail

ORG=${ORG:-Rosenweg}; NOC_URL=${NOC_URL:-}; NOC_TOKEN=${NOC_TOKEN:-}
ARBEIT=${ARBEIT:-${TMPDIR:-/tmp}/rw-massen-pr}; MAX_PARALLEL=${MAX_PARALLEL:-6}
MAX_WARTEND=${MAX_WARTEND:-15}; MAX_RELEASES=${MAX_RELEASES:-2}; WARTEN_S=${WARTEN_S:-60}
MODUS=${1:-}; shift || true
ZWEIG=""; TITEL=""; SKRIPT=""; MERGEN=0; TROCKEN=0; REPOS=()
while [ $# -gt 0 ]; do
  case $1 in
    --zweig) ZWEIG=$2; shift 2 ;; --titel) TITEL=$2; shift 2 ;; --skript) SKRIPT=$2; shift 2 ;;
    --mergen) MERGEN=1; shift ;; --trocken) TROCKEN=1; shift ;; *) REPOS+=("$1"); shift ;;
  esac
done
ok=0
[ -n "$ZWEIG" ] && [ ${#REPOS[@]} -gt 0 ] && { [ "$MODUS" = anstossen ] || { [ "$MODUS" = neu ] && [ -n "$SKRIPT" ] && [ -n "$TITEL" ]; }; } && ok=1
[ $ok = 1 ] || { sed -n '2,/^set -uo/p' "$0" | sed '$d' | cut -c3-; exit 2; }
mkdir -p "$ARBEIT"

# Lage: "<wartend> <releases>" - releases = laufende Release-Laeufe
lage() {
  if [ -n "$NOC_URL" ] && [ -n "$NOC_TOKEN" ]; then
    curl -fsS --max-time 15 -H "X-Noc-Token: $NOC_TOKEN" "$NOC_URL/api/isp/noc/public/runner" 2>/dev/null \
    | python3 -c '
import json, sys
d = json.load(sys.stdin)
r = d.get("release") or {}
rel = len(r.get("laeuft") or [])
print(d.get("wartend") or 0, rel)' && return 0
  fi
  # Ersatz: wartende bzw. laufende "App"-Laeufe (Releases) und wartende Laeufe zaehlen
  local w=0 rel=0 r
  for r in $(gh repo list "$ORG" --limit 100 --json name,isArchived -q '.[]|select(.isArchived|not)|.name'); do
    w=$((w + $(gh api "repos/$ORG/$r/actions/runs?status=queued&per_page=1" -q .total_count 2>/dev/null || echo 0)))
    rel=$((rel + $(gh api "repos/$ORG/$r/actions/runs?status=in_progress&event=workflow_dispatch&per_page=1" -q .total_count 2>/dev/null || echo 0)))
  done
  echo "$w $rel"
}

# Offene PRs dieses Zweigs mit laufenden Pruefungen
in_pruefung() {
  local n=0 r
  for r in "${REPOS[@]}"; do
    gh pr checks "$ZWEIG" -R "$ORG/$r" 2>/dev/null | awk -F'\t' '{print $2}' | grep -q pending && n=$((n + 1))
  done
  echo "$n"
}

ruhe_abwarten() {
  while :; do
    read -r w rel < <(lage) || { w=999; rel=1; }
    p=$(in_pruefung)
    if [ "${w:-999}" -lt "$MAX_WARTEND" ] && [ "${rel:-9}" -lt "$MAX_RELEASES" ] && [ "$p" -lt "$MAX_PARALLEL" ]; then return 0; fi
    echo "  warte: $w Jobs wartend (Grenze $MAX_WARTEND), laufende Releases $rel (Grenze $MAX_RELEASES), $p PR in Pruefung (Grenze $MAX_PARALLEL)"
    [ "$TROCKEN" = 1 ] && return 0
    sleep "$WARTEN_S"
  done
}

case $MODUS in
neu)
  for r in "${REPOS[@]}"; do
    echo "== $r"; ruhe_abwarten
    d="$ARBEIT/$r"; rm -rf "$d"
    [ "$TROCKEN" = 1 ] && { echo "  (trocken) wuerde $SKRIPT in $r ausfuehren und pushen"; continue; }
    gh repo clone "$ORG/$r" "$d" -- -q --depth 1 || continue
    def=$(cd "$d" && git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#origin/##')
    ( cd "$d" && git checkout -q -b "$ZWEIG" && "$SKRIPT" ) || { echo "  Skript fehlgeschlagen"; continue; }
    ( cd "$d" && git add -A && git diff --cached --quiet ) && { echo "  keine Aenderung"; continue; }
    ( cd "$d" && git commit -qm "$TITEL" && git push -q origin "$ZWEIG" \
      && gh pr create -R "$ORG/$r" --base "$def" --head "$ZWEIG" --title "$TITEL" \
           --body "$TITEL

Gestaffelt mit scripts/rw-massen-pr.sh (docs/runner-waechter.md).

🤖 Generated with [Claude Code](https://claude.com/claude-code)" ) | tail -1
  done ;;
anstossen)
  for r in "${REPOS[@]}"; do
    echo "== $r"
    erg=$(gh pr checks "$ZWEIG" -R "$ORG/$r" 2>&1 | awk -F'\t' '{print $2}' | sort | uniq -c | tr -s ' ' | tr '\n' ',')
    echo "  Stand: $erg"
    if echo "$erg" | grep -q pending; then echo "  laeuft noch"; continue; fi
    if echo "$erg" | grep -qE 'fail|cancel'; then
      ruhe_abwarten
      [ "$TROCKEN" = 1 ] && { echo "  (trocken) wuerde Laeufe neu starten"; continue; }
      id=$(gh run list -R "$ORG/$r" --branch "$ZWEIG" --limit 1 --json databaseId -q '.[0].databaseId')
      [ -n "$id" ] && gh run rerun "$id" -R "$ORG/$r" --failed 2>&1 | tail -1
      continue
    fi
    if [ "$MERGEN" = 1 ] && echo "$erg" | grep -q pass; then
      [ "$TROCKEN" = 1 ] && { echo "  (trocken) wuerde mergen"; continue; }
      gh pr merge "$ZWEIG" -R "$ORG/$r" --squash 2>&1 | tail -1
    fi
  done ;;
esac
