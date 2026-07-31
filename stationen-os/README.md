# Rosenweg Stationen-OS

> **Status: Entwurf, unfertig.** Bisher existieren nur diese README, `.gitignore`
> und `.shellcheckrc`. Alles unten Beschriebene — `install.sh`, `lib/`, `base/`,
> `roles/`, `agent/`, `build/`, `config/`, `docs/` — ist noch **nicht** implementiert.
> Das Verzeichnis liegt vorerst im Website-Repo, weil das eigenständige GitHub-Repo
> noch nicht angelegt werden konnte (Token darf keine Repos erstellen).

Basis-Betriebssystem für alle **Rosenweg-Stationen** auf Basis von **Debian 13 (Trixie)**.

Eine „Station" ist ein fest installiertes Gerät in der Liegenschaft, das eine der
Web-Oberflächen von `rosenweg4303.ch` anzeigt oder Messwerte in den MQTT-Broker
liefert. Alle Stationen teilen sich ein gemeinsames, unattended installiertes
Basissystem; was die Station konkret tut, entscheidet ihre **Rolle**.

| Rolle | Zweck | Zeigt / spricht |
|-------|-------|-----------------|
| `kiosk` | Bedien-Terminal mit Login (Treppenhaus, Eingang) | `www.rosenweg4303.ch`, Auto-Logout bei Inaktivität |
| `display` | Digital Signage, kein Login, 24/7 | `display.rosenweg4303.ch` (`display/announcement`, `display/emergency`) |
| `sensor` | Headless-Messknoten | publiziert nach `sensors/<station-id>/…` auf dem MQTT-Broker |

## Grundprinzipien

- **Kein Geheimnis im Code.** Dieses Repo enthält ausschliesslich Skripte, Templates
  und Dokumentation. Passwörter, WLAN-Keys und Broker-Credentials liegen im privaten
  Config-Repo (`Rosenweg/stationen-config`), das die Station beim Setup per Deploy-Key klont.
- **Ein Image, viele Rollen.** Die ISO ist für alle Stationen identisch; eingebacken
  werden nur die Station-ID und die Deploy-Keys. Alles Weitere kommt aus der Config.
- **Idempotent.** `install.sh` kann jederzeit erneut laufen und stellt den Soll-Zustand
  wieder her — genau das nutzt auch das automatische Update.
- **Unattended.** Von USB-Stick bis fertiger Station ohne Tastatureingabe.

## Schnellstart

```bash
# 1. Deploy-Keys erzeugen (einmalig, pro Station oder global)
ssh-keygen -t ed25519 -f build/keys/deploy-key-os     -N '' -C 'stationen-os (ro)'
ssh-keygen -t ed25519 -f build/keys/deploy-key-config -N '' -C 'stationen-config (rw)'
#    -> .pub jeweils als Deploy Key im passenden Repo hinterlegen
#       (stationen-config braucht "Allow write access" für den Log-Push)

# 2. Station in der Config anlegen: stations/<station-id>.json im Config-Repo

# 3. ISO bauen (Station-ID wird eingebacken)
sudo build/build-iso.sh --station-id kiosk-r9-eingang

# 4. Auf USB schreiben und booten — Installation läuft vollautomatisch
sudo dd if=build/out/rosenweg-station-kiosk-r9-eingang.iso of=/dev/sdX bs=4M status=progress
```

Eine bestehende, manuell installierte Debian-13-Maschine wird stattdessen so zur Station:

```bash
git clone git@github.com:Rosenweg/rosenweg-stationen-os.git /opt/rosenweg-stationen-os
sudo /opt/rosenweg-stationen-os/install.sh --station-id kiosk-r9-eingang
```

## Aufbau

```
install.sh              Orchestrator: Config holen, Basis + Rolle anwenden
lib/                    common.sh (Logging, apt, Dateien), config.sh (jq-Zugriff)
base/                   Für jede Station: System, Netz, Benutzer, Härtung, Agent, Updates
roles/<rolle>/          Rollenspezifisches Setup + mitgelieferte Dateien
agent/                  Heartbeat/Status, Log-Push, Selbst-Update
build/                  ISO-Builder und Preseed für die unbeaufsichtigte Installation
config/                 Beispiel-Config und JSON-Schema (die echte liegt im privaten Repo)
docs/                   Architektur, Installation, Konfiguration, Rollen, Fernwartung
```

## Zusammenhang mit der Webseite

Das Repo [`Rosenweg/Website`](https://github.com/Rosenweg/Website) liefert die Inhalte,
die auf den Stationen laufen, und die APIs, mit denen sie sprechen:

- `www.rosenweg4303.ch` — Oberfläche der `kiosk`-Stationen, inkl. `/api/auth/logout`
  für den Auto-Logout.
- `display.rosenweg4303.ch` (`display.html`) — Oberfläche der `display`-Stationen.
  Ankündigungen und Notfälle kommen retained über MQTT (`display/announcement`,
  `display/emergency`), siehe `docs/mqtt-display.md` im Website-Repo.
- MQTT-Broker — intern `mqtt://100.64.2.51:1883`, extern `mqtts://mqtt.rosenweg4303.ch:8883`.
  Stationen publizieren ihren Zustand nach `stations/<station-id>/status`,
  `sensor`-Stationen ihre Messwerte nach `sensors/<station-id>/…`.

Die Ordner `kiosk/` im Website-Repo waren der Prototyp dieses Systems; die Migration
ist in [`docs/migration.md`](docs/migration.md) beschrieben.

## Dokumentation

- [Architektur](docs/architektur.md) — Boot- und Setup-Kette, Zustand auf der Station
- [Installation](docs/installation.md) — ISO bauen, Station aufsetzen, Fehlersuche
- [Konfiguration](docs/konfiguration.md) — Aufbau des privaten Config-Repos, alle Felder
- [Rollen](docs/rollen.md) — was `kiosk`, `display` und `sensor` konkret einrichten
- [Fernwartung](docs/fernwartung.md) — Updates, Status, Logs, Notzugang
- [Sicherheit](docs/sicherheit.md) — Härtung, Firewall, Umgang mit Geheimnissen
- [Migration](docs/migration.md) — Ablösung des bisherigen `kiosk/`-Setups
