# Android-Dauertest der Rosenweg-Apps

Android-Emulator im CT 149 `android-dauertest` (pve2, 100.64.2.69, Debian 13, unprivilegiert,
`/dev/kvm` per `dev0`). Installiert die Apps so, wie sie auf /apps liegen, prüft Prüfsumme und
Signaturzertifikat, fährt je App einen Maestro-Ablauf und hält ein Schirmbild fest.

Ergebnisse gehen nach jedem Lauf per POST an die Haupt-API
(`/api/isp/noc/android-dauertest`, `api/routes/android-dauertest.js`). Das NOC (Wandbild
und ISP-Admin) zeigt sie im Abschnitt „Apps · Android-Dauertest“. Die Technik bekommt eine
WhatsApp-Meldung (sonst Mail an technik@) nach zweimal rot in Folge, beim ersten Rot direkt
nach einem neuen Release, wenn eine App wieder grün ist, und wenn 3 h lang kein Lauf kam.

| Datei | Zweck |
|---|---|
| `ct-anlegen.sh` | CT auf dem Knoten anlegen (root auf pve2) |
| `einrichten.sh` | im CT als root: Pakete, Benutzer `android`, SDK, Maestro, AVD, Schnappschuss `sauber` |
| `emulator.sh` | `start` (Schnappschuss, ~21 s) / `kalt` (~31 s) / `stopp`, headless mit swiftshader |
| `lauf.sh` | ein Lauf über alle aktiven Apps aus `apps.json`; `--nur-neu` nur bei neuer Version auf /apps |
| `apps.json` | welche Apps, Quelle, erwartete Signatur, Ablauf |
| `flows/*.yaml` | Maestro-Abläufe (Flutter-Semantik: ganze Texte als Regex, darum `.*`) |
| `systemd/` | Timer stündlich und alle 5 min Abfrage der Quellen (/apps-Index, GitHub-Releases) |

## Von Hand

```sh
pct enter 149
su - android
~/dauertest/lauf.sh              # alle aktiven Apps, Ergebnis in ~/ergebnis/
~/dauertest/lauf.sh bausteine    # nur eine
```

Ergebnis je App: `~/ergebnis/<kennung>.json` (`ok`, `grund`, `version`, `dauer_s`) und
`<kennung>.png`; Gesamtstand `~/ergebnis/stand.json`.

## Signatur

Bei `quelle: index` muss die Datei die Prüfsumme aus `index.json` haben und mit dem Zertifikat
`signatur_sha256` aus dem Index signiert sein (geprüft mit `apksigner verify --print-certs`).
Rosenweg Bausteine kommt nicht auf /apps (nur Technik): `quelle: github` nimmt das neueste
Release `beispiel-v*` aus rosenweg-basis (APK + `.sha256`), signiert mit dem Rosenweg-Schlüssel.

## Geheimnisse

`/etc/android-dauertest.env` im CT (640 root:android): `APPTEST_BENUTZER`/`APPTEST_PASSWORT`
(Konto `apptest`, Gruppe `apptest`, keine Person) und `MELDE_URL`/`MELDE_TOKEN`
(= `ANDROID_DAUERTEST_TOKEN` in `/opt/rosenweg-core/.env` auf CT 128). Nie ausgeben.

## Timer

```sh
cp ~android/dauertest/systemd/* /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now android-dauertest.timer android-dauertest-neu.timer
```

## Rückweg

```sh
pct stop 149 && pct destroy 149
```
