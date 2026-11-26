#!/bin/bash
# ============================================================================
# einrichten.sh - Gruppenrichtlinie "Rosenweg-Look Windows" auf dc1
# ============================================================================
# Windows-Rechner der Domaene sollen aussehen wie die Stationen: dasselbe
# Hintergrund- und Sperrbild, Akzentfarbe Mint-Blau, Taskleiste links, das
# Rosenweg-Logo als Hersteller-Logo und Standard-Kontobild. Die Arbeit macht
# rosenweg-look.ps1 als Startskript; dieses Skript legt nur die Huelle an:
#
#   1. OU=Windows (Computer liegen sonst in CN=Computers, und an einen
#      Container laesst sich keine Richtlinie haengen)
#   2. die genannten Rechner dorthin verschieben
#   3. die Richtlinie anlegen (einmal) und an OU=Windows haengen
#   4. Skript und Bilder ins sysvol, Startskript (Rechner) und Abmeldeskript
#      (Benutzer) eintragen, Version hochzaehlen; den Open-Shell-Installer
#      einmal mit Pruefsumme holen
#   5. Rechte im sysvol neu setzen
#
# Auf dc1 als root, im Verzeichnis mit rosenweg-look.ps1 und bilder/:
#
#   ./einrichten.sh WIN11-1 [WEITERE ...]
#
# Wiederholbar: ein zweiter Lauf legt nichts doppelt an, kopiert nur den
# neuen Stand und zaehlt die Version hoch, damit die Rechner ihn holen.
# dc2 bekommt das sysvol ueber sysvol-abgleich (ad-dc/README.md).
# ============================================================================
set -euo pipefail

NAME="Rosenweg-Look Windows"
DOMAENE="ad.rosenweg4303.ch"
BASIS="DC=ad,DC=rosenweg4303,DC=ch"
OU="OU=Windows,$BASIS"
SAM="/var/lib/samba/private/sam.ldb"
HIER="$(cd "$(dirname "$0")" && pwd)"

[ -f "$HIER/rosenweg-look.ps1" ] || { echo "rosenweg-look.ps1 fehlt neben $0" >&2; exit 1; }
for b in hintergrund.png sperrbild.png logo.png startknopf.png; do
    [ -f "$HIER/bilder/$b" ] || { echo "bilder/$b fehlt" >&2; exit 1; }
done

# Open-Shell (klassisches Startmenue, rosenweg-look.ps1): feste Version, nicht
# im Git (10 MB Fremd-Binary), sondern hier geholt und gegen die Pruefsumme
# geprueft. Liegt danach neben diesem Skript in programme/ und wird nicht
# erneut geladen. Ohne Netz auf dc1: Datei von Hand dorthin legen.
# Version und Pruefsumme stehen auch in rosenweg-look.ps1 - beide aendern.
OPENSHELL_DATEI="OpenShellSetup_4_4_198.exe"
OPENSHELL_URL="https://github.com/Open-Shell/Open-Shell-Menu/releases/download/v4.4.198/$OPENSHELL_DATEI"
OPENSHELL_SHA256="a4d2d4459de55b5e962ba2a14f7bb794170511649138173dfa72949837b48c3f"
mkdir -p "$HIER/programme"
if [ ! -f "$HIER/programme/$OPENSHELL_DATEI" ]; then
    curl -fsSL -o "$HIER/programme/$OPENSHELL_DATEI.neu" "$OPENSHELL_URL"
    mv "$HIER/programme/$OPENSHELL_DATEI.neu" "$HIER/programme/$OPENSHELL_DATEI"
fi
echo "$OPENSHELL_SHA256  $HIER/programme/$OPENSHELL_DATEI" | sha256sum -c --quiet - \
    || { echo "Pruefsumme von $OPENSHELL_DATEI stimmt nicht - Datei loeschen und neu laden" >&2; exit 1; }

# --- 1. OU ------------------------------------------------------------------
if ! samba-tool ou list -H "$SAM" | grep -qx "OU=Windows"; then
    samba-tool ou create "$OU" -H "$SAM" --description="Windows-Rechner (Rosenweg-Look)"
    echo "OU=Windows angelegt."
fi

# --- 2. Rechner -------------------------------------------------------------
for rechner in "$@"; do
    dn="$(samba-tool computer show "$rechner" -H "$SAM" --attributes=dn 2>/dev/null | sed -n 's/^dn: //p')"
    [ -n "$dn" ] || { echo "Rechner $rechner gibt es im AD nicht." >&2; exit 1; }
    case "$dn" in
        *",$OU") ;;
        *) samba-tool computer move "$rechner" "$OU" -H "$SAM"; echo "$rechner nach OU=Windows verschoben." ;;
    esac
done

# --- 3. Richtlinie ----------------------------------------------------------
# Direkt in die lokale sam.ldb (als root = System), nicht ueber samba-tool gpo
# create/setlink: die brauchen ein Konto mit Rechten auf CN=Policies, und das
# Maschinenkonto des DC (-P) hat sie nicht ("insufficient access rights",
# 22.11.2026). Ein Admin-Passwort gehoert nicht in ein Skript. Angelegt wird
# genau das, was samba-tool auch anlegt: der groupPolicyContainer mit den
# Unterknoten User/Machine, die Ordner im sysvol, der Eintrag in gPLink.
guid="$(samba-tool gpo listall -H "$SAM" | awk -v n="$NAME" '
    /^GPO/ { g=$3 } /^display name/ { sub(/^display name *: */,""); if ($0==n) print g }')"
if [ -z "$guid" ]; then
    guid="{$(cat /proc/sys/kernel/random/uuid | tr 'a-z' 'A-Z')}"
    gpo_dn="CN=$guid,CN=Policies,CN=System,$BASIS"
    ldbadd -H "$SAM" >/dev/null <<EOF
dn: $gpo_dn
objectClass: groupPolicyContainer
displayName: $NAME
gPCFileSysPath: \\\\$DOMAENE\\SysVol\\$DOMAENE\\Policies\\$guid
gPCFunctionalityVersion: 2
flags: 0
versionNumber: 0

dn: CN=User,$gpo_dn
objectClass: container

dn: CN=Machine,$gpo_dn
objectClass: container
EOF
    mkdir -p "/var/lib/samba/sysvol/$DOMAENE/Policies/$guid/User" \
             "/var/lib/samba/sysvol/$DOMAENE/Policies/$guid/Machine"
    echo "Richtlinie $NAME angelegt: $guid"
fi
[ -n "$guid" ] || { echo "Richtlinie nicht gefunden/angelegt." >&2; exit 1; }
link="$(ldbsearch -H "$SAM" -b "$OU" -s base gPLink | sed -n 's/^gPLink: //p')"
case "$link" in
    *"$guid"*) ;;
    *)
        ldbmodify -H "$SAM" >/dev/null <<EOF
dn: $OU
changetype: modify
replace: gPLink
gPLink: ${link}[LDAP://CN=$guid,CN=Policies,CN=System,$BASIS;0]
EOF
        echo "An OU=Windows gehaengt."
        ;;
esac

# --- 4. Inhalt --------------------------------------------------------------
gpo_dir="/var/lib/samba/sysvol/$DOMAENE/Policies/$guid"
start_dir="$gpo_dir/Machine/Scripts/Startup"
mkdir -p "$start_dir"
install -m 0644 "$HIER/rosenweg-look.ps1" "$start_dir/rosenweg-look.ps1"
install -m 0644 "$HIER"/bilder/*.png "$start_dir/"
install -m 0644 "$HIER/programme-freigaben.txt" "$start_dir/programme-freigaben.txt"
install -m 0644 "$HIER/bginfo.ps1" "$start_dir/bginfo.ps1"
install -m 0644 "$HIER/drucker.ps1" "$start_dir/drucker.ps1"
install -m 0644 "$HIER/programme/$OPENSHELL_DATEI" "$start_dir/$OPENSHELL_DATEI"

# scripts.ini statt psscripts.ini: so startet die Richtlinie powershell.exe
# selbst und kann -ExecutionPolicy Bypass mitgeben. Ein Windows-Client steht
# ab Werk auf Restricted und wuerde ein .ps1 aus psscripts.ini verweigern.
unc="\\\\$DOMAENE\\SysVol\\$DOMAENE\\Policies\\$guid\\Machine\\Scripts\\Startup\\rosenweg-look.ps1"
printf '\r\n[Startup]\r\n0CmdLine=%s\r\n0Parameters=%s\r\n' \
    'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' \
    "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"$unc\"" \
    | iconv -f UTF-8 -t UTF-16LE | { printf '\xff\xfe'; cat; } > "$gpo_dir/Machine/Scripts/scripts.ini"

# Abmeldeskript (Benutzerteil): raeumt die Drucker im Profil auf, BEVOR das
# servergespeicherte Profil hochgeladen wird (drucker.ps1). Es ruft die Kopie
# unter Programme auf, die rosenweg-look.ps1 beim Start hinlegt - die
# Programm-Whitelist laesst Skripte nur von dort zu, und so gibt es nur eine
# Datei. Wirkt, weil rosenweg-look.ps1 Loopback (Zusammenfuehren) einschaltet:
# die Konten liegen nicht in OU=Windows.
mkdir -p "$gpo_dir/User/Scripts/Logoff"
printf '\r\n[Logoff]\r\n0CmdLine=%s\r\n0Parameters=%s\r\n' \
    'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' \
    '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Program Files\Rosenweg\drucker.ps1" -Anlass Abmelden' \
    | iconv -f UTF-8 -t UTF-16LE | { printf '\xff\xfe'; cat; } > "$gpo_dir/User/Scripts/scripts.ini"

# Erweiterung "Skripts" fuer beide Teile eintragen und beide Versionen
# hochzaehlen (Rechner: untere 16 Bit, Benutzer: obere 16 Bit) - ohne das
# holt Windows die Aenderung nicht.
gpo_dn="CN=$guid,CN=Policies,CN=System,$BASIS"
alt="$(ldbsearch -H "$SAM" -b "$gpo_dn" -s base versionNumber | sed -n 's/^versionNumber: //p')"
alt=${alt:-0}
neu=$(( ((((alt >> 16) & 0xFFFF) + 1) << 16) | (((alt & 0xFFFF) + 1) & 0xFFFF) ))
ldbmodify -H "$SAM" >/dev/null <<EOF
dn: $gpo_dn
changetype: modify
replace: gPCMachineExtensionNames
gPCMachineExtensionNames: [{42B5FAAE-6536-11D2-AE5A-0000F87571E3}{40B6664F-4972-11D1-A7CA-0000F87571E3}]
-
replace: gPCUserExtensionNames
gPCUserExtensionNames: [{42B5FAAE-6536-11D2-AE5A-0000F87571E3}{40B6664F-4972-11D1-A7CA-0000F87571E3}]
-
replace: versionNumber
versionNumber: $neu
EOF
printf '[General]\r\nVersion=%s\r\ndisplayName=%s\r\n' "$neu" "$NAME" > "$gpo_dir/GPT.INI"
echo "Inhalt aktualisiert, Version $neu."

# --- 5. Rechte --------------------------------------------------------------
samba-tool ntacl sysvolreset
echo "Fertig. Wirkt beim naechsten Start der Rechner (oder: gpupdate /force und Neustart);"
echo "das Abmeldeskript ab der zweiten Anmeldung danach (Loopback setzt erst der Start)."
