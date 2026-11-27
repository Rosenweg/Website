# Android-Dauertest der Rosenweg-Apps

Android-Emulator im CT 149 `android-dauertest` (pve2, 100.64.2.69, Debian 13, unprivilegiert,
`/dev/kvm` per `dev0`). Installiert die Apps so, wie sie auf /apps liegen, prüft Prüfsumme und
Signaturzertifikat, fährt je App einen Maestro-Ablauf und hält ein Schirmbild fest.

Stand 27.11.2026: Test-CT steht, Rosenweg Bausteine läuft grün. **Nicht live:** keine Timer,
kein Melden ans NOC, kein Konto `apptest`. Plan und offene Fragen: siehe PR.

| Datei | Zweck |
|---|---|
| `ct-anlegen.sh` | CT auf dem Knoten anlegen (root auf pve2) |
| `einrichten.sh` | im CT als root: Pakete, Benutzer `android`, SDK, Maestro, AVD, Schnappschuss `sauber` |
| `emulator.sh` | `start` (Schnappschuss, ~21 s) / `kalt` (~31 s) / `stopp`, headless mit swiftshader |
| `lauf.sh` | ein Lauf über alle aktiven Apps aus `apps.json`; `--nur-neu` nur bei neuer Version auf /apps |
| `apps.json` | welche Apps, Quelle, erwartete Signatur, Ablauf |
| `flows/*.yaml` | Maestro-Abläufe (Flutter-Semantik: ganze Texte als Regex, darum `.*`) |
| `systemd/` | Timer stündlich und alle 5 min Index-Abfrage – **nicht aktiviert** |

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
Rosenweg Bausteine steht noch nicht auf /apps und hat kein Release: Bis dahin liegt ein lokal
gebauter APK im CT (`quelle: datei`), festgenagelt auf dessen Debug-Zertifikat.

## Rückweg

```sh
pct stop 149 && pct destroy 149
```
