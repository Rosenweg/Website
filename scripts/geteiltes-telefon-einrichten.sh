#!/bin/bash
# Geteiltes Rosenweg-Telefon: alle einmaligen adb-Schritte (pbx/GETEILTE-TELEFONE.md,
# "Was der Device Owner nicht selbst darf"). Darf beliebig oft laufen.
#
#   scripts/geteiltes-telefon-einrichten.sh <adb-seriennummer> [--device-owner] [--browser <paket>]
#
#   --device-owner   Rosenweg Gerät als Device Owner setzen (nur frisch zurückgesetzt,
#                    ohne Google-/Samsung-Konto; Geräte-App muss installiert sein)
#   --browser        Standard-Browser (Vorgabe: com.android.chrome)
#
# Notrufe werden nie getestet. Das Telefon wird nicht neu gestartet.
set -u
SERIE=${1:?Seriennummer fehlt (adb devices)}; shift
DO=0; BROWSER=com.android.chrome
while [ $# -gt 0 ]; do
  case "$1" in
    --device-owner) DO=1 ;;
    --browser) BROWSER=$2; shift ;;
    *) echo "Unbekannt: $1"; exit 2 ;;
  esac; shift
done
ADB=${ADB:-adb}
a() { "$ADB" -s "$SERIE" "$@"; }
GERAET=ch.rosenweg4303.telefon
FEHLER=0
schritt() {   # schritt "Beschreibung" befehl…
  local was=$1; shift
  if out=$("$@" 2>&1); then echo "ok      $was"; else echo "FEHLER  $was: $(echo "$out" | tail -1)"; FEHLER=$((FEHLER+1)); fi
}

a get-state >/dev/null 2>&1 || { echo "Telefon $SERIE nicht erreichbar (adb devices, USB-Debugging)"; exit 1; }
a shell pm path $GERAET >/dev/null 2>&1 || { echo "Rosenweg Gerät ($GERAET) ist nicht installiert — zuerst installieren."; exit 1; }

if [ $DO = 1 ]; then
  schritt "Device Owner: Rosenweg Gerät" a shell dpm set-device-owner $GERAET/org.sipdroid.sipua.rosenweg.AdminReceiver
fi
a shell dpm list-owners 2>/dev/null | grep -q "$GERAET.*DeviceOwner" \
  || echo "WARNUNG  Rosenweg Gerät ist nicht Device Owner — mit --device-owner auf frisch zurückgesetztem Gerät"

# Telefonie
schritt "SIP-Anrufkonto aktiv" a shell telecom set-phone-account-enabled $GERAET/org.sipdroid.sipua.ui.SipConnectionService SipdroidCallProvider 0
if a shell pm path ch.rosenweg4303.phone >/dev/null 2>&1; then
  schritt "Standard-Telefon-App: Rosenweg Telefon" a shell cmd role add-role-holder android.app.role.DIALER ch.rosenweg4303.phone 0
else
  echo "später   Rosenweg Telefon noch nicht installiert (kommt aus dem Katalog) — Skript danach nochmals laufen lassen"
fi
schritt "Standard-Browser: $BROWSER" a shell cmd role add-role-holder android.app.role.BROWSER "$BROWSER" 0

# Hintergrund und Rechte der Geräte-App
schritt "Akku-Optimierung aus (Geräte-App)" a shell dumpsys deviceidle whitelist +$GERAET
schritt "Zugriff auf alle Dateien (Aufräumen beim Abmelden)" a shell appops set $GERAET MANAGE_EXTERNAL_STORAGE allow
schritt "\"Nicht stören\" kurz ausschalten (Telefon suchen)" a shell cmd notification allow_dnd $GERAET

# Startseite
schritt "Launcher darf Widgets einbinden (Uhr auf der Startseite)" a shell appwidget grantbind --package ch.rosenweg4303.home --user 0

# Samsung: Neustart auch gesperrt möglich (Neustart meldet ab, PIN ist danach weg)
schritt "Seitentaste lang = Ausschaltmenü (1/2)" a shell settings put global function_key_config_longpress_type 0
schritt "Seitentaste lang = Ausschaltmenü (2/2)" a shell settings put global power_button_long_press 1
schritt "\"Netzwerk und Sicherheit sperren\" aus (Neustart ohne PIN)" a shell settings put secure lock_function_val 0

# Kontrolle
echo
echo "Kontrolle:"
echo "  Device Owner:     $(a shell dpm list-owners 2>/dev/null | grep -c DeviceOwner)"
echo "  Telefon-App:      $(a shell cmd role get-role-holders android.app.role.DIALER | tr -d '\r')"
echo "  Browser:          $(a shell cmd role get-role-holders android.app.role.BROWSER | tr -d '\r')"
echo "  Seitentaste:      $(a shell settings get global function_key_config_longpress_type | tr -d '\r')/$(a shell settings get global power_button_long_press | tr -d '\r') (soll 0/1)"
echo "  Netz+Sicherheit:  $(a shell settings get secure lock_function_val | tr -d '\r') (soll 0)"
[ $FEHLER = 0 ] && echo "Fertig, alle Schritte ok." || { echo "$FEHLER Schritt(e) fehlgeschlagen."; exit 1; }
