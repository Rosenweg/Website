#!/bin/bash
# ============================================================================
# kerberos-dienstkonto.sh - Dienstkonto und Keytab fuer die Agent-Anmeldung
# ============================================================================
# Der Rosenweg-Agent auf einem Windows-PC meldet sich bei der API mit dem
# Computerkonto an (Kerberos, POST /api/stations/v2/anmelden). Dafuer braucht
# das AD einen Dienstnamen (SPN) HTTP/www.rosenweg4303.ch auf einem Konto, und
# die API dessen Schluessel als Keytab.
#
#   1. Konto stationen-api anlegen (einmal), mit Zufallspasswort, das niemand
#      sieht und niemand braucht - ausser dem Export unten
#   2. SPN eintragen; bricht ab, wenn er schon einem anderen Konto gehoert
#      (dann bekaeme der Agent ein Ticket mit dem falschen Schluessel)
#   3. nur AES (msDS-SupportedEncryptionTypes = 24): kein RC4
#   4. Keytab exportieren -> Datei, nur root lesbar
#
# Auf dc1 als root:
#
#   ./kerberos-dienstkonto.sh [/root/stationen-api.keytab]
#
# Danach die Keytab auf den Docker-Knoten der API bringen und dort als
# Secret einhaengen (README.md daneben, "Kerberos in der API"). Die Datei ist
# ein Schluessel: nicht ins Repo, nicht in den Chat, nach dem Kopieren hier
# loeschen.
#
# Wiederholbar. Ein zweiter Lauf exportiert dieselbe Keytab noch einmal; ein
# neues Passwort setzt er NICHT (dann muesste die API gleichzeitig die neue
# Keytab bekommen). Neu verschluesseln: samba-tool user setpassword
# stationen-api --random-password, dann dieses Skript, dann API neu.
# ============================================================================
set -euo pipefail

KONTO="stationen-api"
SPN="HTTP/www.rosenweg4303.ch"
BASIS="DC=ad,DC=rosenweg4303,DC=ch"
SAM="/var/lib/samba/private/sam.ldb"
ZIEL="${1:-/root/stationen-api.keytab}"

if ! samba-tool user show "$KONTO" -H "$SAM" >/dev/null 2>&1; then
    samba-tool user add "$KONTO" --random-password -H "$SAM" \
        --description="Dienstkonto der Stationen-API: Kerberos-Anmeldung des Rosenweg-Agenten (SPN $SPN)" >/dev/null
    samba-tool user setexpiry "$KONTO" --noexpiry -H "$SAM" >/dev/null
    echo "Konto $KONTO angelegt."
fi
dn="$(samba-tool user show "$KONTO" -H "$SAM" --attributes=dn | sed -n 's/^dn: //p')"

# Gehoert der SPN schon jemandem?
besitzer="$(ldbsearch -H "$SAM" -b "$BASIS" "(servicePrincipalName=$SPN)" dn | sed -n 's/^dn: //p')"
if [ -n "$besitzer" ] && [ "$besitzer" != "$dn" ]; then
    echo "$SPN gehoert schon $besitzer - abgebrochen." >&2
    exit 1
fi
if [ -z "$besitzer" ]; then
    samba-tool spn add "$SPN" "$KONTO" -H "$SAM"
    echo "SPN $SPN an $KONTO."
fi

ldbmodify -H "$SAM" >/dev/null <<EOF
dn: $dn
changetype: modify
replace: msDS-SupportedEncryptionTypes
msDS-SupportedEncryptionTypes: 24
EOF

umask 077
rm -f "$ZIEL"
samba-tool domain exportkeytab "$ZIEL" --principal="$SPN" -H "$SAM"
chmod 600 "$ZIEL"
echo "Keytab: $ZIEL (nur root). Eintraege:"
klist -k -e "$ZIEL" 2>/dev/null | sed -n '1,20p' || true
echo
echo "Weiter: README.md, 'Kerberos in der API'. Danach $ZIEL hier loeschen."
