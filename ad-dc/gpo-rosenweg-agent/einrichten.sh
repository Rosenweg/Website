#!/bin/bash
# ============================================================================
# einrichten.sh - Gruppenrichtlinie "Rosenweg-Agent" auf dc1
# ============================================================================
# Bringt den Rosenweg-Agenten (Rosenweg/rosenweg-agent) auf die Windows-PCs
# der Domaene: ein Computer-Startskript (agent-installieren.ps1) installiert
# ihn als Dienst und haelt ihn aktuell. Dieses Skript legt nur die Huelle an:
#
#   1. die Richtlinie anlegen (einmal) und an OU=Windows haengen - dieselbe
#      OU wie "Rosenweg-Look Windows" (gpo-rosenweg-look-windows/)
#   2. ins sysvol: rosenweg-agent.exe (+ .sha256), netzstart-einmal.ps1 aus
#      os-stationen, agent.json, agent-installieren.ps1; Startskript
#      eintragen, Rechner-Version hochzaehlen
#   3. Rechte im sysvol neu setzen
#
# Auf dc1 als root, im Verzeichnis mit agent-installieren.ps1:
#
#   ./einrichten.sh --exe rosenweg-agent-windows-amd64.exe --netzstart netzstart-einmal.ps1
#   ./einrichten.sh --version 0.1.1 --netzstart …   (Release von GitHub holen)
#   ./einrichten.sh --aus                            (Agent auf allen PCs entfernen)
#   ./einrichten.sh --an                             (AUS wieder wegnehmen)
#
# Die exe kommt entweder als Datei (--exe, z. B. selbst gebaut) oder aus dem
# Release (--version): dann wird sie gegen die SHA256SUMS des Releases
# geprueft UND gegen die Pruefsumme, die unten fuer diese Version steht -
# ein still ausgetauschtes Release faellt so auf. netzstart-einmal.ps1 liegt
# im privaten Repo os-stationen und kommt deshalb als Datei mit; auch sie
# wird gegen eine feste Pruefsumme geprueft (NETZSTART_SHA256).
#
# Wiederholbar: ein zweiter Lauf legt nichts doppelt an, kopiert nur den
# neuen Stand und zaehlt die Version hoch. dc2 bekommt das sysvol ueber
# sysvol-abgleich (ad-dc/README.md); das Startskript prueft die Pruefsumme
# und wartet, bis die Datei vollstaendig da ist.
#
# Vorher einmal: kerberos-dienstkonto.sh (Dienstkonto und Keytab der API).
# ============================================================================
set -euo pipefail

NAME="Rosenweg-Agent"
DOMAENE="ad.rosenweg4303.ch"
BASIS="DC=ad,DC=rosenweg4303,DC=ch"
OU="OU=Windows,$BASIS"
SAM="/var/lib/samba/private/sam.ldb"
HIER="$(cd "$(dirname "$0")" && pwd)"
REPO="Rosenweg/rosenweg-agent"

# Bekannte Fassungen: Version -> sha256 der Windows-exe. Beim Release
# ergaenzen (steht in SHA256SUMS des Releases).
declare -A AGENT_SHA256=(
    [0.1.0]="0a440c8811ff4caff4fe1dea55f6882dd02192a4ccf97d9a0c91917d32c2223c"
    [0.1.1]="8e077dff4f77fdaeceb25a628544c6a18059d5fbe1f5807b5dae93bd8d1c6e83"
)
# os-stationen sicherung/windows/netzstart-einmal.ps1, Stand 4856e6f (27.11.2026).
NETZSTART_SHA256="89b3d88450a877fb1d9d58a9a3f39f1a51ff14bff4750cd6bc9aaec6b91120e6"

# Was in agent.json steht. Keine Geheimnisse - die Anmeldung laeuft ueber
# das Computerkonto (Kerberos), siehe kerberos-dienstkonto.sh.
API="https://www.rosenweg4303.ch/api"
SPN="HTTP/www.rosenweg4303.ch"

exe="" version="" netzstart="" schalter=""
while [ $# -gt 0 ]; do
    case "$1" in
        --exe) exe="$2"; shift 2 ;;
        --version) version="$2"; shift 2 ;;
        --netzstart) netzstart="$2"; shift 2 ;;
        --aus|--an) schalter="${1#--}"; shift ;;
        *) sed -n '18,22p' "$0" >&2; exit 2 ;;
    esac
done
[ -f "$HIER/agent-installieren.ps1" ] || { echo "agent-installieren.ps1 fehlt neben $0" >&2; exit 1; }

# --- 1. Richtlinie -----------------------------------------------------------
# Wie bei gpo-rosenweg-look-windows direkt in die lokale sam.ldb (als root =
# System): samba-tool gpo create braucht ein Admin-Passwort, und das gehoert
# nicht in ein Skript.
guid="$(samba-tool gpo listall -H "$SAM" | awk -v n="$NAME" '
    /^GPO/ { g=$3 } /^display name/ { sub(/^display name *: */,""); if ($0==n) print g }')"
if [ -z "$guid" ]; then
    [ -z "$schalter" ] || { echo "Richtlinie $NAME gibt es noch nicht - erst ohne --$schalter einrichten." >&2; exit 1; }
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
    mkdir -p "/var/lib/samba/sysvol/$DOMAENE/Policies/$guid/User" \
             "/var/lib/samba/sysvol/$DOMAENE/Policies/$guid/Machine"
    echo "Richtlinie $NAME angelegt: $guid"
fi
gpo_dn="CN=$guid,CN=Policies,CN=System,$BASIS"
gpo_dir="/var/lib/samba/sysvol/$DOMAENE/Policies/$guid"
start_dir="$gpo_dir/Machine/Scripts/Startup"
mkdir -p "$start_dir"

link="$(ldbsearch -H "$SAM" -b "$OU" -s base gPLink | awk '/^ / { z = z substr($0, 2); next } { if (NR > 1) print z; z = $0 } END { print z }' | sed -n 's/^gPLink: //p')"
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

# --- 2. Inhalt ---------------------------------------------------------------
if [ -n "$schalter" ]; then
    # Aus: das Startskript entfernt den Agenten (Sperre aufheben, Dienst,
    # Aufgabe, Dateien), sobald es die Datei sieht. Die Richtlinie bleibt
    # haengen, bis alle PCs einmal gelaufen sind - erst dann abhaengen.
    if [ "$schalter" = aus ]; then
        date -Iseconds > "$start_dir/AUS"
        echo "AUS gesetzt: der Agent wird beim naechsten Start bzw. Aktualisierungslauf entfernt."
    else
        rm -f "$start_dir/AUS"
        echo "AUS entfernt: der Agent wird wieder installiert."
    fi
else
    [ -n "$netzstart" ] || { echo "--netzstart PFAD fehlt (os-stationen/sicherung/windows/netzstart-einmal.ps1)" >&2; exit 1; }
    echo "$NETZSTART_SHA256  $netzstart" | sha256sum -c --quiet - \
        || { echo "netzstart-einmal.ps1 hat nicht den bekannten Stand - Pruefsumme oben anpassen, wenn das Absicht ist." >&2; exit 1; }

    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    if [ -n "$version" ]; then
        soll="${AGENT_SHA256[$version]:-}"
        [ -n "$soll" ] || { echo "Fuer Version $version steht oben keine Pruefsumme." >&2; exit 1; }
        url="https://github.com/$REPO/releases/download/v$version"
        curl -fsSL -o "$tmp/rosenweg-agent-windows-amd64.exe" "$url/rosenweg-agent-windows-amd64.exe"
        curl -fsSL -o "$tmp/SHA256SUMS" "$url/SHA256SUMS"
        (cd "$tmp" && grep ' rosenweg-agent-windows-amd64.exe$' SHA256SUMS | sha256sum -c --quiet -) \
            || { echo "SHA256SUMS des Releases passt nicht zur exe." >&2; exit 1; }
        echo "$soll  $tmp/rosenweg-agent-windows-amd64.exe" | sha256sum -c --quiet - \
            || { echo "Release v$version hat nicht die bekannte Pruefsumme - abgebrochen." >&2; exit 1; }
        exe="$tmp/rosenweg-agent-windows-amd64.exe"
    fi
    [ -n "$exe" ] && [ -f "$exe" ] || { echo "--exe DATEI oder --version X.Y.Z angeben" >&2; exit 1; }
    # Ein Windows-Programm beginnt mit MZ - faengt eine HTML-Fehlerseite ab.
    [ "$(head -c 2 "$exe")" = "MZ" ] || { echo "$exe ist kein Windows-Programm" >&2; exit 1; }

    # Erst die Pruefsumme, dann die exe: ein PC, der dazwischen liest, sieht
    # eine alte exe mit neuer Summe und wartet bis zum naechsten Lauf.
    sha256sum "$exe" | awk '{print $1}' > "$start_dir/rosenweg-agent.exe.sha256.neu"
    install -m 0644 "$exe" "$start_dir/rosenweg-agent.exe.neu"
    mv "$start_dir/rosenweg-agent.exe.sha256.neu" "$start_dir/rosenweg-agent.exe.sha256"
    mv "$start_dir/rosenweg-agent.exe.neu" "$start_dir/rosenweg-agent.exe"
    install -m 0644 "$netzstart" "$start_dir/netzstart-einmal.ps1"
    install -m 0644 "$HIER/agent-installieren.ps1" "$start_dir/agent-installieren.ps1"
    printf '{\n  "api": "%s",\n  "spn": "%s"\n}\n' "$API" "$SPN" > "$start_dir/agent.json"
    rm -f "$start_dir/AUS"
    echo "Agent $(sha256sum "$exe" | cut -c1-12)… ins sysvol gelegt."
fi

# scripts.ini statt psscripts.ini, wie beim Rosenweg-Look: die Richtlinie
# startet powershell.exe selbst mit -ExecutionPolicy Bypass.
unc="\\\\$DOMAENE\\SysVol\\$DOMAENE\\Policies\\$guid\\Machine\\Scripts\\Startup\\agent-installieren.ps1"
printf '\r\n[Startup]\r\n0CmdLine=%s\r\n0Parameters=%s\r\n' \
    'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' \
    "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"$unc\"" \
    | iconv -f UTF-8 -t UTF-16LE | { printf '\xff\xfe'; cat; } > "$gpo_dir/Machine/Scripts/scripts.ini"

# Nur der Rechnerteil: Version untere 16 Bit, flags=1 (Benutzerteil aus).
alt="$(ldbsearch -H "$SAM" -b "$gpo_dn" -s base versionNumber | sed -n 's/^versionNumber: //p')"
alt=${alt:-0}
neu=$(( (alt & 0xFFFF0000) | (((alt & 0xFFFF) + 1) & 0xFFFF) ))
ldbmodify -H "$SAM" >/dev/null <<EOF
dn: $gpo_dn
changetype: modify
replace: gPCMachineExtensionNames
gPCMachineExtensionNames: [{42B5FAAE-6536-11D2-AE5A-0000F87571E3}{40B6664F-4972-11D1-A7CA-0000F87571E3}]
-
replace: flags
flags: 1
-
replace: versionNumber
versionNumber: $neu
EOF
printf '[General]\r\nVersion=%s\r\ndisplayName=%s\r\n' "$neu" "$NAME" > "$gpo_dir/GPT.INI"
echo "Version $neu."

# --- 3. Rechte ---------------------------------------------------------------
samba-tool ntacl sysvolreset
echo "Fertig. Wirkt beim naechsten Start der PCs in OU=Windows (oder: gpupdate /force und Neustart);"
echo "danach holt die Aufgabe 'Rosenweg-Agent aktualisieren' neue Fassungen zweimal am Tag."
