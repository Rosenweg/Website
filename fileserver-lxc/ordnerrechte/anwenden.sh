#!/bin/bash
# Setzt POSIX-ACLs auf die Dokumente nach einer Tabelle (siehe tabelle.txt).
#
#   anwenden.sh --tabelle tabelle.txt --wurzel /mnt/cephfs-stage [--trocken]
#
# --trocken zeigt nur, was gesetzt wuerde, und aendert nichts.
# Vorher immer sichern.sh laufen lassen; zurueck.sh ist der Rueckweg.
#
# Laeuft auf dem Fileserver (CT 106 oder CT 206) als root. Gruppen und Konten
# werden ueber winbind in numerische IDs aufgeloest, weil es auf CT 106
# gleichnamige lokale Eintraege gibt (Gruppe rosenweg gid 1000, Konto
# scanner uid 999). setfacl mit Namen wuerde dort die lokalen erwischen.
set -euo pipefail

TABELLE="" WURZEL="" TROCKEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tabelle) TABELLE="$2"; shift 2 ;;
    --wurzel)  WURZEL="${2%/}"; shift 2 ;;
    --trocken) TROCKEN=1; shift ;;
    *) echo "Unbekannt: $1" >&2; exit 2 ;;
  esac
done
[ -f "$TABELLE" ] || { echo "Tabelle fehlt (--tabelle)" >&2; exit 2; }
[ -d "$WURZEL" ]  || { echo "Wurzel fehlt (--wurzel)" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "Bitte als root" >&2; exit 2; }
command -v wbinfo >/dev/null || { echo "wbinfo fehlt" >&2; exit 2; }

# Nie anfassen: Git-Ablage des Backups und Papierkorb (eigene Rechte)
NIE=(.git .github .claude .recycle)

# ---- Namen -> numerische ID ueber winbind -----------------------------
# Einmal vorab im Hauptprozess aufloesen (nicht in $(...), sonst gehen
# Cache und Fehlliste in der Subshell verloren).
declare -A ID=()
fehlend=()
aufloesen() {   # g:name | u:name | name  ->  ID[eintrag]=g:1234 | u:1234 | ""
  local e="$1" art name id
  [ -n "${ID[$e]+x}" ] && return 0
  case "$e" in
    u:*) art=u; name="${e#u:}" ;;
    g:*) art=g; name="${e#g:}" ;;
    *)   art=g; name="$e" ;;
  esac
  if [ "$art" = u ]; then
    id=$(wbinfo -i "$name" 2>/dev/null | cut -d: -f3 || true)
  else
    id=$(wbinfo --group-info="$name" 2>/dev/null | cut -d: -f3 || true)
  fi
  if [ -z "$id" ]; then fehlend+=("$e"); ID[$e]=""; else ID[$e]="$art:$id"; fi
}

# Baut die ACL: $1 = Leser (Komma), $2 = Schreiber (Komma), $3 = d|f
acl_bauen() {
  local leser="$1" schreiber="$2" typ="$3" r w e ids out
  if [ "$typ" = d ]; then r="r-x"; w="rwx"; else r="r--"; w="rw-"; fi
  out="u::$w,g::---,o::---,m::$w"
  local -A gesehen=()
  for e in ${ADMIN//,/ } ${schreiber//,/ }; do
    [ "$e" = "-" ] && continue
    ids="${ID[$e]:-}"; [ -z "$ids" ] && continue
    [ -n "${gesehen[$ids]:-}" ] && continue; gesehen[$ids]=1
    out+=",$ids:$w"
  done
  for e in ${leser//,/ }; do
    [ "$e" = "-" ] && continue
    ids="${ID[$e]:-}"; [ -z "$ids" ] && continue
    [ -n "${gesehen[$ids]:-}" ] && continue; gesehen[$ids]=1
    out+=",$ids:$r"
  done
  echo "$out"
}

# Default-ACL fuer Ordner = Zugriffs-ACL mit d:-Praefix
default_von() { local a="$1" out="" t; IFS=, read -ra t <<<"$a"; for x in "${t[@]}"; do out+="d:$x,"; done; echo "${out%,}"; }

# ---- Tabelle lesen ----------------------------------------------------
ADMIN=""
declare -a P_PFAD P_LES P_SCHR
while IFS= read -r zeile || [ -n "$zeile" ]; do
  zeile="${zeile%%#*}"
  [ -z "${zeile//[[:space:]]/}" ] && continue
  IFS='|' read -r a b c <<<"$zeile"
  a=$(echo "$a" | xargs); b=$(echo "${b:-}" | tr -d '[:space:]'); c=$(echo "${c:-}" | tr -d '[:space:]')
  if [ "$a" = ADMIN ]; then ADMIN="$b"; continue; fi
  P_PFAD+=("$a"); P_LES+=("${b:--}"); P_SCHR+=("${c:--}")
done <"$TABELLE"
[ -n "$ADMIN" ] || { echo "ADMIN-Zeile fehlt in $TABELLE" >&2; exit 2; }
for e in ${ADMIN//,/ } ${P_LES[*]//,/ } ${P_SCHR[*]//,/ }; do
  [ "$e" = "-" ] || aufloesen "$e"
done

# ---- Anwenden ---------------------------------------------------------
gesamt_d=0 gesamt_f=0
prune_args=()
for n in "${NIE[@]}"; do prune_args+=(-name "$n" -o); done
unset 'prune_args[${#prune_args[@]}-1]'

# $1 Pfad, $2 Leser, $3 Schreiber, $4 rekursiv (1) oder nur Ebene (0), $5 Bezeichnung
setzen() {
  local pfad="$1" les="$2" schr="$3" rek="$4" name="$5" ad af nd nf
  ad=$(acl_bauen "$les" "$schr" d); af=$(acl_bauen "$les" "$schr" f)
  ad="$ad,$(default_von "$ad")"
  local tiefe=(); [ "$rek" = 0 ] && tiefe=(-maxdepth 1)
  # Ordner (inkl. pfad selbst), ohne NIE-Ordner
  if [ "$rek" = 0 ]; then nd=1
  else nd=$(find "$pfad" \( "${prune_args[@]}" \) -prune -o -type d -print | wc -l); fi
  nf=$(find "$pfad" "${tiefe[@]}" \( "${prune_args[@]}" \) -prune -o -type f -print | wc -l)
  gesamt_d=$((gesamt_d + nd)); gesamt_f=$((gesamt_f + nf))
  printf '%-40s Ordner %5d  Dateien %6d\n' "$name" "$nd" "$nf"
  printf '    Ordner:  setfacl -P --set %s\n' "$ad"
  printf '    Dateien: setfacl -P --set %s\n' "$af"
  [ "$TROCKEN" = 1 ] && return 0
  if [ "$rek" = 0 ]; then
    setfacl -P --set "$ad" "$pfad"
    find "$pfad" -maxdepth 1 -type f -print0 | xargs -0 -r setfacl -P --set "$af"
  else
    find "$pfad" \( "${prune_args[@]}" \) -prune -o -type d -print0 | xargs -0 -r setfacl -P --set "$ad"
    find "$pfad" \( "${prune_args[@]}" \) -prune -o -type f -print0 | xargs -0 -r setfacl -P --set "$af"
  fi
}

[ "$TROCKEN" = 1 ] && echo "=== TROCKENLAUF - es wird nichts geaendert ==="
echo "Wurzel: $WURZEL"

# 1. Wurzel
wl="-" ws="-"
for i in "${!P_PFAD[@]}"; do
  [ "${P_PFAD[$i]}" = "/" ] && { wl="${P_LES[$i]}"; ws="${P_SCHR[$i]}"; }
done
setzen "$WURZEL" "$wl" "$ws" 0 "/ (nur Ebene)"

# 2. Ordner der obersten Ebene: aus der Tabelle oder nur ADMIN
while IFS= read -r -d '' d; do
  n=$(basename "$d")
  for x in "${NIE[@]}"; do [ "$n" = "$x" ] && continue 2; done
  les="-" schr="-" bez="$n (nicht in Tabelle: nur ADMIN)"
  for i in "${!P_PFAD[@]}"; do
    if [ "${P_PFAD[$i]}" = "$n" ]; then les="${P_LES[$i]}"; schr="${P_SCHR[$i]}"; bez="$n"; fi
  done
  setzen "$d" "$les" "$schr" 1 "$bez"
done < <(find "$WURZEL" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)

for i in "${!P_PFAD[@]}"; do
  p="${P_PFAD[$i]}"
  case "$p" in /|~*) continue ;; esac
  [ -d "$WURZEL/$p" ] || echo "Hinweis: $p steht in der Tabelle, gibt es aber nicht - uebersprungen"
done

# 3. ~name-Zeilen: Ebene 1 und 2, gewinnen
for i in "${!P_PFAD[@]}"; do
  p="${P_PFAD[$i]}"
  [ "${p:0:1}" = "~" ] || continue
  while IFS= read -r -d '' d; do
    setzen "$d" "${P_LES[$i]}" "${P_SCHR[$i]}" 1 "${d#"$WURZEL"/} ($p)"
  done < <(find "$WURZEL" -mindepth 1 -maxdepth 2 \( "${prune_args[@]}" \) -prune -o -type d -iname "${p:1}" -print0 | sort -z)
done

echo "Summe: Ordner $gesamt_d, Dateien $gesamt_f (Ordner unter ~-Zeilen doppelt gezaehlt)"
if [ ${#fehlend[@]} -gt 0 ]; then
  echo "WARNUNG: nicht aufloesbar (weggelassen, gibt also weniger Rechte):"
  printf '  %s\n' "$(printf '%s\n' "${fehlend[@]}" | sort -u)"
fi
[ "$TROCKEN" = 1 ] && echo "=== TROCKENLAUF Ende ==="
exit 0
