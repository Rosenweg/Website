#!/bin/bash
# ============================================================================
# homes-anlegen.sh - AD-Homes fuer alle Personen anlegen und fuer die Nextcloud
# freigeben. Plan: docs/plans/persoenlicher-ordner.md (Website-Repo).
# ============================================================================
# Laeuft auf dem Fileserver (CT 206 und CT 106, gleiches CephFS) als root,
# per Timer stuendlich. Macht zwei Dinge, beide idempotent:
#
#  1. Fehlender Home <wurzel>/<name> fuer jede Person -> anlegen:
#     Besitzer = Person (winbind-uid), Gruppe rosenweg, 700, ACL wie unten.
#  2. Home ohne Eintrag fuer nextcloud-dienst (z.B. von Windows/logon.bat
#     angelegt) -> ACL rekursiv setzen, aber nur wenn der Besitzer des
#     Homes zur Person passt.
#
# Personen = aktive Konten in der AD-Gruppe rosenweg, deren Name die Form
# vorname.nachname hat (nur a-z und -). Damit fallen Dienst-, Drucker- und
# Testkonten weg (api-svc, scanner, druckerr9..., acltest, stefan-test ...).
#
# ACL (gleich wie homes-rechte/anwenden.sh):
#   Ordner:          u::rwx,u:<uid>:rwx,g::---,g:<nc>:rwx,m::rwx,o::--- + default
#   Dateien mit x:   u::rwx,u:<uid>:rwx,g::---,g:<nc>:rwx,m::rwx,o::---
#   Dateien ohne x:  u::rw-,u:<uid>:rw-,g::---,g:<nc>:rw-,m::rw-,o::---
#
#   homes-anlegen.sh             anlegen/nachziehen
#   homes-anlegen.sh --trocken   nur zeigen
# ============================================================================
set -euo pipefail

WURZEL=/mnt/cephfs-userdata/home
GRUPPE_NC=nextcloud-dienst
GRUPPE_HOME=rosenweg
BASIS_DN="DC=ad,DC=rosenweg4303,DC=ch"
TROCKEN=0
[ "${1:-}" = "--trocken" ] && TROCKEN=1

[ "$(id -u)" = 0 ] || { echo "Bitte als root" >&2; exit 2; }
[ -d "$WURZEL" ] || { echo "Wurzel fehlt: $WURZEL" >&2; exit 2; }
exec 9>/run/homes-anlegen.lock
flock -n 9 || { echo "laeuft schon"; exit 0; }

NC=$(wbinfo --group-info="$GRUPPE_NC" | cut -d: -f3)
HG=$(wbinfo --group-info="$GRUPPE_HOME" | cut -d: -f3)
[ -n "$NC" ] && [ -n "$HG" ] || { echo "Gruppen per winbind nicht aufloesbar" >&2; exit 2; }

acl_d()  { echo "u::rwx,u:$1:rwx,g::---,g:$NC:rwx,m::rwx,o::---,d:u::rwx,d:u:$1:rwx,d:g::---,d:g:$NC:rwx,d:m::rwx,d:o::---"; }
acl_fx() { echo "u::rwx,u:$1:rwx,g::---,g:$NC:rwx,m::rwx,o::---"; }
acl_f()  { echo "u::rw-,u:$1:rw-,g::---,g:$NC:rw-,m::rw-,o::---"; }

personen=$(net ads search -P "(&(objectClass=user)(objectCategory=person)(memberOf=CN=$GRUPPE_HOME,CN=Users,$BASIS_DN)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))" sAMAccountName 2>/dev/null \
  | sed -n 's/^sAMAccountName: //p' | grep -E '^[a-z-]+\.[a-z-]+$' | sort -u)
anzahl=$(printf '%s\n' "$personen" | grep -c . || true)
# Sicherung gegen eine leere/kaputte AD-Antwort
[ "$anzahl" -ge 10 ] || { echo "Nur $anzahl Personen aus dem AD - Abbruch" >&2; exit 1; }

angelegt=0 nachgezogen=0 ok=0 fehler=0
while IFS= read -r n; do
  [ -n "$n" ] || continue
  uid=$(wbinfo -i "$n" 2>/dev/null | cut -d: -f3 || true)
  [ -n "$uid" ] || { echo "WARNUNG $n: uid nicht aufloesbar"; fehler=$((fehler + 1)); continue; }
  h="$WURZEL/$n"
  if [ ! -e "$h" ]; then
    echo "anlegen   $n (uid $uid)"
    if [ "$TROCKEN" = 0 ]; then
      mkdir -m 700 "$h" && chown "$uid:$HG" "$h" && setfacl -P --set "$(acl_d "$uid")" "$h" \
        && angelegt=$((angelegt + 1)) || { echo "FEHLER beim Anlegen $n"; fehler=$((fehler + 1)); }
    fi
    continue
  fi
  [ -d "$h" ] && [ ! -L "$h" ] || { echo "WARNUNG $n: $h ist kein Ordner - nicht angefasst"; fehler=$((fehler + 1)); continue; }
  if getfacl -P -n -p "$h" 2>/dev/null | grep -q "^group:$NC:rwx"; then
    ok=$((ok + 1)); continue
  fi
  besitzer=$(stat -c %u "$h")
  if [ "$besitzer" != "$uid" ]; then
    echo "WARNUNG $n: Besitzer uid $besitzer statt $uid - nicht angefasst"; fehler=$((fehler + 1)); continue
  fi
  echo "nachziehen $n (uid $uid): ACL fuer die Nextcloud fehlt"
  if [ "$TROCKEN" = 0 ]; then
    find -P "$h" -type d -print0              | xargs -0 -r setfacl -P --set "$(acl_d "$uid")"
    find -P "$h" -type f -perm /111 -print0   | xargs -0 -r setfacl -P --set "$(acl_fx "$uid")"
    find -P "$h" -type f ! -perm /111 -print0 | xargs -0 -r setfacl -P --set "$(acl_f "$uid")"
    nachgezogen=$((nachgezogen + 1))
  fi
done <<< "$personen"

[ "$TROCKEN" = 1 ] && echo "(Trockenlauf - nichts geaendert)"
echo "Personen $anzahl: angelegt $angelegt, nachgezogen $nachgezogen, in Ordnung $ok, Warnungen $fehler"
