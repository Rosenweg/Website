# Rosenweg PBX (Asterisk)

Telefonanlage fuer die +41 61 551 01 52 (peoplefone-SIP-Trunk). Phase-1-Setup:
- Eingehende Anrufe **Mo-So 06:00-20:00** → Ring-Group an Technik-Mobilnummern (Stefan + Andreas)
- **Ausserhalb dieser Zeit** → Voicemail mit KI-Transkription + Zusammenfassung per Email + WhatsApp

Phase 2 (geplant): Echtzeit-AI-Konversation via AudioSocket + Whisper-Stream + Claude + ElevenLabs.

## Architektur

```
PSTN ─→ peoplefone SIP-Trunk ─→ Asterisk (CT 201)
                                    │
                                    ├─ 06-20h ─→ Dial(PJSIP/+41…@peoplefone) → Stefan & Andreas Mobile
                                    │
                                    └─ Voicemail ─→ Record(wav) ─→ AGI-Script
                                                                    └─→ POST /api/pbx/voicemail
                                                                          └─→ OpenRouter Whisper-1 + Claude
                                                                              └─→ Email + WA-Push an Technik
```

## Setup-Schritte

### 1. peoplefone SIP-Credentials beschaffen
Im peoplefone-Kundenkonto unter **Trunk / SIP-Konfiguration**:
- Username (oft die Nummer im Format 41615510152)
- Password
- Server (meist `sip.peoplefone.ch`)

### 2. Environment im Prod-Stack setzen
```bash
ssh root@100.64.2.24
nano /opt/rosenweg-website/.env
# Eintragen:
PBX_SHARED_SECRET=<openssl rand -hex 32>
PJSIP_USER=41615510152
PJSIP_PASS=...
PJSIP_SERVER=sip.peoplefone.ch
PBX_EXTERNAL_IP=100.64.2.27   # Swarm-VIP fuer externe Pakete
TECHNIK_NUMBERS=+41765199970&+41795350856
```

API-Service braucht PBX_SHARED_SECRET, sonst antwortet er nicht auf das AGI-Upload:
```bash
docker service update --env-add PBX_SHARED_SECRET=<...> rosenweg_api
```

### 3. peoplefone DID-Routing auf eigene IP umstellen
Im peoplefone-Portal die Inbound-Route fuer +41 61 551 01 52 von WhatsApp-only auf den SIP-Trunk umstellen, der jetzt unsere Asterisk registriert.

### 4. Service hochziehen
```bash
ssh root@100.64.2.24
docker service scale rosenweg_pbx=1
docker service logs -f rosenweg_pbx
```

Sobald im Log `Successfully registered` erscheint, kann man testweise die Nummer anrufen.

### 5. Test
- **06:00-20:00**: Anruf sollte Stefan + Andreas parallel klingeln lassen.
- **Sonst**: Voicemail-Greeting, dann Aufnahme. Nach Hangup kommt Email mit Audio + Transkript an alle in `technik`+`Praesident`.

## Konfiguration / Anpassung

- **Geschaeftszeiten:** in `asterisk-config/extensions.conf` → `HOURS_OPEN_FROM`/`HOURS_OPEN_TO` aendern und Service neu starten.
- **Ring-Group-Nummern:** ENV `TECHNIK_NUMBERS` (Format `+41xxx&+41yyy`, & ist parallel-dial-Trenner).
- **Voicemail-Aufnahme-Max-Laenge:** im `Record()`-Befehl in extensions.conf (aktuell 180s).
- **Whisper-Modell / Claude-Prompt:** in `api/server.js` Funktionen `transcribeWhisper()` / `summarizeVoicemail()`.

## Daten / Backups

- `pbx-voicemail` Docker-Volume haelt die Aufnahmen lokal (vor Email-Send). Auto-Cleanup ist nicht implementiert — bei Bedarf eigenes Cron.
- Asterisk-Config liegt im Image, NICHT im Volume → Aenderungen erfordern Image-Rebuild + Service-Update.

## Phase 2 (Roadmap)

- Asterisk-AudioSocket-Modul → bidirektionaler Audio-Stream zur API
- API als Streaming-Gateway:
  - Eingehendes Audio (PCM 16k) → Whisper Streaming → Text
  - Text → Claude-Konversation mit STWEG-Kontext (FAQ, aktuelle Reklamationen, Verwaltung, Notfaelle)
  - Claude-Response → ElevenLabs TTS → Audio zurueck zu Asterisk
- Eskalation: AI sagt "Ich verbinde dich" → ATXFER an Technik-Mobile (mit Briefing-SMS vorab)
- DSGVO: Anrufer-Hinweis am Anfang ("Dieses Gespraech wird KI-gestuetzt bearbeitet")
- Knowledge-Base: STWEG-Daten via Tool-Calls (Auslagen, Reklamationen, Termine)
