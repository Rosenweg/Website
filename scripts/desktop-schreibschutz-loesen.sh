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

# Tiefe 2: die Heimatordner selbst und ihre unmittelbaren Unterordner. Tiefer
# zu gehen hiesse, über fremde Dokumentenbäume zu laufen — dort richtet das
# Bit keinen Schaden an, und ein Lauf über zehntausende Ordner wäre teuer.
while IFS= read -r -d '' ordner; do
    geprueft=$((geprueft + 1))
    roh="$(getfattr -n user.DOSATTRIB -e hex --absolute-names "$ordner" 2>/dev/null \
           | sed -n 's/^user.DOSATTRIB=//p')"
    [ -n "$roh" ] || continue
    readonly_gesetzt "$roh" || continue

    neu="$(bit_loeschen "$roh")"
    if [ "$PROBE" -eq 1 ]; then
        sag "würde lösen: $ordner ($roh -> $neu)"
        geaendert=$((geaendert + 1))
        continue
    fi

    if setfattr -n user.DOSATTRIB -v "$neu" "$ordner" 2>/dev/null; then
        sag "Schreibschutz gelöst: $ordner"
        geaendert=$((geaendert + 1))
    else
        sag "FEHLER beim Setzen: $ordner"
    fi
done < <(find "$BASIS" -mindepth 1 -maxdepth 2 -type d -print0 2>/dev/null)

sag "$geprueft Ordner geprüft, $geaendert geändert$([ "$PROBE" -eq 1 ] && echo ' (nur Probe)')."
exit 0
