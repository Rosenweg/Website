# Geteilte Rosenweg-Telefone — Systemgrenzen

Stand: 24.11.2026, gemessen am Galaxy A15 („Rosenweg Smartphone 2“, Android 16,
One UI, ohne SIM). Gilt sinngemäss für jedes Samsung-Telefon mit Stock-Firmware.

Diese Liste sammelt, was Android oder Samsung **nicht** zulässt, und wie die
Rosenweg-Apps damit umgehen. Vor Änderungen an Ausblendliste, Launcher oder
Telefon-App hier nachlesen.

## Was Android oder Samsung nicht erlaubt

| # | Grenze | Grund | Lösung im Rosenweg-System |
|---|---|---|---|
| 1 | **Notrufe** zeigen immer die System-Telefon-App, nie Rosenweg Phone | Telecom koppelt bei Notrufen die Standard-Telefon-App ab (`InCallController`, `EmergencyInCallServiceConnection.takeControl()`) | Samsung-Telefon (`com.samsung.android.dialer`) bleibt installiert, steht auf „nur unsichtbar“ |
| 2 | **„Foto/Video aufnehmen“** aus anderen Apps geht nur an die System-Kamera | Android 11+: `IMAGE_CAPTURE`/`VIDEO_CAPTURE` nur für vorinstallierte Kameras | Samsung-Kamera (`com.sec.android.app.camera`) bleibt installiert, „nur unsichtbar“ |
| 3 | **„Keine SIM · Nur Notrufe“** und Netzbetreiber-Name nicht änderbar | Text kommt aus dem Modem | Mobilfunk-Symbol ausgeblendet (`icon_blacklist`); Gerät und Person stehen auf dem Sperrbildschirm |
| 4 | **Notrufe laufen nie über SIP** | 112 & Co. gehen immer übers Modem | Modem bleibt an, kein Flugmodus |
| 5 | **WebView** bleibt die von Google | Austausch nur mit Root/eigenem Betriebssystem | geschützt, nie ausgeblendet |
| 6 | **Nur ein Android-Benutzer** | Samsung-Telefone: `pm get-max-users` = 1 | Anmeldung pro Person, App-Daten beim Abmelden löschen; Einstellungen künftig über die Nextcloud der Person |
| 7 | **Bildschirmsperre pro Person** nur als PIN/Passwort, kein Muster, keine Biometrie | `resetPasswordWithToken` kennt nur PIN/Passwort; Biometrie gilt fürs ganze Gerät | persönliche PIN (geplant) |
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
| Zugriff auf alle Dateien (Aufräumen beim Abmelden) | `adb shell appops set ch.rosenweg4303.telefon MANAGE_EXTERNAL_STORAGE allow` | dito; Alternative: Aufräumen über Rosenweg Files |

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
