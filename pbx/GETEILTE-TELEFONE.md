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
| 10 | **Chrome-Updates** nur über den Play Store | Play Store ist ausgeblendet und gesperrt | Empfehlung: Cromite über den Katalog |
| 11 | **Root** löst Samsung Knox dauerhaft aus | eFuse | kein Root |

## Was der Device Owner nicht selbst darf (heute einmalig per adb)

Wichtig für die geplante Einrichtung per QR ohne Kabel.

| Was | Befehl heute | Offen für QR-Einrichtung |
|---|---|---|
| SIP-Anrufkonto aktivieren | `adb shell telecom set-phone-account-enabled <komponente> SipdroidCallProvider 0` | entfällt vermutlich, sobald SIP in Rosenweg Phone steckt — prüfen |
| Standard-Telefon-App | `adb shell cmd role add-role-holder android.app.role.DIALER ch.rosenweg4303.phone 0` | Knox oder Rückfrage beim Einrichten prüfen |
| Standard-Browser | `adb shell cmd role add-role-holder android.app.role.BROWSER <paket> 0` | dito |
| Akku-Optimierung ausnehmen | `adb shell dumpsys deviceidle whitelist +ch.rosenweg4303.telefon` | dito |
| Zugriff auf alle Dateien (Aufräumen beim Abmelden) | `adb shell appops set ch.rosenweg4303.telefon MANAGE_EXTERNAL_STORAGE allow` | dito |

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
