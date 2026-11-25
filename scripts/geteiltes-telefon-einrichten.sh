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
# Zwei SIP-Anrufkonten (25.11.2026): Rosenweg Gerät registriert die Nebenstelle des Geräts
# (2102 …, "Telefon suchen", gesperrt nur Notrufe), Rosenweg Telefon ab v27 das persönliche
# Konto der angemeldeten Person (<nummer>-<gerät>, nur während der Sitzung).
SIPKONTO=org.sipdroid.sipua.ui.SipConnectionService
schritt "SIP-Anrufkonto Gerät aktiv" a shell telecom set-phone-account-enabled $GERAET/$SIPKONTO SipdroidCallProvider 0
if a shell pm path ch.rosenweg4303.phone >/dev/null 2>&1; then
  schritt "Standard-Telefon-App: Rosenweg Telefon" a shell cmd role add-role-holder android.app.role.DIALER ch.rosenweg4303.phone 0
  if a shell dumpsys package ch.rosenweg4303.phone 2>/dev/null | grep -q "$SIPKONTO"; then
    # Telecom kennt das Konto erst, wenn Rosenweg Telefon einmal lief (App-Start trägt es offline ein)
    if ! a shell dumpsys telecom 2>/dev/null | grep -q "ch.rosenweg4303.phone/$SIPKONTO"; then
      a shell am start -W -n ch.rosenweg4303.phone/org.fossify.phone.activities.MainActivity >/dev/null 2>&1
      sleep 3
    fi
    schritt "SIP-Anrufkonto persönlich (Rosenweg Telefon) aktiv" a shell telecom set-phone-account-enabled ch.rosenweg4303.phone/$SIPKONTO SipdroidCallProvider 0
    schritt "Akku-Optimierung aus (Rosenweg Telefon: SIP bleibt im Ruhemodus registriert)" a shell dumpsys deviceidle whitelist +ch.rosenweg4303.phone
    schritt "Mikrofon für Rosenweg Telefon" a shell pm grant ch.rosenweg4303.phone android.permission.RECORD_AUDIO
    schritt "Anruf-Vollbild über dem Sperrbildschirm (Rosenweg Telefon; ohne: Anruf nur als Symbol, nicht annehmbar)" a shell appops set ch.rosenweg4303.phone USE_FULL_SCREEN_INTENT allow
  else
    echo "alt      Rosenweg Telefon ohne SIP-Kern (vor v27) — telefoniert über das Konto der Geräte-App"
  fi
else
  echo "später   Rosenweg Telefon noch nicht installiert (kommt aus dem Katalog) — Skript danach nochmals laufen lassen"
fi
schritt "Standard-Browser: $BROWSER" a shell cmd role add-role-holder android.app.role.BROWSER "$BROWSER" 0

# Hintergrund und Rechte der Geräte-App
schritt "Akku-Optimierung aus (Geräte-App)" a shell dumpsys deviceidle whitelist +$GERAET
if a shell pm path ch.rosenweg4303.messages >/dev/null 2>&1; then
  schritt "Akku-Optimierung aus (Rosenweg Messenger: Notfälle auch im Ruhemodus)" a shell dumpsys deviceidle whitelist +ch.rosenweg4303.messages
  schritt "\"Nicht stören\" kurz ausschalten (Notfall-Alarm im Messenger)" a shell cmd notification allow_dnd ch.rosenweg4303.messages
  schritt "Notfall-Fenster über dem Sperrbildschirm (Messenger)" a shell appops set ch.rosenweg4303.messages USE_FULL_SCREEN_INTENT allow
  schritt "Exakte Wecker (Notfall-Erinnerung alle 2 Minuten bis gelesen)" a shell appops set ch.rosenweg4303.messages SCHEDULE_EXACT_ALARM allow
else
  echo "später   Rosenweg Messenger noch nicht installiert (Katalog) — Skript danach nochmals laufen lassen"
fi
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
echo "  SIP-Konten:       $(a shell dumpsys telecom 2>/dev/null | grep -c "$SIPKONTO" | tr -d '\r') Einträge (Gerät + persönlich; Details: dumpsys telecom | grep -A3 SipdroidCallProvider)"
echo "  Browser:          $(a shell cmd role get-role-holders android.app.role.BROWSER | tr -d '\r')"
echo "  Seitentaste:      $(a shell settings get global function_key_config_longpress_type | tr -d '\r')/$(a shell settings get global power_button_long_press | tr -d '\r') (soll 0/1)"
echo "  Netz+Sicherheit:  $(a shell settings get secure lock_function_val | tr -d '\r') (soll 0)"
[ $FEHLER = 0 ] && echo "Fertig, alle Schritte ok." || { echo "$FEHLER Schritt(e) fehlgeschlagen."; exit 1; }
