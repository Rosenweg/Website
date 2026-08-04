#!/bin/bash
# ============================================================================
# desktop-schreibschutz-loesen — Windows-Merker von den Ordnern nehmen
# ============================================================================
# Läuft auf dem Fileserver (CT 106).
#
# Windows setzt an jedem Ordner, den eine `desktop.ini` anpasst, das
# DOS-Attribut READONLY. Gemeint ist damit „dieser Ordner ist angepasst" —
# Windows selbst ignoriert das Bit beim Schreiben. **Linux nimmt es wörtlich**
# und streicht das Schreibrecht.
#
# Die Folge, am 3. August auf einer Station gemessen: niemand konnte etwas auf
# seinem Schreibtisch ablegen.
#
#     Home     attrib=0x10  DIRECTORY              ->  drwx------
#     Desktop  attrib=0x11  DIRECTORY | READONLY   ->  dr-x------
#
# Samba legt die Attribute in `user.DOSATTRIB` ab, als NDR-Blob:
#
#     00 00 05 00 | 05 00 00 00 | 11 00 00 00 | 10 00 00 00 | <8 Byte Zeit>
#     Version       ?             valid_flags   attrib        Erstellzeit
#
# Hier wird ausschliesslich Bit 0 von `attrib` gelöscht. Der Blob behält seine
# Länge, alle anderen Attribute (ARCHIVE, HIDDEN, SYSTEM) und die Erstellzeit
# bleiben stehen. Das Attribut ganz zu entfernen wäre einfacher gewesen und
# hätte die Erstellzeit gekostet.
#
# Windows setzt das Bit wieder, sobald es die Ordneranpassung erneut anwendet.
# Deshalb läuft das hier als Timer und nicht einmalig.
#
#   desktop-schreibschutz-loesen.sh [--probe] [--basis /pfad]
#     --probe   nur zeigen, nichts ändern
# ============================================================================

set -uo pipefail

BASIS="/mnt/cephfs-userdata/home"
PROBE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --probe) PROBE=1; shift ;;
        --basis) BASIS="${2:?}"; shift 2 ;;
        -h|--help) sed -n '2,35p' "$0"; exit 0 ;;
        *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
    esac
done

sag() { echo "$*"; command -v logger >/dev/null 2>&1 && logger -t desktop-schreibschutz "$*"; }

[ -d "$BASIS" ] || { sag "Basis fehlt: $BASIS"; exit 1; }
command -v getfattr >/dev/null 2>&1 || { sag "getfattr fehlt (Paket attr)."; exit 1; }

# attrib steht an Byte 12..15, little endian; Bit 0 ist READONLY.
readonly_gesetzt() {
    local hex="${1#0x}"
    [ ${#hex} -ge 26 ] || return 1
    (( 0x${hex:24:2} & 0x01 ))
}

bit_loeschen() {
    local hex="${1#0x}"
    printf '0x%s%02x%s' "${hex:0:24}" "$(( 0x${hex:24:2} & ~0x01 ))" "${hex:26}"
}

geaendert=0
geprueft=0

# Ein einziger rekursiver Aufruf statt eines Prozesses je Ordner.
#
# Der Baum hat rund 15000 Ordner (am 4. August gezählt), davon 15351 tiefer als
# zwei Ebenen — eine Tiefenbegrenzung überspränge also praktisch alles. Mit
# `getfattr -R` liest ein Prozess den ganzen Baum; `setfattr` läuft nur für die
# wenigen, bei denen das Bit wirklich gesetzt ist.
#
# NUR Ordner. Bei einer DATEI ist READONLY ein echter Schreibschutz, den jemand
# absichtlich gesetzt hat — den anzufassen wäre etwas ganz anderes, als einen
# Windows-Merker von einem Ordner zu nehmen.
while IFS=$'\t' read -r ordner roh; do
    [ -n "$ordner" ] || continue
    [ -d "$ordner" ] || continue
    geprueft=$((geprueft + 1))
    readonly_gesetzt "$roh" || continue

    neu="$(bit_loeschen "$roh")"
    if [ "$PROBE" -eq 1 ]; then
        sag "würde lösen: $ordner"
        geaendert=$((geaendert + 1))
        continue
    fi

    if setfattr -n user.DOSATTRIB -v "$neu" "$ordner" 2>/dev/null; then
        sag "Schreibschutz gelöst: $ordner"
        geaendert=$((geaendert + 1))
    else
        sag "FEHLER beim Setzen: $ordner"
    fi
done < <(getfattr -R -h -n user.DOSATTRIB -e hex --absolute-names "$BASIS" 2>/dev/null \
         | awk '/^# file: /   { pfad = substr($0, 9); next }
                /^user\.DOSATTRIB=/ { if (pfad != "") printf "%s\t%s\n", pfad, substr($0, 16); pfad = "" }')

sag "$geprueft Ordner geprüft, $geaendert geändert$([ "$PROBE" -eq 1 ] && echo ' (nur Probe)')."
exit 0
