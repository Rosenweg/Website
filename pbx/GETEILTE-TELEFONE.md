# Geteilte Rosenweg-Telefone — Systemgrenzen

Stand: 24.11.2026, gemessen am Galaxy A15 („Rosenweg Smartphone 2“, Android 16,
One UI, ohne SIM). Gilt sinngemäss für jedes Samsung-Telefon mit Stock-Firmware.

Diese Liste sammelt, was Android oder Samsung **nicht** zulässt, und wie die
Rosenweg-Apps damit umgehen. Vor Änderungen an Ausblendliste, Launcher oder
Telefon-App hier nachlesen.

## Grundregel für alle Rosenweg-Apps

**Daten liegen im Rosenweg-System, das Telefon hält nur Zwischenspeicher.**

1. Gespeichert wird in der Nextcloud der Person bzw. auf der Anlage — lokal nur,
   was für Offline-Betrieb und Tempo nötig ist.
2. Hochladen sofort, nicht erst beim Abmelden; lokale Kopien danach entfernen.
3. Beim Abmelden jeden Zwischenspeicher löschen — erst nach bestätigtem Hochladen.
4. Dieselben Daten auf jedem Rosenweg-Telefon und auf privaten Handys.
5. **Keine App setzt eine andere voraus** — vor allem nicht Rosenweg Files. Jede
   App lädt selbst in die Nextcloud der Person hoch (gemeinsame Bibliothek im
   Commons-Fork, eigene Warteschlange). Rosenweg Konto wird genutzt, wenn es
   installiert ist; sonst meldet sich die App selbst an (Nextcloud-Login-Flow).
6. **Die App zeigt ihre Daten aus der Nextcloud**, nicht nur das Lokale: Was
   hochgeladen und lokal gelöscht ist, bleibt in der App sichtbar und nutzbar
   (Liste aus `Persönlich/<App>`, Abspielen/Öffnen per Stream). Lokal noch nicht
   Hochgeladenes erscheint daneben. Ohne Netz oder Anmeldung: nur das Lokale.
7. **Die Einstellungen der App gehören der Person** und liegen in ihrer Nextcloud
   (`Persönlich/.rosenweg/<paket>.json`). Beim Start und nach dem Anmelden
   abgleichen, Änderungen sofort hochladen, die zuletzt geänderte Fassung gilt.
   Gerätebezogenes (Widgets, Pfade, Zähler, „zuletzt …“) bleibt auf dem Gerät.

Umsetzung: Bibliothek `ch.rosenweg4303:cloud` (commons-rosenweg/cloud) — `Hochladen`,
`Ablage`, `Einstellungen`, `Hinweis` (einmal beim ersten Start, ablehnbar),
`AnmeldenActivity`. Ziel jeder App: `Persönlich/<App>/<yyyy-MM>/` (Persönlich =
AD-Home). Vorbild: Diktiergerät v31.

| App | im Rosenweg-System | auf dem Telefon nur |
|---|---|---|
| Kamera / Galerie | Nextcloud, sofort hochgeladen | bis zum Hochladen |
| Dateien | Nextcloud | geöffnete Dateien |
| Notizen | Textdateien in der Nextcloud | nichts dauerhaft |
| Diktiergerät, Paint | Nextcloud, von der App selbst hochgeladen | bis zum Hochladen |
| Kalender | CalDAV (Nextcloud) | abgeglichene Kopie |
| Kontakte | Rosenweg-Verzeichnis | abgeglichene Kopie |
| Messenger | Message-Store der Anlage | Zwischenspeicher |
| Einstellungen, Launcher-Anordnung | Nextcloud der Person | aktuelle Einstellungen |
| Anrufliste | Anruf-Log der Anlage | Android-Anrufliste, beim Abmelden geleert |

Stand 24.11.2026: Das Diktiergerät erfüllt 1–7 (v31), Rosenweg Files ist die
Dateiansicht der Nextcloud (v28). Bei Kamera, Galerie, Notizen und Paint fehlt das
Hochladen noch. Bis dahin bleiben Fotos und Videos beim Abmelden auf dem Gerät.
Downloads, Dokumente und Musik werden geleert.

## Was Android oder Samsung nicht erlaubt

| # | Grenze | Grund | Lösung im Rosenweg-System |
|---|---|---|---|
| 1 | **Notrufe** zeigen immer die System-Telefon-App, nie Rosenweg Phone | Telecom koppelt bei Notrufen die Standard-Telefon-App ab (`InCallController`, `EmergencyInCallServiceConnection.takeControl()`) | Samsung-Telefon (`com.samsung.android.dialer`) bleibt installiert, steht auf „nur unsichtbar“ |
| 2 | **„Foto/Video aufnehmen“** aus anderen Apps geht nur an die System-Kamera | Android 11+: `IMAGE_CAPTURE`/`VIDEO_CAPTURE` nur für vorinstallierte Kameras | Samsung-Kamera (`com.sec.android.app.camera`) bleibt installiert, „nur unsichtbar“ |
| 3 | **„Keine SIM · Nur Notrufe“** und Netzbetreiber-Name nicht änderbar | Text kommt aus dem Modem | Mobilfunk-Symbol ausgeblendet (`icon_blacklist`); Gerät und Person stehen auf dem Sperrbildschirm |
| 4 | **Notrufe laufen nie über SIP** | 112 & Co. gehen immer übers Modem | Modem bleibt an, kein Flugmodus |
| 5 | **WebView** bleibt die von Google | Austausch nur mit Root/eigenem Betriebssystem | geschützt, nie ausgeblendet |
| 6 | **Nur ein Android-Benutzer** | Samsung-Telefone: `pm get-max-users` = 1 | Anmeldung pro Person, App-Daten beim Abmelden löschen; Einstellungen künftig über die Nextcloud der Person |
| 7 | **Bildschirmsperre pro Person** nur als PIN/Passwort, kein Muster, keine Biometrie | `resetPasswordWithToken` kennt nur PIN/Passwort; Biometrie gilt fürs ganze Gerät | persönliche PIN (24.11.2026): liegt verschlüsselt auf der Anlage (`/api/telefon/pin`, Fernet mit `PBX_PIN_KEY`), die Geräte-App setzt sie nach der Anmeldung per `resetPasswordWithToken` und entfernt sie beim Abmelden und direkt nach einem Neustart (`BootEntsperren`, vor dem ersten Entsperren) |
| 8 | **Device Owner** nur auf Gerät ohne Konten, Entfernen nur per Werksreset | Android-Sicherheitsregel | einmalig beim Einrichten; Updates nur mit dem Rosenweg-Release-Schlüssel |
| 9 | **Installationsverbot gilt auch für den Device Owner** | `DISALLOW_INSTALL_APPS` | Geräte-App hebt es für eigene Katalog-Installationen kurz auf; Wartung per adb (`ADB_INSTALLATION`) |
| 10 | **Chrome-Updates** nur über den Play Store | Play Store ist ausgeblendet und gesperrt | Chrome bleibt (Cromite verworfen, Stefan 24.11.2026); seine Daten löscht die Geräte-App beim Abmelden (Verlauf, Cookies, Anmeldungen) |
| 11 | **Root** löst Samsung Knox dauerhaft aus | eFuse | kein Root |

## Was der Device Owner nicht selbst darf (heute einmalig per adb)

**Alles auf einmal:** `scripts/geteiltes-telefon-einrichten.sh <adb-seriennummer> [--device-owner]`
führt jeden Schritt unten aus, prüft ihn und zeigt am Schluss eine Kontrolle. Es darf beliebig
oft laufen (nach Updates, nach dem Nachinstallieren von Rosenweg Telefon). Neue einmalige
Schritte gehören **immer** in die Tabelle **und** ins Skript.

**Ohne Kabel (WLAN):** Auf dem Telefon Entwickleroptionen einschalten (7× auf die Build-Nummer),
dann *Entwickleroptionen → Drahtloses Debugging → Mit Kopplungscode koppeln*. Vom Mac aus:

    adb pair <ip>:<kopplungsport> <code>
    adb connect <ip>:<port>          # Port aus "Drahtloses Debugging", nicht der Kopplungsport
    scripts/geteiltes-telefon-einrichten.sh <ip>:<port> [--device-owner]

Danach Drahtloses Debugging wieder ausschalten. **Später geplant (Entscheid Stefan 24.11.):**
zentral über das Rosenweg-System — im pbx-Admin IP und Kopplungscode eingeben, ein Dienst im Netz
koppelt per WLAN und führt dieses Skript aus. Einrichtung ganz ohne Mac.

Wichtig für die geplante Einrichtung per QR ohne Kabel.

| Was | Befehl heute | Offen für QR-Einrichtung |
|---|---|---|
| **Zuerst:** Nebenstelle und SIP-Passwort an Rosenweg Gerät geben (ohne sie: Sperrbildschirm „Dieses Telefon ist noch nicht eingerichtet.“, der Katalog installiert nichts). Als Device Owner ist die SIP-Einstellungsseite nicht erreichbar, der Import von `androidsip-<ext>.xml` geht also nur vorher. | `scripts/geteiltes-telefon-einrichten.sh <serie> --nebenstelle 21xx` (ab Gerät v246): holt das Passwort aus `sip_extensions` auf CT 220 und gibt es per Pipe an `read -r pw; am broadcast -a ch.rosenweg4303.telefon.ADB_ZUGANG --es ext 21xx --es pw "$pw" -n ch.rosenweg4303.telefon/org.sipdroid.sipua.rosenweg.AdbFreigabe`. Vorher in pbx-admin die Nebenstelle auf Kontext „geteilt“ stellen, Name „Rosenweg Smartphone N“. | offen: Zugang beim QR-Einrichten mitgeben |
| SIP-Anrufkonten aktivieren (zwei: Nebenstelle des Geräts und persönliches Konto) | `adb shell telecom set-phone-account-enabled ch.rosenweg4303.telefon/org.sipdroid.sipua.ui.SipConnectionService SipdroidCallProvider 0` und ab Rosenweg Telefon v27 `adb shell telecom set-phone-account-enabled ch.rosenweg4303.phone/org.sipdroid.sipua.ui.SipConnectionService SipdroidCallProvider 0` (das Konto gibt es erst, wenn Rosenweg Telefon einmal lief; das Skript startet es dafür kurz) | bleibt: Android schaltet Anrufkonten fremder Apps nie selbst ein. Die Freigabe überlebt An- und Abmelden (das Konto wird nur offline geschaltet, nie ausgetragen) |
| Akku-Optimierung für Rosenweg Telefon ausnehmen (persönliches SIP-Konto bleibt im Ruhemodus registriert) | `adb shell dumpsys deviceidle whitelist +ch.rosenweg4303.phone` | dito; geht beim Ausblenden/Daten-Löschen verloren → Rosenweg Telefon im Katalog auf „immer“ |
| Standard-Telefon-App | `adb shell cmd role add-role-holder android.app.role.DIALER ch.rosenweg4303.phone 0` | Knox oder Rückfrage beim Einrichten prüfen |
| Standard-Browser | `adb shell cmd role add-role-holder android.app.role.BROWSER <paket> 0` | dito |
| Akku-Optimierung ausnehmen | `adb shell dumpsys deviceidle whitelist +ch.rosenweg4303.telefon` | dito |
| Akku-Optimierung für Rosenweg Messenger ausnehmen (MQTT bleibt im Ruhemodus offen, Notfälle kommen an) | `adb shell dumpsys deviceidle whitelist +ch.rosenweg4303.messages` | dito |
| Rosenweg Telefon darf eingehende Anrufe als Vollbild über dem Sperrbildschirm zeigen (sonst nur ein Symbol, nicht annehmbar; Rosenweg Telefon warnt dauerhaft, solange es fehlt, und zeigt auf geteilten Telefonen Anrufe immer im Vollbild) | `adb shell appops set ch.rosenweg4303.phone USE_FULL_SCREEN_INTENT allow` (ab Android 14; bis Android 13 wird die Berechtigung mit der Installation erteilt, das Skript prüft sie nur) | dito |
| Rosenweg Gerät bestätigt „Debugging über WLAN zulassen“ selbst – nur im WLAN „Rosenweg“ und nur, wenn die Anlage das Debugging zentral eingeschaltet hat (in anderen WLANs bestätigt ein Mensch von Hand) | `adb shell settings put secure enabled_accessibility_services ch.rosenweg4303.telefon/org.sipdroid.sipua.rosenweg.WlanBestaetiger` und `adb shell settings put secure accessibility_enabled 1` | dito |
| Samsung-Aufforderung „Beenden der Galaxy-Einrichtung“ verschwindet (kommt aus den Einstellungen, dort nicht abschaltbar; Samsung Account lässt sich nicht deaktivieren) – Rosenweg Gerät entfernt genau diese Meldungen | `adb shell cmd notification allow_listener ch.rosenweg4303.telefon/org.sipdroid.sipua.rosenweg.Benachrichtigungen` | dito |
| Messenger darf „Nicht stören“ für den Notfall-Alarm kurz ausschalten | `adb shell cmd notification allow_dnd ch.rosenweg4303.messages` | dito |
| Rotes Notfall-Fenster über dem Sperrbildschirm (Android 14 erteilt es nicht von selbst) | `adb shell appops set ch.rosenweg4303.messages USE_FULL_SCREEN_INTENT allow` (ab Android 14, wie oben) | dito |
| Exakte Wecker: Notfall-Erinnerung alle 2 min bis gelesen, auch im Tiefschlaf | `adb shell appops set ch.rosenweg4303.messages SCHEDULE_EXACT_ALARM allow` | dito |
| Zugriff auf alle Dateien (Aufräumen beim Abmelden) | `adb shell appops set ch.rosenweg4303.telefon MANAGE_EXTERNAL_STORAGE allow` | dito |
| Fernwartung: Band „Fernwartung aktiv – Technik (Name)“ über allen Apps, im Kiosk und auf dem Sperrbild von Rosenweg Gerät | `adb shell appops set ch.rosenweg4303.telefon SYSTEM_ALERT_WINDOW allow` | dito; ohne: nur die Benachrichtigung „Fernwartung aktiv“, kein Band |
| Geräte-App darf „Nicht stören“ kurz ausschalten (Telefon suchen: klingelt auch bei Nicht stören) | `adb shell cmd notification allow_dnd ch.rosenweg4303.telefon` | dito; ohne: Suchanruf klingelt nur bei stumm/vibrieren, nicht bei „Nicht stören“ |
| Rosenweg Launcher darf Widgets ohne Rückfrage einbinden (Uhr-Widget auf der Startseite, die sich nicht bearbeiten lässt) | `adb shell appwidget grantbind --package ch.rosenweg4303.home --user 0` | dito; ohne: Android fragt einmal nach |
| Seitentaste lang = Ausschaltmenü statt KI-Assistent (Neustart auch im gesperrten Zustand: wer vergisst, sich abzumelden, wird durch den Neustart abgemeldet, die PIN ist weg) | `adb shell settings put global function_key_config_longpress_type 0` und `adb shell settings put global power_button_long_press 1` (Samsung prüft beide; 103 = digitaler Assistent), dazu `adb shell settings put secure lock_function_val 0` (Samsung „Netzwerk und Sicherheit sperren“ aus — sonst verlangt das Ausschaltmenü vor dem Neustart die PIN; getestet 24.11.2026) | dito; Notlösung ohne Menü: Leiser + Seitentaste ~7 s (erzwungener Neustart) |

**Achtung — Ausblenden setzt diese Rechte zurück** (gefunden 24.11.2026): Android behandelt eine
ausgeblendete App (`setApplicationHidden`) wie deinstalliert und vergisst dabei App-Ops
(`USE_FULL_SCREEN_INTENT`, `SCHEDULE_EXACT_ALARM`), den „Nicht stören“-Zugriff und die
Akku-Ausnahme; `clearApplicationUserData` ebenso. Apps, die solche adb-Rechte brauchen, stehen
darum im Katalog auf **„immer“** (bleiben sichtbar) und löschen die Daten der Person selbst
(siehe „Rosenweg Messenger auf geteilten Telefonen“).

Samsung Knox (kostenlose Knox-Platform-Schnittstelle) kann einige dieser
Punkte vermutlich lösen — vor dem Bau der QR-Einrichtung prüfen.

## Listen auf der Anlage

Im pbx-Admin unter „Geteilte Telefone“:

- **Immer ausblenden** (`telefon_ausblenden`): System-Apps werden ausgeblendet,
  nachinstallierte Beigaben deinstalliert. Geschützt sind immer: WebView,
  Telefonie, Anruf-Oberfläche, Notruf, aktive Tastatur, Startbildschirm,
  Einstellungen.
- **Nur unsichtbar** (`telefon_unsichtbar`): bleibt installiert und
  funktionsfähig, der Rosenweg Launcher zeigt es nicht. Für alles aus Punkt 1
  und 2 oben.

## Wartung per USB

Nur die adb-Shell darf das (geschützt durch die Systemberechtigung `DUMP`):

```
# Katalog, Ausblendlisten, Telefonbuch sofort abgleichen (statt Neustart)
adb shell am broadcast -a ch.rosenweg4303.telefon.ADB_ABGLEICH \
    -n ch.rosenweg4303.telefon/org.sipdroid.sipua.rosenweg.AdbFreigabe

# Installationsverbot 10 Minuten aufheben, z.B. für adb install -r
adb shell am broadcast -a ch.rosenweg4303.telefon.ADB_INSTALLATION \
    -n ch.rosenweg4303.telefon/org.sipdroid.sipua.rosenweg.AdbFreigabe

# ab Gerät v246: erstes Einrichten, Nebenstelle + SIP-Passwort (Passwort nur über stdin,
# am einfachsten mit dem Skript: --nebenstelle 21xx)
<passwort> | adb shell 'read -r pw; am broadcast -a ch.rosenweg4303.telefon.ADB_ZUGANG \
    --es ext 21xx --es pw "$pw" -n ch.rosenweg4303.telefon/org.sipdroid.sipua.rosenweg.AdbFreigabe'

# ab Gerät v237: Installationsverbot sofort wieder setzen (nach adb install)
adb shell am broadcast -a ch.rosenweg4303.telefon.ADB_INSTALLATION_ENDE \
    -n ch.rosenweg4303.telefon/org.sipdroid.sipua.rosenweg.AdbFreigabe
```

Geräte nicht per `adb reboot` neu starten, solange jemand daran arbeitet.

## Nextcloud-Zugang der angemeldeten Person (24.11.2026)

Die Rosenweg-Apps (cloud-Bibliothek ab 0.5.0) melden sich auf geteilten Telefonen nicht
mehr selbst an. Beim Anmelden am Telefon lässt die Anlage für die Person ein
Nextcloud-App-Passwort ausstellen und gibt es nur an dieses Gerät:

- **CT 104** `nc-token` (`nextcloud/nc-token/`, systemd `nc-token`, Port 8097 auf 100.64.2.36):
  `occ user:auth-tokens:add -n` (ohne Login-Passwort) bzw. `…:delete`. Nimmt nur Anfragen
  von CT 220 (100.64.2.55) mit `X-NC-Token-Secret` an; Geheimnis in `/etc/default/nc-token`
  und `/etc/default/pbx-api` (`NC_TOKEN_SECRET`, `NC_TOKEN_URL`). Zuordnung E-Mail → Nextcloud-Benutzer
  über die E-Mail im Nextcloud-Konto.
- **Anlage** `GET /api/telefon/nextcloud` (Nebenstelle der Person): stellt aus, speichert verschlüsselt
  (`telefon_nextcloud`, `PBX_PIN_KEY`), widerruft beim Abmelden (`_telefon_abmelden`).
  In der Nextcloud heisst das App-Passwort „Rosenweg Geraet <Nebenstelle>“.
- **Geräte-App** v172: `AnlageProvider.call("nextcloud_konto")`, nur im Speicher.
- **cloud 0.5.0**: `KontoSpeicher.laden()` nimmt zuerst den Zugang von Rosenweg Gerät; Abmelden
  einzelner Apps ist dann ausgeblendet. Ohne Geräte-App (privates Handy) wie bisher Login-Flow.

## Anmeldung per NFC-Karte (24.11.2026)

Statt des Anmelde-QR genügt die eigene Rosenweg-Karte (UniFi Access, dieselbe wie für
die Türen): hinten ans gesperrte Telefon halten. **Die Karte allein meldet an, ohne PIN**
(Entscheid Stefan). Es gelten nur Karten, die in UniFi Access einer Person **zugeordnet**
sind (`status = assigned`), deren Konto für geteilte Telefone freigeschaltet ist
(`telefon_gruppen`, wie beim QR). Entzogene oder unbekannte Karten melden nicht an.

- **Rosenweg Gerät** ab v186: Der Sperrbildschirm liest Karten im Reader-Modus
  (NFC-A/B/F/V, ohne NDEF-Prüfung). Ist eine andere Activity vorne (Anmeldefenster),
  nimmt `NfcKarte` (TECH_DISCOVERED) die Karte an. Ist schon jemand angemeldet,
  wird die Karte ignoriert. Meldungen: „Karte nicht bekannt“, „Karte gesperrt“,
  „Keine Verbindung zur Anlage“.
- Gelesen wird nur die UID (`Tag.getId()` als Hex, z.B. `04D4C227C22A81`); sie ist in
  Access die `nfc_id` der Karte. Verglichen wird ohne Gross-/Kleinschreibung und ohne
  Trennzeichen.
- Die Anlage fragt bei **jeder** Anmeldung live nach (Haupt-API → UniFi Access), es gibt
  keinen eigenen Rechte-Speicher. Die Haupt-API hält nur die Kartenliste bis 30 s im
  Speicher, um zur UID das Token zu finden; Status und Inhaber liest sie jedes Mal frisch
  über `/credentials/nfc_cards/tokens/{token}`.
- Fehlversuche: höchstens 10 pro Nebenstelle und Minute, danach 429.
- Protokoll: `telefon_log` mit `durch = karte:<Inventarnummer>`; Abweisungen als
  `karte-abgelehnt` (`karte:<nr>:unbekannt|gesperrt|nicht_freigeschaltet`).

**Stolpersteine aus dem ersten Einsatz (24.11.2026):**
- **Läuft eine Kamera, erkennt das A15 keine NFC-Karten** (Antenne neben der Kamera; auch die
  vordere blockiert). Der Sperrbildschirm zeigt darum „Rosenweg-Karte hinten ans Telefon halten“;
  die Kamera für den Anmelde-QR startet erst mit „QR-Code scannen“ (hintere Kamera, nach 60 s
  wieder aus). Rosenweg Gerät ab v189.
- Die System-Tag-App `com.android.apps.tag` steht in `telefon_ausblenden`, sonst fragt Android bei
  jeder Karte, welche App sie bekommen soll.
- **E-Mail-Adresse:** Die Anlage findet die Person über die E-Mail des Access-Benutzers. Bewohner
  kommen per LDAP aus dem Rosenweg-Verzeichnis nach UniFi, ihre Adresse passt von selbst. Lokale
  UniFi-Konten (z.B. das an das UI-Konto gebundene mit Gmail, `r9admin`) brauchen eine
  **Verknüpfung** in der Website-Tabelle `person_email_alias` (Zusatzadresse → Hauptadresse des
  Rosenweg-Kontos; `GET/POST/DELETE /api/admin/email-alias`, nur Technik/Präsident). Ohne sie
  meldet die Anlage „Dein Konto ist für geteilte Telefone nicht freigeschaltet“.
- `telefon_gruppen` = `technik,präsident,praesident,bewohner` (Bewohner freigeschaltet 24.11.2026).

**Sicherheitshinweis:** Die UID ist nicht geheim und lässt sich mit jedem NFC-Telefon
auslesen und auf eine beschreibbare Karte kopieren. Wer eine Karte verliert, meldet das
sofort — die Karte wird in **Rosenweg Karten** (oder in UniFi Access) entzogen und gilt
dann weder an den Türen noch an den Telefonen.

### Kartenverwaltung: App „Rosenweg Karten“

Eigene App `ch.rosenweg4303.karten` (Repo `~/Documents/rosenweg-karten`), nur für
Technik/Präsident. Karte antippen zeigt Inhaber, Inventarnummer und Status; dazu
„Einer Person zuordnen“ (durchsuchbare Liste) und „Entziehen“ (mit Rückfrage).

- **Ohne INTERNET-Berechtigung und ohne Zugangsdaten**: alles läuft über den
  `AnlageProvider` von Rosenweg Gerät (`ContentResolver.call`, Permission
  `ch.rosenweg4303.permission.ANLAGE`, darum mit demselben Schlüssel signiert):
  `karten_info(uid)`, `karten_zuordnen(uid, {email})`, `karten_entziehen(uid)`,
  `karten_personen("personen")` → Bundle `json` (Antwort der Anlage) oder `fehler`
  (+ `status`); `nicht_berechtigt = true`, wenn die angemeldete Person nicht Technik/
  Präsident ist. Rosenweg Gerät prüft das live über `/api/telefon/status`, die Anlage
  prüft nochmals an der Sitzung der Nebenstelle.
- Katalog: als Android-App mit Gruppen `technik,präsident,praesident`.
- Zuordnen: Kennt Access die Karte noch nicht, legt die Haupt-API sie als Fremdkarte an
  (`POST /credentials/nfc_cards/import`, CSV im Feld `file`) und ordnet sie dann dem
  Access-Benutzer mit dieser E-Mail zu. Hat die Person keinen Access-Benutzer, kommt eine
  Fehlermeldung (Benutzer zuerst in UniFi Access anlegen). Gehört die Karte schon jemand
  anderem: Fehler mit Namen, zuerst entziehen. Fremdkarten müssen in Access erlaubt sein
  (Einstellungen › Card Inventory › Third-Party NFC Cards).
- Entziehen löst nur die Zuordnung; die Karte bleibt in der Access-Inventur.
- Türleser übernehmen Änderungen nach etwa 30 s.
- Jede Änderung steht in der Haupt-DB (`access_karten_protokoll`: Aktion, Karte, Ziel,
  durch „Telefon <Nebenstelle> (Name <E-Mail>)“) und in `telefon_log`
  (`karte-info`, `karte-zu`, `karte-weg`).

### Endpunkte

Anlage (pbx-api, HTTP-Basic Nebenstelle:SIP-Passwort, nur Nebenstellen „geteilt“):

| Methode | Pfad | Körper | Antwort |
|---|---|---|---|
| POST | `/api/telefon/karte` | `{uid}` | wie `/api/telefon/einloesen`: `{ok, ext, angemeldet, name, email, seit, apps}`; Fehler `{error, grund}` mit 400 `unlesbar`, 404 `unbekannt`, 403 `gesperrt`/`nicht_freigeschaltet`, 429 `gebremst`, 502 `verbindung` |
| POST | `/api/telefon/karten/info` | `{uid}` | `{found, assigned, status, display_id, access_name, person:{name,email}, uid}` |
| POST | `/api/telefon/karten/zuordnen` | `{uid, email}` | `{ok, importiert?, schon?, display_id, name}`; 404 ohne Access-Benutzer, 409 `{error, besitzer:{name}}` |
| POST | `/api/telefon/karten/entziehen` | `{uid}` | `{ok, schon?, display_id, name}`; 404 Karte unbekannt |
| POST | `/api/telefon/karten/loeschen` | `{uid}` | `{ok, display_id}`; nur entzogene Karten (sonst 409), löscht aus dem Access-Bestand |
| GET | `/api/telefon/karten/personen` | – | `{personen:[{name,email}]}` aus `personen_nummern` (Personen-Abgleich), nach Name |

`/api/telefon/karten/*` nur, wenn die Sitzung der Nebenstelle die Gruppe technik,
präsident oder praesident hat (sonst 403 `{error: "nicht berechtigt"}`).

Haupt-API (`X-PBX-Secret`, nur von der Anlage):

| Methode | Pfad | Körper | Antwort |
|---|---|---|---|
| GET | `/api/pbx/karte/:nfcId` | – | `{found:false}` oder `{found, assigned, status, display_id, access_name, person:{user_id, email, name, groups}}` |
| POST | `/api/pbx/karte/zuordnen` | `{nfc_id, email, durch}` | siehe oben |
| POST | `/api/pbx/karte/entziehen` | `{nfc_id, durch}` | siehe oben; Access: `PUT /users/{id}/nfc_cards/delete {token}` |
| POST | `/api/pbx/karte/loeschen` | `{nfc_id, durch}` | Access: `DELETE /credentials/nfc_cards/tokens/{token}`; nur ohne Inhaber |

Person zur Karte: Access-Benutzer → E-Mail → Website-Benutzer (`users`, Website-ID);
Gruppen live aus Authentik, sonst `users.groups_json` (wie `/api/auth/me`).

## Rosenweg Messenger auf geteilten Telefonen (24.11.2026)

- **Katalog „immer“:** Der Messenger bleibt sichtbar, auch wenn niemand angemeldet ist (der
  Sperrbildschirm im Kiosk-Modus lässt ohnehin nicht an die Apps). Grund: Ausblenden setzt die
  Notfall-Rechte zurück (siehe oben).
- **Anmelden:** Rosenweg Gerät schickt `ch.rosenweg4303.ANGEMELDET` mit
  `FLAG_INCLUDE_STOPPED_PACKAGES` (nach dem Löschen sind Apps „gestoppt“ und bekämen den Broadcast
  sonst nicht). Der Messenger (`RosenwegAnmeldungReceiver`) startet seine Verbindung sofort —
  Nachrichten und Notfälle kommen an, ohne dass jemand die App öffnet. Ab Messenger v43,
  Rosenweg Gerät v191.
- **Abmelden:** Statt `clearApplicationUserData` (das auch die Sonderrechte löscht) schickt Rosenweg
  Gerät `ch.rosenweg4303.ABGEMELDET`; der Messenger löscht selbst alle Daten der Person (Datenbanken,
  Einstellungen, Dateien, Geräteschlüssel, Benachrichtigungen) und bestätigt über
  `content://ch.rosenweg4303.messages.rosenweg.loeschen` → `call("gewischt")` = `{ok, zeit}`.
  Kommt innert 10 s keine Bestätigung, löscht Rosenweg Gerät wie früher komplett (Datenschutz vor
  Komfort). Liste der Apps, die selbst löschen: `Katalog.LOESCHT_SELBST`. Ab Messenger v44,
  Rosenweg Gerät v194. Getestet: Daten weg (≈200 ms), alle Rechte bleiben.
- **Nach dem Anmelden** holt der Messenger den Verlauf der Person neu vom Server. Ältere
  Direktnachrichten zeigen „🔒 Vor der Anmeldung an diesem Gerät verschlüsselt“ (neuer
  Geräteschlüssel); andere Geräte der Person können sie nachliefern.
- **Geräteschlüssel:** feste Geräte-ID pro Telefon und Person, nach jeder Anmeldung ein neuer
  Schlüssel. Der message-store behält pro Gerät nur den neuesten (`POST /api/devices`), sonst
  verschlüsseln Absender mit dem alten.
- **Notfall** (Kanal `notfall` oder `priority: emergency`): rotes Vollbild über allem, Sirene über
  den Wecker-Kanal (auch bei stumm und „Nicht stören“), je Alarm 30 s, Wiederholung alle 2 min bis
  „Verstanden“ (= Lesebestätigung), höchstens 60 min. Schreiben dürfen im Kanal Notfall nur Technik
  und Präsident, in Ankündigungen zusätzlich der Ausschuss.

## Anzeige in Rosenweg Gerät

Angemeldet steht dort „Interne Telefonnummer: <persönliche Nummer>“ (mit ihr ruft die Person intern
an; `nummer` aus `/api/telefon/status`) und „Gerät: Nebenstelle 21xx“ (Adresse des Geräts für Telefon
suchen, Fern-Abmelden, Einrichtung). Extern geht die Nummer des Anlagen-Anschlusses raus.

## Persönliches SIP-Konto in Rosenweg Telefon (25.11.2026)

Entscheid Stefan: **zwei SIP-Konten pro geteiltem Telefon.**

| | Rosenweg Gerät (`ch.rosenweg4303.telefon`) | Rosenweg Telefon (`ch.rosenweg4303.phone`, ab v27) |
|---|---|---|
| registriert | Nebenstelle des Geräts (2102 …), immer, auch gesperrt | persönlichen Zugang `<nummer>-<gerät>` (z.B. `310201-2102`), nur während einer Sitzung |
| wofür | Telefon suchen (2099, laut), gesperrt nur Notrufe, Fallback | Anrufe an die persönliche Nummer, gehende Anrufe der Person |
| Kontext | `[geteilt]` | `[person]` |
| Anrufkonto | „Rosenweg“ | „Rosenweg persönlich“ |

Beide nutzen denselben Sipdroid-Kern (in Rosenweg Telefon als Gradle-Modul `:sipdroid`, Pakete
`org.sipdroid.*` unverändert; die Hinweise nach ADDITIONAL_TERMS stehen im Menü unter „Über
Android SIP / Sipdroid“).

**Anlage (pbx-api):** Beim Anmelden (`/api/telefon/einloesen`, `/api/telefon/karte`) legt die
Anlage in `telefon_sip_person` einen Zugang pro (Gerät, Person) mit Zufallspasswort an und schreibt
in `pjsip_phones.conf` endpoint/auth/aor `<nummer>-<gerät>` (Caller-ID „Name <nummer>“,
`max_contacts=1`, Kontext `[person]`). `_telefon_abmelden` löscht ihn, `pjsip reload` folgt sofort;
der stündliche Lauf entfernt Zugänge ohne passende Sitzung. Bewusst **ein Endpunkt pro Sitzung**
statt eines Endpunkts pro Nummer mit mehreren `auth=`: so ist mit dem Abmelden auch die
Registrierung des Geräts weg (beim gemeinsamen Endpunkt blieben die Contacts bis zum Ablauf
stehen, das abgemeldete Telefon klingelte weiter für die Person). Mehrere Geräte einer Person =
mehrere Zugänge, gewählt werden alle.

**Wählen:** `3HHWWP` → `pbx_person.py` → je Gerät mit Sitzung `PJSIP/<nummer>-<gerät>`, wenn der
Zugang registriert ist (`pjsip show contacts`), sonst wie bisher `PJSIP/<gerät>` (alte Telefon-App,
kein Netz). Gehend aus `[person]`: intern mit der persönlichen Nummer, extern die Nummer des Trunks.

**Übergabe:** `GET /api/telefon/sip-person` (Geräte-Zugang) → `AnlageProvider.call("sip_person")`
(nur Rosenweg-Signatur) → Rosenweg Telefon. Server/Port/Transport nimmt die Geräte-App aus ihren
eigenen SIP-Einstellungen (dieselbe Anlage). Die Geräte-App meldet jeden Wechsel mit dem Broadcast
`ch.rosenweg4303.SIP_PERSON_GEAENDERT` (Permission ANLAGE); beim Abmelden vergisst Rosenweg
Telefon den Zugang (auch auf `ch.rosenweg4303.ABGEMELDET`). Ohne Zugang registriert es nicht.
Ohne Rosenweg Gerät (privates Handy) gibt es im Menü „SIP-Konto (privates Telefon)“.

**Gehende Anrufe:** Rosenweg Telefon nimmt das persönliche Konto, sobald es registriert ist —
außer bei Notrufen (die gehen immer über das Modem). Abgemeldet bleibt nur das Konto des Geräts.

**Update-Reihenfolge (beide sicher):** Anlage zuerst (neue Tabelle, Kontext `[person]`, neuer
Endpunkt; ohne neue Apps ändert sich nichts, `pbx_person.py` fällt auf die Nebenstelle zurück).
Dann Apps in beliebiger Reihenfolge: neue Telefon-App mit alter Geräte-App bekommt keinen Zugang
(alte Geräte-App kennt `sip_person` nicht) und registriert nicht; neue Geräte-App mit alter
Telefon-App: der Zugang entsteht, wird aber nicht registriert → Fallback auf die Nebenstelle.
Laufende Sitzungen von vor dem Update bekommen ihren Zugang beim ersten Abruf.

**Rosenweg Telefon im Katalog auf „immer“:** sonst wird es beim Abmelden ausgeblendet und seine
Daten gelöscht — die Akku-Ausnahme und die Freigabe des Anrufkontos gingen verloren.

### Wartung per adb über das Netz (ab Rosenweg Gerät v217)

- **Klassisches adb auf Port 5555** statt „Debugging über WLAN“. Grund: Android merkt sich vertraute WLANs pro Zugangspunkt-Kennung (BSSID) und schaltet „Debugging über WLAN“ bei jedem neuen Zugangspunkt ab (schon beim Wechsel 2,4 → 5 GHz am selben Gerät). Die nötige Bestätigung fragt es bei gesperrtem Bildschirm gar nicht erst (`startConfirmationForNetwork: isLockScreenMode`).
- Einmal per USB: `adb tcpip 5555` (macht `geteiltes-telefon-einrichten.sh`). Nach einem Neustart des Telefons ist der Port zuerst weg; Gerät stellt ihn selbst wieder her (siehe unten, C). Nur wenn das nicht geht: `scripts/geteiltes-telefon-einrichten.sh <seriennummer> --nur-adb` per USB.
- /smartphones „🛠 1 Std.“ / „aus“ schaltet zentral nur adb selbst (Gerät setzt `ADB_ENABLED` als Device Owner, Weckanruf 2098). Aus = kein adbd, auch nicht per USB. Geht bei gesperrtem Bildschirm, ohne Rückfrage; getestet: aus in 2 s, an in 3 s.
- Verbinden darf nur ein Rechner, dessen Schlüssel das Telefon kennt.
- Gerät meldet Adresse und Port (`POST /api/telefon/adb`); /smartphones zeigt `adb connect <adresse>:5555`. Ist Port 5555 nicht offen (nach Neustart), sucht Gerät ersatzweise ein von Hand eingeschaltetes „Debugging über WLAN“ per mDNS.
- Schaltet etwas adb ab, solange es zentral an ist, stellt Gerät es sofort wieder her; zusätzlich prüft es alle 5 Minuten nach.
- **Nach einem Neustart ohne USB (C, ab Gerät v224):** Gerät stellt Port 5555 selbst wieder her – beim Start und wenn die Wartung zentral eingeschaltet wird bzw. alle 5 Minuten, solange sie an ist. Es schaltet kurz „Debugging über WLAN“ ein, findet dessen TLS-Port per mDNS, verbindet sich mit seinem **eigenen adb-Schlüssel** (libadb-android) und schickt `tcpip:5555`; danach ist „Debugging über WLAN“ wieder aus. Getestet auf dem A15: 6 s, ohne Eingabe.
  - Der eigene Schlüssel wird einmal freigegeben (`geteiltes-telefon-einrichten.sh`, Schritt „eigener adb-Schlüssel“): Gerät verbindet sich über 5555, die Bedienungshilfe bestätigt „USB-Debugging zulassen? / Von diesem Computer immer zulassen“ **nur bei genau seinem Fingerabdruck**. Im Kiosk lässt Gerät dafür kurz die SystemUI zu. adbd prüft beim TLS-Debugging gegen dieselben vertrauten Schlüssel, eine Kopplung mit Code braucht es nicht.
  - `adb_allowed_connection_time 0`: Freigaben verfallen nicht nach 7 Tagen ohne Verbindung.
  - Die Netz-Rückfrage von „Debugging über WLAN“ bestätigt die Bedienungshilfe nur im WLAN „Rosenweg“; in einem anderen, noch nicht vertrauten Netz (Zugangspunkt) muss sie einmal jemand bestätigen.
  - Zum Testen per adb: `am broadcast -a ch.rosenweg4303.telefon.ADB_SELBST_WIEDERHERSTELLEN -n ch.rosenweg4303.telefon/org.sipdroid.sipua.rosenweg.AdbFreigabe` (Ergebnis im Log `RosenwegAdbSelbst`).

### Apps per adb aktualisieren (adb-Updater, Entwurf 26. November 2026)

Stefan: „Das zentrale System soll sich per adb mit den geteilten Telefonen verbinden und neue App-Versionen selbst einspielen.“ Rosenweg Gerät holt den Katalog zwar selbst (beim Start, bei der Anmeldung, sonst höchstens alle 6 Stunden) und installiert still als Device Owner. Der adb-Weg kommt dazu, weil

- neue Fassungen damit **gleich nach der Freigabe** ankommen, nicht erst beim nächsten Abgleich,
- **Rosenweg Gerät selbst** sich so von außen ersetzen lässt (auch wenn sein eigener Abgleich hängt),
- die Anlage **sieht, was auf jedem Telefon installiert ist** (/smartphones, Spalte „Apps“).

**Ablauf** (`pbx/api/adb_updater.py`, Timer alle 15 Min. + sofort nach einer Freigabe im Katalog oder „⟳ Jetzt“):

1. Fällig ist ein Telefon, wenn es laut letzter Prüfung ältere Fassungen hat, der Katalog seither neuer ist oder es noch nie geprüft wurde. Nach einem Fehlversuch frühestens nach 1 Stunde wieder.
2. Hindernisse → warten: jemand angemeldet, Abmeldung vor weniger als 10 Min. (Nachlauf/Uploads), Gespräch auf der Nebenstelle (AMI `core show channels`). Notrufe werden nie gewählt oder getestet; der Updater ruft nur den bestehenden Weckanruf 2098 auf.
3. adb ein über die bestehende Wartung (`telefon_wartung`, Weckanruf 2098, 15 Min.), auf die Meldung von Gerät warten (`telefon_adb`, Port 5555).
4. Nur Adressen aus `PBX_ADB_NETZE` (Vorgabe RK-Clients `100.64.9.0/24`); Seriennummer muss zur Nebenstelle passen (beim Zulassen gemerkt).
5. Installierte Fassungen lesen (`cmd package list packages --show-versioncode`) → `telefon_apps_ist`.
6. Je ältere Katalog-App: erneut Hindernisse prüfen, dazu **Bildschirm aus** und Akku ≥ 30 % (oder am Strom); APK prüfen (SHA-256 wie im Katalog, Rosenweg-Zertifikat `7b3bac26…a5ae`, Paket und versionCode aus dem Manifest, mit `apksigner` auch kryptografisch); `ADB_INSTALLATION`, `adb install -r` (nie Downgrade, nie Erstinstallation – die macht Gerät inkl. Ausblenden). **Rosenweg Gerät selbst zuletzt und nur nachts** (`PBX_ADB_NACHT`, Vorgabe 01–05 Uhr).
7. Installationsverbot sofort wieder setzen (`ADB_INSTALLATION_ENDE`, ab Gerät v237), Wartung wieder aus, wenn der Updater sie eingeschaltet hat (von Hand eingeschaltete bleibt).
8. Jeder Schritt steht in `telefon_log` (durch „App-Updater“) und damit im Verlauf auf /smartphones.

Nie: Neustart, `pm uninstall`, Einstellungen ändern, andere Netze. Der Updater kennt nur `install -r`, `am broadcast` an Gerät, `getprop`, `dumpsys power/battery` und die Paketliste.

**Schlüssel:** eigener adb-Schlüssel des Updaters, nur auf CT 220 unter `/var/lib/pbx-adb/.android/` (0700, Benutzer `asterisk`), nie im Repo. Pro Telefon einmal zulassen: /smartphones „Updater zulassen“ (Telefon abgemeldet, im WLAN „Rosenweg“). Die Anlage schaltet adb 15 Min. ein und gibt Gerät im Status den Fingerabdruck mit (`adb_dienst`, 5 Min.); die Bedienungshilfe bestätigt „USB-Debugging zulassen? / immer zulassen“ **nur für genau diesen Fingerabdruck** (wie beim eigenen Schlüssel, ab Gerät v237). `adb_allowed_connection_time 0` sorgt dafür, dass die Zulassung nicht verfällt. „Vergessen“ gibt es über `POST /api/telefon/<ext>/updater {aktion: "vergessen"}` (Telefon ersetzt).

**Netzweg:** Abgemeldete Telefone sind im WLAN „Rosenweg“ im RK-Clients-Netz (VLAN 9, `100.64.9.0/24`); CT 220 (VLAN 2) erreicht dieses Netz heute schon. Angemeldete Telefone sind im Wohnungsnetz und von der Infrastruktur aus nicht erreichbar – das passt zur Regel „nur abgemeldet“. Telefone in fremden WLANs (z. B. Juronetz) bedient der Updater nicht; sie bekommen Updates über den eigenen Abgleich von Gerät.

Endpunkte: `POST /api/telefon/<ext>/updater {aktion: zulassen|jetzt|vergessen}` (Technik), `GET /api/pbx/smartphones` liefert je Telefon `updater` (zugelassen, ausstehend, Ergebnis, geprüft) und `updater_fingerabdruck`.

### Fernwartung über den dauerhaften adb-Tunnel (Phase 1, 27. November 2026)

Stefan: dauerhaft, weil die Telefone nicht privat sind – wer das Telefon benutzt, sieht trotzdem
jede Sitzung. Entscheide: Tunnel **in Rosenweg Gerät** (keine eigene App), Bildschirm (scrcpy)
auch bei angemeldeter Person **erlaubt mit Band**, Technik arbeitet **nur per SSH auf adb-zentrale**,
Zentrale als eigener CT auf pve2 mit WireGuard **UDP 51832** unter **adb.rosenweg4303.ch**.
Code: `pbx/adb-zentrale/` (Zentrale, Einrichtung: dortiges README), `pbx/api` (Peers, Not-Aus,
Verlauf), Rosenweg Gerät (`Fernwartung*`), rwtunnel im Repo rosenweg-vm (Telefonseite, Hörmodus).

```
Telefon (Rosenweg Gerät) ──WireGuard UDP 51832──► adb-zentrale (CT, Netzstapel im Prozess, kein TUN)
  im Tunnel nur 10.243.44.n:5555 → 127.0.0.1:5555 (adbd)   127.0.0.1:2<ext> nur während einer Sitzung
            und 10.243.44.n:7000 (wer, wozu – fürs Band)   Technik: ssh adb-zentrale; rw-adb <ext> …
```

- **Telefon:** Gerät erzeugt einmal ein WireGuard-Schlüsselpaar (privat nur in `noBackupFilesDir`),
  meldet den öffentlichen Teil (`POST /api/telefon/tunnel`) und wartet. Auf /smartphones steht
  „neuer Schlüssel … Bestätigen“. Nach dem Bestätigen gibt der Status `fernwartung: {stand: bereit,
  adresse, gateway, peer_public, endpoint, endpoint_intern, schluessel}`; Gerät startet den Tunnel
  als Vordergrunddienst (`FernwartungDienst`, stille Benachrichtigung „Fernwartung bereit“), auch
  nach Neustart und Update. adb bleibt dann **dauerhaft an**, Port 5555 stellt Gerät selbst her.
- **Band:** Jede adb-Verbindung kommt im Netzstapel des Telefons an. Solange eine offen ist (und
  10 s danach), zeigt Gerät oben über allem „🛠 Fernwartung aktiv – Technik (Name) seit 14:02“
  und die Benachrichtigung wird laut. Den Namen meldet die Zentrale auf :7000; fehlt er, steht
  „unbekannt“ – das Band erscheint trotzdem. Braucht `SYSTEM_ALERT_WINDOW` (Skript).
- **Not-Aus:** /smartphones „⛔ aus“ je Telefon, oben „⛔ Fernwartung alle aus“. Wirkt zweifach:
  die pbx-api nimmt den Peer sofort aus der Zentrale (offene Sitzung gekappt, auch wenn das
  Telefon nicht antwortet), und der Weckanruf 2098 holt den Status `fernwartung: {stand: aus}` –
  Gerät stoppt den Tunnel und setzt `ADB_ENABLED=0` (kein adbd, auch nicht per USB). „ein“ geht
  ohne USB. „Verwerfen“ löscht den Schlüssel (Telefon ersetzt oder zurückgesetzt).
- **Schlüssel:** Die Bedienungshilfe bestätigt „USB-Debugging zulassen?“ nur noch für drei
  Fingerabdrücke: den eigenen von Gerät, den der Zentrale (`adbz`, `rw-adb schluessel`) und den des
  Updaters; die beiden letzten stehen im Status (`fernwartung.schluessel`). Eine **fremde** Rückfrage
  lehnt sie ab („Ablehnen“) und meldet sie (`POST /api/telefon/fernwartung/meldung`, Verlauf, NOC rot
  für 24 h). Ausnahme **Wartung vor Ort**: Ist auf /smartphones „🛠 1 Std.“ an, bleibt eine fremde
  Rückfrage stehen (z. B. für den Mac am USB) und wird nur gemeldet.
- **Zugang für Technik:** nur per SSH auf adb-zentrale (Zugriffsmatrix, Host nur für Technik),
  dort `rw-adb liste`, `rw-adb 2002`, `rw-adb 2002 shell …`, `rw-adb 2002 logcat …`,
  `rw-adb 2002 einrichten`, `rw-adb 2002 ende` (sonst nach 30 Min. ohne Verkehr). Der adb-Schlüssel
  liegt nur bei `adbz` im CT. Jede Sitzung (wer, wozu, Beginn, Ende, Bytes, rw-adb-Befehle) steht im
  Journal des CT und auf /smartphones unter „Fernwartung: Sitzungen“. `reboot`, `uninstall`,
  `pm clear` und Ähnliches lehnt rw-adb ab; eine interaktive Shell steht als „shell“ im Protokoll.
  scrcpy ist erlaubt (Band), läuft aber mangels Bildschirm nicht auf dem CT – mit „nur SSH“ gibt es
  in Phase 1 keine Bildschirmübertragung.
- **Ehrliche Grenze:** adbd hört auf Port 5555 auf allen Schnittstellen; ohne Root lässt sich das
  nicht auf den Tunnel beschränken. Darum zusätzlich die UniFi-Regel unten und „nur bekannte Schlüssel“
  (`ro.adb.secure=1`, prüft das Skript).
- **Einrichten eines Telefons:** Gerät ≥ Fernwartungs-Fassung installieren, Skript einmal laufen
  lassen (`SYSTEM_ALERT_WINDOW`), auf /smartphones bestätigen, dann den Schlüssel der Zentrale
  zulassen: `rw-adb <ext>` – die Bedienungshilfe bestätigt die Rückfrage (Fingerabdruck steht im
  Status). Ab da geht jeder Schritt des Skripts über den Tunnel (`rw-adb <ext> einrichten`);
  `--device-owner` und die allererste Schlüssel-Zulassung bleiben vor Ort (Henne und Ei).

**UniFi: TCP zu den Telefonen sperren (Anleitung, noch nicht umgesetzt).** Erst nach dem Test am
A15 und wenn der Updater über den Tunnel läuft (bis dahin braucht CT 220 den direkten Weg):

1. UniFi Network → *Client Devices*: die geteilten Telefone (MAC) in eine Gruppe „Geteilte Telefone“
   (bzw. als Firewall-Gruppe „Adressen“ über die festen DHCP-Reservierungen in RK-Clients und den
   RW*-Clients-Netzen).
2. *Settings → Security → Firewall* (Zone-Based: Zonen der Clients-Netze → gleiche Zone und
   „Internal“): neue Regel **„Geteilte Telefone: kein TCP hinein“**, Aktion *Block*, Protokoll TCP,
   Ziel = Gruppe „Geteilte Telefone“, alle Ports, Zustand *New* (established/related bleibt erlaubt –
   SIP, Status, Nextcloud gehen vom Telefon aus).
3. Darüber eine Ausnahme nur, falls noch nötig: *Allow* TCP 5555 von CT 220 (Rückfall, bis
   `PBX_ADB_NETZE` entfällt). Danach entfernen.
4. Prüfen: vom Mac im selben WLAN `nc -vz <telefon> 5555` → keine Verbindung; `rw-adb <ext>
   shell echo ok` auf adb-zentrale → ok (der Tunnel geht vom Telefon aus, UDP).

### Eigene Handys von außen: SIP über TLS (25. November 2026)

Rosenweg Telefon ohne Rosenweg Gerät (eigenes Handy) registriert sich über **TLS auf Port 5061** bei `sip.rosenweg4303.ch`, drinnen wie draußen.

- **DNS:** öffentlich `sip.rosenweg4303.ch` → CNAME `kooperation.rosenweg4303.ch` (WAN 37.17.232.133, nur DNS, kein Cloudflare-Proxy); intern zeigt der Name auf CT 220 (100.64.2.55). Das Let's-Encrypt-Zertifikat passt für beides.
- **UniFi:** Portweiterleitung „Asterisk-SIP-TLS (Rosenweg Telefon)“ TCP 5061 → 100.64.2.55:5061; RTP 10000–10100 UDP war schon weitergeleitet. SIP über UDP/TCP 5060 bleibt von außen zu (nur der peoplefone-Trunk).
- **Sperren:** SIP geht nicht über den Edge, deshalb läuft auf CT 220 ein eigener CrowdSec-Firewall-Bouncer (`ct220-sip-bouncer`, nftables, LAPI auf dem Edge). Er setzt dieselben Sperren um (8 Fehlversuche → 24 h, Szenario `rosenweg/sip-bf`) plus die Community-Liste.
- **pbx-api:** `PBX_SIP_TRANSPORT_PRIVAT` (Vorgabe `tls`) bestimmt Transport und Port der eigenen Handys; geteilte Telefone bleiben bei `PBX_SIP_TRANSPORT`.
- **`POST /api/telefon/privat/stand`** `{user, password}`: Rosenweg Telefon fragt regelmäßig nach. 200 = aktuelle Zugangsdaten (so kommt auch der Wechsel auf TLS aufs Handy), 401 = Zugang gibt es nicht mehr (im Web auf /smartphones abgemeldet) → die App meldet sich ab und fragt nicht weiter.
- Sprache (RTP) ist noch unverschlüsselt; SRTP ist ein eigener Schritt.
