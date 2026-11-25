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
| SIP-Anrufkonten aktivieren (zwei: Nebenstelle des Geräts und persönliches Konto) | `adb shell telecom set-phone-account-enabled ch.rosenweg4303.telefon/org.sipdroid.sipua.ui.SipConnectionService SipdroidCallProvider 0` und ab Rosenweg Telefon v27 `adb shell telecom set-phone-account-enabled ch.rosenweg4303.phone/org.sipdroid.sipua.ui.SipConnectionService SipdroidCallProvider 0` (das Konto gibt es erst, wenn Rosenweg Telefon einmal lief; das Skript startet es dafür kurz) | bleibt: Android schaltet Anrufkonten fremder Apps nie selbst ein. Die Freigabe überlebt An- und Abmelden (das Konto wird nur offline geschaltet, nie ausgetragen) |
| Akku-Optimierung für Rosenweg Telefon ausnehmen (persönliches SIP-Konto bleibt im Ruhemodus registriert) | `adb shell dumpsys deviceidle whitelist +ch.rosenweg4303.phone` | dito; geht beim Ausblenden/Daten-Löschen verloren → Rosenweg Telefon im Katalog auf „immer“ |
| Standard-Telefon-App | `adb shell cmd role add-role-holder android.app.role.DIALER ch.rosenweg4303.phone 0` | Knox oder Rückfrage beim Einrichten prüfen |
| Standard-Browser | `adb shell cmd role add-role-holder android.app.role.BROWSER <paket> 0` | dito |
| Akku-Optimierung ausnehmen | `adb shell dumpsys deviceidle whitelist +ch.rosenweg4303.telefon` | dito |
| Akku-Optimierung für Rosenweg Messenger ausnehmen (MQTT bleibt im Ruhemodus offen, Notfälle kommen an) | `adb shell dumpsys deviceidle whitelist +ch.rosenweg4303.messages` | dito |
| Rosenweg Telefon darf eingehende Anrufe als Vollbild über dem Sperrbildschirm zeigen (sonst nur ein Symbol, nicht annehmbar; Rosenweg Telefon warnt dauerhaft, solange es fehlt, und zeigt auf geteilten Telefonen Anrufe immer im Vollbild) | `adb shell appops set ch.rosenweg4303.phone USE_FULL_SCREEN_INTENT allow` | dito |
| Rosenweg Gerät bestätigt „Debugging über WLAN zulassen“ selbst – nur im WLAN „Rosenweg“ und nur, wenn die Anlage das Debugging zentral eingeschaltet hat (in anderen WLANs bestätigt ein Mensch von Hand) | `adb shell settings put secure enabled_accessibility_services ch.rosenweg4303.telefon/org.sipdroid.sipua.rosenweg.WlanBestaetiger` und `adb shell settings put secure accessibility_enabled 1` | dito |
| Messenger darf „Nicht stören“ für den Notfall-Alarm kurz ausschalten | `adb shell cmd notification allow_dnd ch.rosenweg4303.messages` | dito |
| Rotes Notfall-Fenster über dem Sperrbildschirm (Android 14 erteilt es nicht von selbst) | `adb shell appops set ch.rosenweg4303.messages USE_FULL_SCREEN_INTENT allow` | dito |
| Exakte Wecker: Notfall-Erinnerung alle 2 min bis gelesen, auch im Tiefschlaf | `adb shell appops set ch.rosenweg4303.messages SCHEDULE_EXACT_ALARM allow` | dito |
| Zugriff auf alle Dateien (Aufräumen beim Abmelden) | `adb shell appops set ch.rosenweg4303.telefon MANAGE_EXTERNAL_STORAGE allow` | dito |
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

