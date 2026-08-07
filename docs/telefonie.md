# Telefonie — Übersicht

Einstiegspunkt für alle Telefonie-Systeme der Rosenweg-Kooperation. Vier Systeme
hängen zusammen, haben aber je eigene Oberflächen und eigene Anleitungen:

| System | Was es tut | Oberfläche | Anleitung |
|---|---|---|---|
| **Telefonanlage (PBX)** | Nimmt Anrufe an, klingelt die Technik, nimmt Voicemail auf und lässt sie von der KI zusammenfassen | `pbx.rosenweg4303.ch` | [Telefonanlage](telefonanlage-anleitung.md) |
| **Interne SIP-Telefone** | Tisch-Telefone und Softphones im LAN/VPN, interne Wahl, Konferenz | Anlage im PBX-Admin, Rest am Gerät | [SIP-Telefone](sip-telefone-anleitung.md) |
| **WhatsApp-Bot + Gateway** | Bewohner melden Schäden und fragen Daten ab; System schickt Pushes raus | `whatsapp.rosenweg4303.ch` | [WhatsApp](whatsapp-anleitung.md) |
| **Telefonbuch + Kontakte-Sync** | Internes Verzeichnis auf der Website und automatisch im Handy-Adressbuch | `telefonbuch.html` | [Telefonbuch](telefonbuch-anleitung.md) |

Bewohner-taugliche Kurzfassung von allem: [hilfe.html → Telefon & Erreichbarkeit](../hilfe.html#telefon).

---

## Wie die Teile zusammenspielen

```
                        +41 61 551 01 52
                    (eine Nummer, zwei Kanäle)
                    │                        │
            Anruf   │                        │  WhatsApp-Nachricht
                    ▼                        ▼
        peoplefone SIP-Trunk          WhatsApp-Bridge (CT 116)
                    │                        │
                    ▼                        │
        Asterisk-PBX (CT 220)                │
          │        │        │                │
          │        │        └── SIP-Telefone (LAN/VPN, Ext. 2xxx)
          │        │
          │        └── Ring-Group → Technik-Handys
          │
          └── Voicemail → Whisper → Claude ──┐
                                             │
                              WhatsApp-Gateway (/gateway/send)
                                             │
                                             ▼
                                      Rosenweg Technik
                                    (+ optional Auto-Reklamation
                                       in der Haupt-API)
```

Das Telefonbuch hängt daneben: es speist sich aus der Personen-Datenbank der
Haupt-API und wird einmal täglich in Nextcloud, SOGo und Z-Push gespiegelt, damit
die Nummern auch im Handy-Adressbuch stehen. Die PBX benutzt dieselbe Datenbasis
für die Anrufer-Namensauflösung (CNAM).

---

## Rufnummern

| Nummer | Wofür | Belegt durch |
|---|---|---|
| **+41 61 551 01 52** | Telefonzentrale / Technik-Hotline. Anruf → PBX, WhatsApp → Bot | peoplefone-Trunk (`PJSIP_USER=41615510152`), gepairte WhatsApp-Session |
| +41 61 228 18 18 | Hausverwaltung LangPartners (extern) | `site-config.json` → `verwaltung.telefon` |
| 117 / 118 / 144 | Polizei / Feuerwehr / Sanität | `site-config.json` → `notfall` |

> **⚠ Zu prüfen:** `site-config.json` (`technischer_dienst.telefon`) und die
> WhatsApp-Sektion in `hilfe.html` führen **+41 61 551 01 42** als zentrale Nummer.
> Der Trunk der PBX und die gepairte WhatsApp-Session laufen aber beide auf
> **…01 52**, und `contacts-sync.py` legt …01 52 als „Telefonzentrale /
> Technik-Hotline" im Adressbuch an. Eine der beiden Nummern ist veraltet — vor
> dem nächsten Aushang klären und dann an *einer* Stelle korrigieren
> (`site-config.json` ist die Quelle für die Website).

---

## Wer darf was

| Rolle | Telefonanlage | SIP-Telefone | WhatsApp-Gateway | Telefonbuch |
|---|---|---|---|---|
| **Technik** | Vollzugriff | Anlegen/Löschen | Vollzugriff, API-Keys | Lesen + Export |
| **Präsident** | Vollzugriff | Anlegen/Löschen | Vollzugriff | Lesen + Export |
| **Ausschuss** | kein Zugriff | — | — | Lesen |
| **Bewohner** | anrufen, Voicemail | — | Bot per WhatsApp | Lesen |

Die Admin-Oberflächen von PBX und Gateway prüfen auf Authentik-Gruppe `technik`
oder `präsident` bzw. das Admin-Flag. Das Telefonbuch ist für jeden
eingeloggten Benutzer lesbar.

---

## Wo läuft was

| Dienst | Ort | Adresse |
|---|---|---|
| Asterisk + PBX-API | CT 220 (`asterisk-pbx`), auf pve1 | `100.64.2.29` — Web `:8095`, SIP `:5060/udp`, AMI `127.0.0.1:5038` |
| PBX-Admin (öffentlich) | Cloudflare-Tunnel → CT 220 | `pbx.rosenweg4303.ch` |
| WhatsApp-Bridge + Gateway | CT 116 (`whatsapp-bridge`), HA-float | `100.64.2.39` — Gateway `:8090`, Groups `:8080`, SMTP-In `:2525` |
| WhatsApp-UI (öffentlich) | Traefik-Route → CT 116 | `whatsapp.rosenweg4303.ch` |
| Kontakte-Sync | CT 201 (`docker-pve1`) | systemd-Timer, täglich 04:30 UTC |
| Telefonbuch-API | Haupt-API im Swarm | `GET /api/telefonbuch` |

> **⚠ Zu prüfen:** Für CT 220 kursieren drei IPs. Aktuell und verifiziert ist
> **100.64.2.29** ([DEPLOY-PBX-API.md](../pbx/DEPLOY-PBX-API.md), PBX-Admin-UI).
> `docs/systemuebersicht.md` und der Kommentar in `pbx/asterisk-config/pjsip.conf`
> nennen `100.64.2.55`, `pbx/README.md` nennt `100.64.2.30` — beide veraltet.

---

## Quellen im Repo

| Was | Pfad |
|---|---|
| Asterisk-Configs (Source of Truth) | `pbx/asterisk-config/` |
| AGI-Skripte (Dialplan-Logik) | `pbx/agi/` |
| PBX-API (Flask) + Admin-UI | `pbx/api/`, `pbx/web/pbx-admin.html` |
| Deploy-Runbook PBX | `pbx/DEPLOY-PBX-API.md` |
| WhatsApp-Bot + Gateway | `whatsapp-bot/`, LXC-Setup unter `whatsapp-bot/lxc/` |
| Bot-Befehlslogik | `api/server.js` → `handleWhatsappCommand()` |
| Kontakte-Sync | `contacts-sync/` |
| Telefonbuch-Seite | `telefonbuch.html` |
