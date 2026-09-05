#!/bin/bash
# rw-web-ausrollen — eine Quelle, alle Frontends
#
# Verwendung:
#   scripts/rw-web-ausrollen.sh [--pruefen] [--neu] DATEI…
#
#   DATEI      Pfad relativ zum Repo, z. B. noc-fullscreen.html oder js/nav.js
#   --pruefen  nur vergleichen und berichten, nichts schreiben
#   --neu      eine Datei auch dorthin legen, wo sie noch fehlt
#              (ohne --neu wird kein Bestand erweitert — auch fe-www nicht)
#
# Umgebung:  RW_JUMP  Sprunghost      (Standard stefan@10.0.10.149)
#            RW_NODE  ein Cluster-Knoten (Standard root@100.64.2.20)
#
# ── Warum es das gibt ───────────────────────────────────────────────────
# Die Frontends laufen als LXC-Container mit nginx, jeder mit einem eigenen
# Bestand unter /var/www/rosenweg. Es gibt keinen Weg vom Push zur Seite;
# ausgerollt wird dateiweise von Hand. Dabei ist zweierlei passiert:
#
#   – noc-fullscreen.html liegt auf fe-www UND auf fe-isp (das Wandbild unter
#     noc.rosenweg4303.ch). Wer nur fe-www beliefert, aendert das Wandbild
#     nicht. Auf fe-isp lag bis 5.9.2026 der Stand vom 15. August.
#   – Auf fe-www lag seit dem 15. August der ganze Repo-Baum — docs/,
#     JOURNAL.md, Compose-Dateien, Skripte — oeffentlich abrufbar.
#
# Dieses Skript kennt die Ziele nicht auswendig. Es fragt den Cluster nach
# allen fe-*-Containern und legt eine Datei dorthin, wo sie schon liegt.
# Was ein Container hat, bekommt er aktuell; was er nicht hat, bekommt er
# nicht — ausser man sagt --neu. So bleibt jeder Bestand, wie er ist, nur
# eben auf dem Stand des Repos.
#
# Eine Ausnahme kennt es doch: fe-isp bekommt js/nav-isp.js als js/nav.js
# und nie das allgemeine js/nav.js — die ISP-Seite hat ihre eigene Leiste.
#
# Vor jedem Ueberschreiben wird eine .alt-Kopie angelegt; nginx liefert
# .alt nicht aus (Regel vom 5.9.2026). Nach dem Schreiben wird die
# Pruefsumme verglichen. Was das Skript meldet, ist das, was draussen ist.
set -u

JUMP=${RW_JUMP:-stefan@10.0.10.149}
NODE=${RW_NODE:-root@100.64.2.20}
WEBROOT=/var/www/rosenweg
PRUEFEN=0; NEU=0; DATEIEN=()
for a in "$@"; do
  case "$a" in
    --pruefen) PRUEFEN=1 ;;
    --neu)     NEU=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *)         DATEIEN+=("$a") ;;
  esac
done
[ ${#DATEIEN[@]} -gt 0 ] || { echo "Keine Datei angegeben. -h fuer Hilfe." >&2; exit 2; }

REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO" || exit 2
for f in "${DATEIEN[@]}"; do [ -f "$f" ] || { echo "Nicht im Repo: $f" >&2; exit 2; }; done

md5lokal() { if command -v md5 >/dev/null 2>&1; then md5 -q "$1"; else md5sum "$1" | cut -d' ' -f1; fi; }
# -n: ssh darf nicht von stdin lesen — sonst frisst es in der while-read-Schleife
# die restlichen Zeilen, und der zweite Container kommt nie an die Reihe.
sshj() { ssh -n -o BatchMode=yes -o ConnectTimeout=30 -J "$JUMP" "$@"; }

# Welcher Repo-Pfad landet auf welchem Container unter welchem Namen?
# Leer heisst: dieser Container bekommt die Datei nicht.
zielpfad() {  # $1 Containername, $2 Repo-Pfad
  case "$1|$2" in
    fe-isp\|js/nav.js)     echo "" ;;
    fe-isp\|js/nav-isp.js) echo "js/nav.js" ;;
    *\|js/nav-isp.js)      echo "" ;;
    *)                     echo "$2" ;;
  esac
}

# ── 1. Frontends und Knoten aus dem Cluster ──────────────────────────────
INVENTAR=$(sshj "$NODE" 'pvesh get /cluster/resources --type vm --output-format json 2>/dev/null; echo "@@"; pvesh get /cluster/status --output-format json 2>/dev/null') || { echo "Cluster nicht erreichbar ueber $NODE" >&2; exit 1; }
CTS=$(printf '%s' "$INVENTAR" | python3 -c '
import sys, json
res, status = sys.stdin.read().split("@@", 1)
ips = {n["name"]: n.get("ip", "") for n in json.loads(status) if n.get("type") == "node"}
for r in sorted(json.loads(res), key=lambda x: x.get("name", "")):
    if r.get("name", "").startswith("fe-") and r.get("status") == "running":
        print(r["vmid"], r["name"], r["node"], ips.get(r["node"], ""))')
[ -n "$CTS" ] || { echo "Keine laufenden fe-*-Container gefunden" >&2; exit 1; }

# ── 2. Ist-Zustand: Pruefsumme jeder Datei auf jedem Container ───────────
# Ein ssh je Knoten, darin alle Container und Dateien.
IST=""
for knoten in $(printf '%s\n' "$CTS" | awk '{print $3}' | sort -u); do
  ip=$(printf '%s\n' "$CTS" | awk -v k="$knoten" '$3==k {print $4; exit}')
  auftrag=""
  while read -r id name kn _ip; do
    [ "$kn" = "$knoten" ] || continue
    for f in "${DATEIEN[@]}"; do
      z=$(zielpfad "$name" "$f"); [ -n "$z" ] || continue
      auftrag+="printf '%s|%s|%s|' '$name' '$f' '$z'; pct exec $id -- sh -c 'md5sum $WEBROOT/$z 2>/dev/null | cut -d\" \" -f1 || true'; echo;"$'\n'
    done
  done <<< "$CTS"
  [ -n "$auftrag" ] || continue
  IST+=$(sshj "root@$ip" "$auftrag")$'\n'
done

# ── 3. Vergleichen, ausrollen, berichten ─────────────────────────────────
printf '%-24s %-12s %-10s %s\n' "Datei" "Container" "Vorher" "Nachher"
AUSGEROLLT=0; ABWEICHEND=0
for f in "${DATEIEN[@]}"; do
  lokal=$(md5lokal "$f")
  while read -r id name knoten ip; do
    z=$(zielpfad "$name" "$f"); [ -n "$z" ] || continue
    fern=$(printf '%s\n' "$IST" | awk -F'|' -v n="$name" -v p="$f" '$1==n && $2==p {print $4}' | tr -d '[:space:]')
    if [ -z "$fern" ]; then
      # Fehlende Dateien nur mit --neu anlegen. Die fruehere Ausnahme fuer
      # fe-www hat isp-admin.html dorthin gelegt, wo sie nie war (5.9.2026).
      if [ "$NEU" = 1 ]; then vorher="fehlt"; else continue; fi
    elif [ "$fern" = "$lokal" ]; then
      printf '%-24s %-12s %-10s %s\n' "$f" "$name" "gleich" "—"; continue
    else vorher="anders"; fi
    ABWEICHEND=$((ABWEICHEND+1))
    if [ "$PRUEFEN" = 1 ]; then printf '%-24s %-12s %-10s %s\n' "$f" "$name" "$vorher" "(Pruefmodus)"; continue; fi
    tmp="/tmp/rw-web.$$.$(basename "$f")"
    scp -q -o BatchMode=yes -J "$JUMP" "$f" "root@$ip:$tmp" </dev/null || { printf '%-24s %-12s %-10s %s\n' "$f" "$name" "$vorher" "FEHLER beim Kopieren"; continue; }
    nachher=$(sshj "root@$ip" "
      pct exec $id -- sh -c 'cd $WEBROOT && [ -f $z ] && cp -a $z $z.alt; mkdir -p \$(dirname $z)' 2>/dev/null
      pct push $id $tmp $WEBROOT/$z --perms 644 >/dev/null 2>&1 && pct exec $id -- chown www-data:www-data $WEBROOT/$z
      rm -f $tmp
      pct exec $id -- sh -c 'md5sum $WEBROOT/$z | cut -d\" \" -f1'" | tr -d '[:space:]')
    if [ "$nachher" = "$lokal" ]; then printf '%-24s %-12s %-10s %s\n' "$f" "$name" "$vorher" "ausgerollt"; AUSGEROLLT=$((AUSGEROLLT+1))
    else printf '%-24s %-12s %-10s %s\n' "$f" "$name" "$vorher" "FEHLER: Pruefsumme stimmt nicht"; fi
  done <<< "$CTS"
done
echo
if [ "$PRUEFEN" = 1 ]; then echo "Pruefmodus: $ABWEICHEND abweichend, nichts geschrieben."
else echo "Ausgerollt: $AUSGEROLLT von $ABWEICHEND abweichenden Zielen."; fi
