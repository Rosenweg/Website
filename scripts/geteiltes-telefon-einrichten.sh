#!/bin/bash
# Geteiltes Rosenweg-Telefon: alle einmaligen adb-Schritte (pbx/GETEILTE-TELEFONE.md,
# "Was der Device Owner nicht selbst darf"). Darf beliebig oft laufen.
#
#   scripts/geteiltes-telefon-einrichten.sh <adb-seriennummer> [--device-owner] [--browser <paket>]
#                                           [--nebenstelle <21xx>]
#
#   --device-owner   Rosenweg Gerät als Device Owner setzen (nur frisch zurückgesetzt,
#                    ohne Google-/Samsung-Konto; Geräte-App muss installiert sein)
#   --browser        Standard-Browser (Vorgabe: com.android.chrome)
#   --nebenstelle    erstes Einrichten: Nebenstelle und SIP-Passwort an Rosenweg Gerät geben
#                    (ab Gerät v246, ADB_ZUGANG). Das Passwort kommt aus sip_extensions auf
#                    CT 220 und geht nur per Pipe ans Telefon, nie auf die Kommandozeile oder
#                    ins Log. Zugang zur Anlage: PBX_EXEC (Vorgabe "ssh root@100.64.2.22 pct exec 220 --").
#                    Nötig, wenn der Device Owner vor den SIP-Einstellungen gesetzt wurde: als
#                    Device Owner ist die SIP-Einstellungsseite nicht mehr erreichbar.
#   --nur-adb        nur adb über TCP Port 5555 wieder setzen (nach einem Neustart des
#                    Telefons ist er weg; per USB: Seriennummer aus "adb devices")
#
# Über den Fernwartungs-Tunnel (pbx/adb-zentrale): auf adb-zentrale "rw-adb <ext> einrichten"
# ruft dieses Skript mit der Seriennummer 127.0.0.1:2<ext> auf (lokaler Sitzungsport, nicht
# das WLAN des Telefons). Alles ausser --device-owner geht so ohne USB.
#
# Notrufe werden nie getestet. Das Telefon wird nicht neu gestartet.
set -u
SERIE=${1:?Seriennummer fehlt (adb devices)}; shift
DO=0; BROWSER=com.android.chrome; NUR_ADB=0; NEBENSTELLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --device-owner) DO=1 ;;
    --browser) BROWSER=$2; shift ;;
    --nur-adb) NUR_ADB=1 ;;
    --nebenstelle) NEBENSTELLE=${2:-}; shift ;;
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

# Vollbild über dem Sperrbildschirm: App-Op erst ab Android 14 (SDK 34). Bis Android 13 ist
# USE_FULL_SCREEN_INTENT eine normale Berechtigung, mit der Installation erteilt (XCover Pro).
SDK=$(a shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')
vollbild() {   # vollbild "Beschreibung" paket
  if [ "${SDK:-0}" -ge 34 ]; then schritt "$1" a shell appops set "$2" USE_FULL_SCREEN_INTENT allow
  elif a shell dumpsys package "$2" 2>/dev/null | grep -q "USE_FULL_SCREEN_INTENT: granted=true"; then
    echo "ok      $1 (Android $SDK: mit der Installation erteilt)"
  else echo "FEHLER  $1: USE_FULL_SCREEN_INTENT nicht erteilt"; FEHLER=$((FEHLER+1)); fi
}
# Rolleninhaber: "cmd role get-role-holders" gibt es erst ab Android 14
rolle() { a shell cmd role get-role-holders "$1" 2>/dev/null | tr -d '\r' | grep -v "^Unknown" \
  || a shell dumpsys role 2>/dev/null | grep -A1 "name=$1\$" | sed -n 's/.*holders=//p' | tr -d '\r'; }

# Seriennummer eines Sitzungsports der adb-zentrale (127.0.0.1:2xxxx): über den Tunnel
TUNNEL=0
case "$SERIE" in 127.0.0.1:2[0-9][0-9][0-9][0-9]) TUNNEL=1 ;; esac
a get-state >/dev/null 2>&1 || {
  if [ $TUNNEL = 1 ]; then echo "Telefon $SERIE über den Tunnel nicht erreichbar (rw-adb <ext> zuerst, Telefon wecken auf /smartphones)"
  else echo "Telefon $SERIE nicht erreichbar (adb devices, USB-Debugging; über das Netz: auf /smartphones zuerst \"1 Std.\")"; fi
  exit 1; }

# Wartung per adb über das Netz (Stefan 25.11.2026): klassisches adb auf Port 5555. Zentral
# geschaltet wird nur adb selbst (/smartphones, Gerät setzt ADB_ENABLED). Hält auch bei
# gesperrtem Bildschirm und beim Wechsel des Zugangspunkts. Nach einem Neustart des Telefons
# ist der Port weg: --nur-adb per USB.
adb_tcp() {
  if [ "$(a shell getprop service.adb.tcp.port 2>/dev/null | tr -d '\r')" = 5555 ]; then
    echo "ok      adb über TCP Port 5555 (war schon)"; return
  fi
  a tcpip 5555 >/dev/null 2>&1   # adbd startet neu, die Verbindung bricht kurz ab
  if [ $TUNNEL = 1 ]; then
    # Über den Tunnel: die Seriennummer ist der Sitzungsport der Zentrale und bleibt gleich
    # (nicht auf :5555 umschreiben) - warten, bis adbd wieder da ist, und neu verbinden.
    sleep 3; "$ADB" disconnect "$SERIE" >/dev/null 2>&1; "$ADB" connect "$SERIE" >/dev/null 2>&1
  else
    case "$SERIE" in
      *:*) # selbst über das Netz verbunden: neu verbinden, danach über Port 5555 weiter
           sleep 3; SERIE="${SERIE%:*}:5555"; "$ADB" connect "$SERIE" >/dev/null 2>&1 ;;
      *)   sleep 2 ;;
    esac
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    a get-state >/dev/null 2>&1 && break
    [ $TUNNEL = 1 ] && "$ADB" connect "$SERIE" >/dev/null 2>&1
    sleep 2
  done
  if [ "$(a shell getprop service.adb.tcp.port 2>/dev/null | tr -d '\r')" = 5555 ]; then
    echo "ok      adb über TCP Port 5555"
  else
    echo "FEHLER  adb über TCP Port 5555 (Telefon $SERIE nicht wieder erreichbar)"; FEHLER=$((FEHLER+1))
  fi
}
# C (Stefan 25.11.2026): Rosenweg Geraet stellt Port 5555 nach einem Neustart selbst wieder her
# (libadb). Dafuer seinen eigenen adb-Schluessel einmal freigeben, solange 5555 offen ist; die
# Rueckfrage bestaetigt die Bedienungshilfe (nur dieser Fingerabdruck). Freigaben sollen nicht
# nach 7 Tagen ohne Verbindung verfallen (Android-Vorgabe), sonst klappt es nach langer Zeit nicht.
adb_selbst() {
  schritt "adb-Freigaben verfallen nicht (adb_allowed_connection_time 0)" a shell settings put global adb_allowed_connection_time 0
  a shell input keyevent 224 >/dev/null 2>&1   # Bildschirm an, sonst erscheint die Rueckfrage nicht
  a logcat -c >/dev/null 2>&1
  a shell am broadcast -a $GERAET.ADB_SELBST_FREIGEBEN -n $GERAET/org.sipdroid.sipua.rosenweg.AdbFreigabe >/dev/null 2>&1
  local erg=""
  for _ in $(seq 1 50); do
    erg=$(a logcat -d -s RosenwegAdbSelbst 2>/dev/null | grep -o "freigeben: .*" | tail -1)
    [ -n "$erg" ] && break; sleep 2
  done
  if [ "$erg" = "freigeben: OK" ]; then echo "ok      Rosenweg Gerät: eigener adb-Schlüssel freigegeben (Port 5555 nach Neustart ohne USB)"
  else echo "FEHLER  Rosenweg Gerät: eigener adb-Schlüssel ${erg:-keine Antwort (Gerät ab v224?)}"; FEHLER=$((FEHLER+1)); fi
}
if [ $NUR_ADB = 1 ]; then
  adb_tcp
  adb_selbst
  [ $FEHLER = 0 ] && echo "Fertig: adb connect <adresse>:5555 (Adresse auf /smartphones)" || exit 1
  exit 0
fi
a shell pm path $GERAET >/dev/null 2>&1 || { echo "Rosenweg Gerät ($GERAET) ist nicht installiert — zuerst installieren."; exit 1; }

if [ $DO = 1 ]; then
  schritt "Device Owner: Rosenweg Gerät" a shell dpm set-device-owner $GERAET/org.sipdroid.sipua.rosenweg.AdminReceiver
fi
# Erstes Einrichten: Nebenstelle + SIP-Passwort (ohne sie bleibt der Sperrbildschirm bei
# "Dieses Telefon ist noch nicht eingerichtet." und der Katalog installiert nichts)
if [ -n "$NEBENSTELLE" ]; then
  case "$NEBENSTELLE" in 21[0-9][0-9]) ;; *) echo "Nebenstelle $NEBENSTELLE: Geräte haben 2100-2199"; exit 2 ;; esac
  PBX_EXEC=${PBX_EXEC:-ssh root@100.64.2.22 pct exec 220 --}
  a logcat -c >/dev/null 2>&1
  # Passwort nur von der Anlage über stdin ins Telefon; die adb-Shell liest es mit read
  # Code über stdin: ssh setzt die Argumente zu einer Zeile zusammen, -c "…" überstünde das nicht
  $PBX_EXEC python3 - "$NEBENSTELLE" <<'PY' | a shell "read -r pw; [ -n \"\$pw\" ] && am broadcast -a $GERAET.ADB_ZUGANG --es ext $NEBENSTELLE --es pw \"\$pw\" -n $GERAET/org.sipdroid.sipua.rosenweg.AdbFreigabe >/dev/null"
import sqlite3, sys
r = sqlite3.connect("file:/var/lib/pbx-api/pbx.sqlite?mode=ro", uri=True).execute(
    "select secret from sip_extensions where ext=? and enabled=1", (sys.argv[1],)).fetchone()
sys.exit(1) if not r or not r[0] else print(r[0])
PY
  erg=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    erg=$(a logcat -d -s RosenwegKatalog 2>/dev/null | grep -o "Zugang per adb eingerichtet.*\|ADB_ZUGANG: .*" | tail -1)
    [ -n "$erg" ] && break; sleep 1
  done
  case "$erg" in
    Zugang*) echo "ok      SIP-Zugang Nebenstelle $NEBENSTELLE (Rosenweg Gerät)" ;;
    *) echo "FEHLER  SIP-Zugang Nebenstelle $NEBENSTELLE: ${erg:-keine Antwort (Nebenstelle in sip_extensions? Gerät ab v246?)}"; FEHLER=$((FEHLER+1)) ;;
  esac
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
    vollbild "Anruf-Vollbild über dem Sperrbildschirm (Rosenweg Telefon; ohne: Anruf nur als Symbol, nicht annehmbar)" ch.rosenweg4303.phone
    schritt "Bedienungshilfe Rosenweg Gerät (bestätigt Debugging über WLAN nur im WLAN Rosenweg)" a shell settings put secure enabled_accessibility_services ch.rosenweg4303.telefon/org.sipdroid.sipua.rosenweg.WlanBestaetiger
    schritt "Bedienungshilfen aktiv" a shell settings put secure accessibility_enabled 1
    schritt "Benachrichtigungs-Wächter Rosenweg Gerät (entfernt \"Beenden der Galaxy-Einrichtung\")" a shell cmd notification allow_listener ch.rosenweg4303.telefon/org.sipdroid.sipua.rosenweg.Benachrichtigungen
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
  vollbild "Notfall-Fenster über dem Sperrbildschirm (Messenger)" ch.rosenweg4303.messages
  schritt "Exakte Wecker (Notfall-Erinnerung alle 2 Minuten bis gelesen)" a shell appops set ch.rosenweg4303.messages SCHEDULE_EXACT_ALARM allow
else
  echo "später   Rosenweg Messenger noch nicht installiert (Katalog) — Skript danach nochmals laufen lassen"
fi
# Kontakte/Kalender gleichen mit der Nextcloud ab: ohne Ausnahme sperrt Android ihnen im Ruhemodus
# das Netz (XCover 27.11.2026: netpolicy blocked=DOZE|APP_STANDBY, Bucket 50). Ab Gerät v247 zieht
# Rosenweg Gerät das selbst nach (Ausblenden nimmt die Ausnahme weg).
for p in ch.rosenweg4303.contacts ch.rosenweg4303.calendar; do
  if a shell pm list packages "$p" 2>/dev/null | grep -q "package:$p\$"; then
    schritt "Akku-Optimierung aus ($p: Abgleich mit der Nextcloud)" a shell dumpsys deviceidle whitelist +$p
    schritt "Standby-Bucket aktiv ($p)" a shell am set-standby-bucket $p active
  else
    echo "später   $p nicht installiert oder ausgeblendet (Katalog/Anmeldung) — Skript danach nochmals laufen lassen"
  fi
done
schritt "Zugriff auf alle Dateien (Aufräumen beim Abmelden, Hintergrund lesen)" a shell appops set $GERAET MANAGE_EXTERNAL_STORAGE allow
# Fernwartung (dauerhafter adb-Tunnel, pbx/adb-zentrale): Band "Fernwartung aktiv - Technik (Name)"
# über allen Apps, im Kiosk und über dem Sperrbildschirm von Rosenweg Gerät
schritt "Fernwartung: Band über allen Apps (Rosenweg Gerät)" a shell appops set $GERAET SYSTEM_ALERT_WINDOW allow
schritt "\"Nicht stören\" kurz ausschalten (Telefon suchen)" a shell cmd notification allow_dnd $GERAET

# Google-Einrichtung: "Einrichtung von <Telefon> abschließen" (com.google.android.setupwizard,
# Kanal suw_consolidate_notification, XCover 27.11.2026) ist eine laufende Meldung, die der
# Benachrichtigungs-Wächter nicht entfernen darf. Personalisierung als abgeschlossen markieren
# (10 = USER_SETUP_PERSONALIZATION_COMPLETE) und die Meldung einmal wegräumen.
schritt "Google-Einrichtung als abgeschlossen markiert" a shell settings put secure user_setup_personalization_state 10
if a shell dumpsys notification 2>/dev/null | grep -q "pkg=com.google.android.setupwizard"; then
  schritt "Meldung \"Einrichtung abschließen\" (Google) weggeräumt" a shell am force-stop com.google.android.setupwizard
fi

# Startseite
# Startseite
schritt "Launcher darf Widgets einbinden (Uhr auf der Startseite)" a shell appwidget grantbind --package ch.rosenweg4303.home --user 0

# Samsung: Neustart auch gesperrt möglich (Neustart meldet ab, PIN ist danach weg)
schritt "Seitentaste lang = Ausschaltmenü (1/2)" a shell settings put global function_key_config_longpress_type 0
schritt "Seitentaste lang = Ausschaltmenü (2/2)" a shell settings put global power_button_long_press 1
schritt "\"Netzwerk und Sicherheit sperren\" aus (Neustart ohne PIN)" a shell settings put secure lock_function_val 0

# XCover-Taste (nur Galaxy XCover, Stefan 28.11.2026): "Druecken" = Taschenlampe, "Bei
# Bildschirmsperre verwenden" = ein. Laesst sich nicht ueber settings setzen: Seite oeffnen,
# von Hand einstellen, bestaetigen.
if a shell getprop ro.product.model | grep -qi -E 'G715|G525|G556|XCover'; then
  a shell input keyevent 224 >/dev/null 2>&1
  a shell am start -n 'com.android.settings/.Settings$XcoverTopKeySettingsActivity' >/dev/null 2>&1 \
    || echo "        XCover-Taste: Seite nicht direkt erreichbar, in den Einstellungen nach \"XCover-Taste\" suchen"
  if [ -t 0 ]; then
    printf '        XCover-Taste: "Druecken" = Taschenlampe, "Bei Bildschirmsperre verw." = ein. Eingestellt? [j/N] '
    read -r antwort
    case "$antwort" in j|J|ja|Ja) echo "ok      XCover-Taste (von Hand)" ;; *) echo "FEHLER  XCover-Taste nicht bestaetigt"; FEHLER=$((FEHLER+1)) ;; esac
  else
    echo "HINWEIS XCover-Taste von Hand einstellen (Seite ist offen): Druecken = Taschenlampe, bei Bildschirmsperre = ein"
  fi
fi

adb_tcp
adb_selbst

# Kontrolle
echo
echo "Kontrolle:"
echo "  Device Owner:     $(a shell dpm list-owners 2>/dev/null | grep -c DeviceOwner)"
echo "  Telefon-App:      $(rolle android.app.role.DIALER)"
echo "  SIP-Konten:       $(a shell dumpsys telecom 2>/dev/null | grep -c "$SIPKONTO" | tr -d '\r') Einträge (Gerät + persönlich; Details: dumpsys telecom | grep -A3 SipdroidCallProvider)"
echo "  Browser:          $(rolle android.app.role.BROWSER)"
echo "  Seitentaste:      $(a shell settings get global function_key_config_longpress_type | tr -d '\r')/$(a shell settings get global power_button_long_press | tr -d '\r') (soll 0/1)"
echo "  Netz+Sicherheit:  $(a shell settings get secure lock_function_val | tr -d '\r') (soll 0)"
echo "  Google-Einrichtung: $(a shell settings get secure user_setup_personalization_state | tr -d '\r') (soll 10), Meldung: $(a shell dumpsys notification 2>/dev/null | grep -c "pkg=com.google.android.setupwizard" | tr -d '\r') (soll 0)"
echo "  adb über TCP:     Port $(a shell getprop service.adb.tcp.port | tr -d '\r') (soll 5555)"
# Nur bekannte Schlüssel: ohne ro.adb.secure=1 nähme adbd jeden Rechner an (Userbuild: 1)
SICHER=$(a shell getprop ro.adb.secure | tr -d '\r')
echo "  adb nur mit Schlüssel: ro.adb.secure=$SICHER (soll 1)"
[ "$SICHER" = 1 ] || { echo "FEHLER  ro.adb.secure ist nicht 1 - dieses Telefon nicht für die Fernwartung verwenden"; FEHLER=$((FEHLER+1)); }
echo "  Find My Mobile:   $(a shell dumpsys package com.samsung.android.fmm 2>/dev/null | grep -o 'hidden=[a-z]*' | head -1 | tr -d '\r') (soll hidden=true; telefon_ausblenden)"
echo "  Band (Overlay):   $(a shell appops get $GERAET SYSTEM_ALERT_WINDOW | tr -d '\r') (soll allow)"
echo "  Fernwartung:      $(a shell dumpsys activity services $GERAET/org.sipdroid.sipua.rosenweg.FernwartungDienst 2>/dev/null | grep -c ServiceRecord | tr -d '\r') Dienst (1 = Tunnel läuft; Stand auf /smartphones)"
[ $FEHLER = 0 ] && echo "Fertig, alle Schritte ok." || { echo "$FEHLER Schritt(e) fehlgeschlagen."; exit 1; }
