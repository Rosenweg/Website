#!/bin/bash
# ============================================================================
# einrichten.sh - Gruppenrichtlinie "Rosenweg-Ordnerumleitung" auf dc1
# ============================================================================
# Leitet Desktop, Dokumente und Bilder auf das Home um:
#   \\dokumente\home\%USERNAME%\{Desktop,Documents,Pictures}
# mit der Ordnerumleitung von Windows (fdeploy1.ini), Inhalte werden beim
# ersten Mal verschoben. Ersetzt den Abschnitt :folderredir in logon.bat.
#
#   1. Gruppe Ordnerumleitung (einmal) und die genannten Personen hinein
#   2. die Richtlinie anlegen bzw. die leere "Rosenweg-Folder Redirect" vom
#      24.06.2026 uebernehmen, an die Domaene haengen
#   3. Sicherheitsfilterung: anwenden nur fuer die Gruppe Ordnerumleitung
#   4. fdeploy1.ini und Registry.pol (keine Offline-Dateien) ins sysvol,
#      Erweiterungen eintragen, Benutzer-Version hochzaehlen
#   5. Rechte im sysvol neu setzen
#
# Auf dc1 als root, im Verzeichnis mit fdeploy1.ini:
#
#   ./einrichten.sh [PERSON ...]        z.B. ./einrichten.sh stefan.mueller
#
# Wiederholbar: ein zweiter Lauf legt nichts doppelt an, nimmt nur weitere
# Personen auf, schreibt den Inhalt neu und zaehlt die Version hoch.
# dc2 bekommt das sysvol ueber sysvol-abgleich (ad-dc/README.md), das
# Verzeichnis (Gruppe, Richtlinie, Rechte) ueber die AD-Replikation.
# ============================================================================
set -euo pipefail

NAME="Rosenweg-Ordnerumleitung"
ALTNAME="Rosenweg-Folder Redirect"     # leer angelegt am 24.06.2026, Version 0
GRUPPE="Ordnerumleitung"
DOMAENE="ad.rosenweg4303.ch"
BASIS="DC=ad,DC=rosenweg4303,DC=ch"
SAM="/var/lib/samba/private/sam.ldb"
HIER="$(cd "$(dirname "$0")" && pwd)"

# Erweiterungen (CSE-GUID, danach die Werkzeug-GUID; je Paar nach CSE sortiert)
FR_CSE="{25537BA6-77A8-11D2-9B6C-0000F8080861}{88E729D6-BDC1-11D1-BD2A-00C04FB9603F}"
REG_CSE="{35378EAC-683F-11D2-A89A-00C04FBBCFA2}{0F6B957E-509E-11D1-A7CC-0000F87571E3}"
# Erweitertes Recht "Gruppenrichtlinie uebernehmen"
APPLY="edacfd8f-ffb3-11d1-b41d-00a0c968f939"

[ -f "$HIER/fdeploy1.ini" ] || { echo "fdeploy1.ini fehlt neben $0" >&2; exit 1; }

# LDIF-Zeilen von ldbsearch sind ab 78 Zeichen umbrochen; fuer grep/sed
# wieder zusammenfuegen.
ldif_zeilen() { awk '/^ / { z = z substr($0, 2); next } { if (NR > 1) print z; z = $0 } END { print z }'; }

# --- 1. Gruppe --------------------------------------------------------------
if ! samba-tool group show "$GRUPPE" -H "$SAM" >/dev/null 2>&1; then
    samba-tool group add "$GRUPPE" -H "$SAM" \
        --description="Ordnerumleitung Desktop/Dokumente/Bilder aufs Home (GPO $NAME)"
    echo "Gruppe $GRUPPE angelegt."
fi
sid="$(samba-tool group show "$GRUPPE" -H "$SAM" --attributes=objectSid | sed -n 's/^objectSid: //p')"
case "$sid" in S-1-5-21-*) ;; *) echo "SID der Gruppe $GRUPPE nicht gefunden." >&2; exit 1 ;; esac
mitglieder="$(samba-tool group listmembers "$GRUPPE" -H "$SAM" || true)"
for person in "$@"; do
    samba-tool user show "$person" -H "$SAM" >/dev/null 2>&1 \
        || { echo "Person $person gibt es im AD nicht." >&2; exit 1; }
    if ! printf '%s\n' "$mitglieder" | grep -qix "$person"; then
        samba-tool group addmembers "$GRUPPE" "$person" -H "$SAM" >/dev/null
        echo "$person in $GRUPPE aufgenommen."
    fi
done

# --- 2. Richtlinie ----------------------------------------------------------
# Direkt in die lokale sam.ldb (als root = System), wie beim Rosenweg-Look:
# samba-tool gpo create braucht ein Admin-Konto (gpo-rosenweg-look-windows).
gpo_suchen() {
    samba-tool gpo listall -H "$SAM" | awk -v n="$1" '
        /^GPO/ { g=$3 } /^display name/ { sub(/^display name *: */,""); if ($0==n) print g }'
}
guid="$(gpo_suchen "$NAME")"
if [ -z "$guid" ]; then
    alt="$(gpo_suchen "$ALTNAME")"
    if [ -n "$alt" ]; then
        # Nur uebernehmen, solange sie leer ist - sonst hat jemand sie in der
        # Zwischenzeit mit der GPMC gefuellt, und das wollen wir nicht still
        # ueberschreiben.
        alt_dn="CN=$alt,CN=Policies,CN=System,$BASIS"
        v="$(ldbsearch -H "$SAM" -b "$alt_dn" -s base versionNumber | sed -n 's/^versionNumber: //p')"
        inhalt="$(find "/var/lib/samba/sysvol/$DOMAENE/Policies/$alt" -mindepth 2 2>/dev/null | head -1)"
        if [ "${v:-0}" != "0" ] || [ -n "$inhalt" ]; then
            echo "\"$ALTNAME\" ($alt) ist nicht mehr leer (Version ${v:-?}) - bitte von Hand ansehen." >&2
            exit 1
        fi
        ldbmodify -H "$SAM" >/dev/null <<EOF
dn: $alt_dn
changetype: modify
replace: displayName
displayName: $NAME
EOF
        guid="$alt"
        echo "Leere Richtlinie \"$ALTNAME\" uebernommen und umbenannt: $guid"
    else
        guid="{$(tr 'a-z' 'A-Z' < /proc/sys/kernel/random/uuid)}"
        ldbadd -H "$SAM" >/dev/null <<EOF
dn: CN=$guid,CN=Policies,CN=System,$BASIS
objectClass: groupPolicyContainer
displayName: $NAME
gPCFileSysPath: \\\\$DOMAENE\\SysVol\\$DOMAENE\\Policies\\$guid
gPCFunctionalityVersion: 2
flags: 0
versionNumber: 0

dn: CN=User,CN=$guid,CN=Policies,CN=System,$BASIS
objectClass: container

dn: CN=Machine,CN=$guid,CN=Policies,CN=System,$BASIS
objectClass: container
EOF
        echo "Richtlinie $NAME angelegt: $guid"
    fi
fi
gpo_dn="CN=$guid,CN=Policies,CN=System,$BASIS"
gpo_dir="/var/lib/samba/sysvol/$DOMAENE/Policies/$guid"
mkdir -p "$gpo_dir/User" "$gpo_dir/Machine"

# An die Domaene haengen: die Konten liegen in CN=Users, und an einen
# Container laesst sich keine Richtlinie haengen. Die Sicherheitsfilterung
# (3.) begrenzt die Wirkung.
link="$(ldbsearch -H "$SAM" -b "$BASIS" -s base gPLink | ldif_zeilen | sed -n 's/^gPLink: //p')"
if ! printf '%s' "$link" | grep -qiF "$guid"; then
    ldbmodify -H "$SAM" >/dev/null <<EOF
dn: $BASIS
changetype: modify
replace: gPLink
gPLink: ${link}[LDAP://CN=$guid,CN=Policies,CN=System,$BASIS;0]
EOF
    echo "An die Domaene gehaengt."
fi

# --- 3. Sicherheitsfilterung -----------------------------------------------
# Wie "Sicherheitsfilterung" in der GPMC: Authentifizierte Benutzer duerfen
# die Richtlinie weiter LESEN (seit MS16-072 liest der Rechner die
# Benutzerrichtlinien mit seinem eigenen Konto), aber nicht mehr ANWENDEN.
# Lesen und Anwenden bekommt die Gruppe Ordnerumleitung.
# dsacl set/delete warnen nur, wenn der Eintrag schon da bzw. weg ist.
samba-tool dsacl delete -H "$SAM" --objectdn="$gpo_dn" \
    --sddl="(OA;CI;CR;$APPLY;;AU)" | grep '^WARNING' || true
samba-tool dsacl set -H "$SAM" --objectdn="$gpo_dn" \
    --sddl="(A;CI;LCRPLORC;;;$sid)(OA;CI;CR;$APPLY;;$sid)" | grep '^WARNING' || true
sd="$(samba-tool dsacl get -H "$SAM" --objectdn="$gpo_dn" | grep '^O:')"
case "$sd" in *"(OA;CI;CR;$APPLY;;AU)"*)
    echo "Authentifizierte Benutzer haben noch 'Anwenden' - abgebrochen." >&2; exit 1 ;; esac
case "$sd" in *"(OA;CI;CR;$APPLY;;$sid)"*) ;; *)
    echo "Gruppe $GRUPPE hat kein 'Anwenden' - abgebrochen." >&2; exit 1 ;; esac
echo "Sicherheitsfilterung: anwenden nur fuer $GRUPPE ($sid)."

# --- 4. Inhalt --------------------------------------------------------------
# Ordnerumleitung: UTF-16LE mit BOM und CRLF ([MS-GPFR] 2.2), ohne Kommentare.
fr_dir="$gpo_dir/User/Documents & Settings"
mkdir -p "$fr_dir"
grep -v '^#' "$HIER/fdeploy1.ini" | sed 's/$/\r/' | iconv -f UTF-8 -t UTF-16LE \
    | { printf '\xff\xfe'; cat; } > "$fr_dir/fdeploy1.ini.neu"
mv "$fr_dir/fdeploy1.ini.neu" "$fr_dir/fdeploy1.ini"

# Keine Offline-Dateien fuer die umgeleiteten Ordner: ohne diese Einstellung
# macht Windows umgeleitete Ordner automatisch offline verfuegbar (Abgleich-
# konflikte, alte Staende nach Netzausfall). Benutzerrichtlinie
# "Umgeleitete Ordner nicht automatisch offline verfuegbar machen".
python3 - "$gpo_dir/User/Registry.pol" <<'EOF'
import sys
from samba.dcerpc import preg, misc
from samba.ndr import ndr_pack
e = preg.entry()
e.keyname = 'Software\\Policies\\Microsoft\\Windows\\NetCache'
e.valuename = 'DisableFRAdminPin'
e.type = misc.REG_DWORD
e.data = 1
f = preg.file()
f.num_entries = 1
f.entries = [e]
open(sys.argv[1], 'wb').write(ndr_pack(f))
EOF

# Erweiterungen eintragen, nur die Benutzer-Version hochzaehlen (obere 16 Bit);
# flags=1: der Computerteil ist leer und abgeschaltet, das spart den Rechnern
# die Auswertung beim Start.
alt="$(ldbsearch -H "$SAM" -b "$gpo_dn" -s base versionNumber | sed -n 's/^versionNumber: //p')"
alt=${alt:-0}
neu=$(( (((((alt >> 16) & 0xFFFF) + 1) & 0xFFFF) << 16) | (alt & 0xFFFF) ))
ldbmodify -H "$SAM" >/dev/null <<EOF
dn: $gpo_dn
changetype: modify
replace: gPCUserExtensionNames
gPCUserExtensionNames: [$FR_CSE][$REG_CSE]
-
replace: flags
flags: 1
-
replace: versionNumber
versionNumber: $neu
EOF
printf '[General]\r\nVersion=%s\r\ndisplayName=%s\r\n' "$neu" "$NAME" > "$gpo_dir/GPT.INI"
echo "Inhalt aktualisiert, Version $neu."

# --- 5. Rechte --------------------------------------------------------------
# setzt auch die Dateirechte im sysvol aus der Sicherheitsfilterung (3.)
samba-tool ntacl sysvolreset
echo "Fertig. Wirkt bei der naechsten Anmeldung einer Person aus $GRUPPE"
echo "(eine neue Mitgliedschaft erst nach Ab- und Anmelden)."
