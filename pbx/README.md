# Rosenweg PBX (Asterisk)

Telefonanlage fuer die +41 61 551 01 52 (peoplefone-SIP-Trunk). Laeuft NICHT in Docker, sondern in einem dedizierten LXC (CT 220 auf pve2). Begruendung: SIP/RTP-NAT in Docker = Aerger, LXC hat klassische Netzwerk-Semantik + native apt-Verwaltung.

**Phase 1 (heutiger Stand):**
- Mo-So 06-20h → Ring-Group an Technik-Mobiles (Stefan + Andreas), parallel klingelnd
- Sonst → Voicemail-Aufnahme → AGI-Script → Rosenweg-API
- API transkribiert via OpenRouter Whisper, fasst zusammen via Claude Haiku, mailt Audio+Transkript+Summary an Technik+Praesident, pusht Kurzfassung via WhatsApp

**Phase 2 (Roadmap):** AudioSocket-Bridge → Echtzeit-AI-Konversation mit STT/LLM/TTS-Pipeline.

## Architektur

```
PSTN ─→ peoplefone SIP-Trunk ──┐
                                │ SIP/RTP via Internet
                                ▼
                          CT 220 (pve2, 100.64.2.X)
                          Asterisk + chan_pjsip
                                │
        ┌───────────────────────┼──────────────────────┐
        │ 06-20h                                       │ ausserhalb
        ▼                                              ▼
   Dial(PJSIP/...@peoplefone)                  Record(wav) → AGI
   → Stefan & Andreas                          → POST /api/pbx/voicemail
                                                  → OpenRouter Whisper
                                                  → Claude Summary
                                                  → Email + WA-Push
```

## Configs

Alle Configs unter `pbx/asterisk-config/` und `pbx/agi/` sind **Source-of-Truth** im Repo. Deployment in den LXC via dem mitgelieferten Install-Skript.

- `asterisk-config/pjsip.conf` — peoplefone SIP-Trunk
- `asterisk-config/extensions.conf` — Dialplan mit GotoIfTime + Ring-Group + Voicemail
- `asterisk-config/modules.conf` — explizite Modulauswahl
- `asterisk-config/{asterisk,logger,rtp}.conf` — Basis-Konfig
- `agi/transcribe_voicemail.py` — Voicemail-Upload an Rosenweg-API

## Setup

### 1. LXC erstellen (auf pve2)

```bash
ssh root@100.64.2.21    # pve2

# Naechste freie CTID, Trixie-Template
pveam download local debian-13-standard_*.tar.zst 2>/dev/null
pct create 220 \
  local:vztmpl/debian-13-standard_13.0-1_amd64.tar.zst \
  --hostname asterisk-pbx \
  --memory 1024 --cores 2 --swap 512 \
  --net0 name=eth0,bridge=vmbr0,ip=100.64.2.30/24,gw=100.64.2.1 \
  --rootfs local-lvm:8 \
  --features nesting=1 \
  --onboot 1 --start 1 \
  --unprivileged 0
```

CT-IP `100.64.2.30` ist Beispiel; entsprechend deinem LAN setzen.

### 2. Asterisk + Sangoma-Repo

```bash
ssh root@100.64.2.21 pct enter 220
apt update && apt install -y curl gnupg ca-certificates lsb-release
# Sangoma-Repo (offiziell, immer aktuell)
curl -fsSL https://packages.asterisk.org/asterisk-org-pub.gpg \
  | gpg --dearmor -o /usr/share/keyrings/asterisk.gpg
echo "deb [signed-by=/usr/share/keyrings/asterisk.gpg] https://packages.asterisk.org/debian trixie main" \
  > /etc/apt/sources.list.d/asterisk.list
apt update
apt install -y asterisk asterisk-config python3 python3-requests
```

### 3. Configs vom Repo deployen

Aus dem Repo-Root:

```bash
scp -r pbx/asterisk-config/* root@100.64.2.30:/etc/asterisk/
scp pbx/agi/transcribe_voicemail.py root@100.64.2.30:/var/lib/asterisk/agi-bin/
ssh root@100.64.2.30 'chmod +x /var/lib/asterisk/agi-bin/transcribe_voicemail.py && chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk/agi-bin /var/spool/asterisk'
```

### 4. peoplefone-Credentials + Environment

```bash
ssh root@100.64.2.30
cat > /etc/default/asterisk-env <<EOF
PJSIP_USER=41615510152
PJSIP_PASS=<aus_peoplefone_portal>
PJSIP_SERVER=sip.peoplefone.ch
EXTERNAL_IP=<oeffentliche_IP_vor_NAT>
TECHNIK_NUMBERS=+41765199970&+41795350856
PBX_SHARED_SECRET=<openssl rand -hex 32>
API_BASE=http://100.64.2.27:3000
EOF
```

Asterisk liest diese via `pjsip.conf`-Substitution noch nicht direkt — entweder via systemd-`EnvironmentFile` und ein wrapper-Skript, das die Configs templatet, oder Werte direkt in `pjsip.conf` haerten. Schnellste Variante: hartkodieren beim ersten Setup.

API-Service braucht das gleiche `PBX_SHARED_SECRET`:
```bash
ssh root@100.64.2.24 "docker service update --env-add PBX_SHARED_SECRET=<...> rosenweg_api"
```

### 5. peoplefone-Routing umstellen

Im peoplefone-Portal die Inbound-Route fuer +41 61 551 01 52 vom alten Ziel (WhatsApp-Web-Bot) auf den neuen SIP-Trunk hin zur LXC umstellen. Achtung: WhatsApp-Pairing nutzt eine separate Linie via WhatsApp-Web (whatsapp-web.js Bot) — beide Welten koennen parallel laufen.

### 6. Start + Test

```bash
ssh root@100.64.2.30
systemctl enable --now asterisk
asterisk -rvvv     # CLI fuer Live-Logs
> pjsip show registrations    # sollte 'Registered' zeigen
> pjsip show endpoints
```

Test:
- **06-20h:** Anruf an die Nummer → Stefan + Andreas Mobiles klingeln parallel
- **Sonst:** Voicemail-Greeting → Aufnahme → Mail mit Transkript an Technik
- **Manuell:** `console dial pjsip/+41765199970@peoplefone`

## Anpassung

| Was | Wo |
|---|---|
| Geschaeftszeiten | `extensions.conf` → `HOURS_OPEN_FROM` / `HOURS_OPEN_TO` |
| Ring-Group-Nummern | `extensions.conf` → `TECHNIK_NUMBERS` (Format `+41xxx&+41yyy`) |
| Max Voicemail-Dauer | `extensions.conf` → `Record(...,180)` |
| Whisper-Modell | `api/server.js` → `transcribeWhisper()` |
| Claude-Prompt | `api/server.js` → `summarizeVoicemail()` |

## Backup

LXC-Snapshot taeglich via Proxmox (PVE GUI → CT 220 → Backup). Voicemail-Recordings unter `/var/spool/asterisk/voicemail/recordings/`.

## Phase 2 (Roadmap)

- Asterisk-AudioSocket-Modul → bidirektionaler PCM-Stream zur API
- API als Streaming-Gateway:
  - Eingehendes Audio (PCM 16k) → Whisper Streaming
  - Text → Claude mit STWEG-Kontext (FAQ, aktuelle Reklamationen, Verwaltung, Notfaelle)
  - Claude-Response → ElevenLabs TTS → zurueck zu Asterisk
- Eskalation: AI sagt "Ich verbinde dich" → ATXFER an Technik-Mobile (mit Briefing-SMS vorab)
- DSGVO: Anrufer-Hinweis ("Dieses Gespraech wird KI-gestuetzt bearbeitet")
- Knowledge-Base: STWEG-Daten via Tool-Calls
