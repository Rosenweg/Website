# Rosenweg PBX (Asterisk)

Telefonanlage fuer die +41 61 551 01 52 (peoplefone-SIP-Trunk). Laeuft NICHT in Docker, sondern in einem dedizierten LXC (CT 220). Begruendung: SIP/RTP-NAT in Docker = Aerger, LXC hat klassische Netzwerk-Semantik + native apt-Verwaltung.

> **Stand 2026-06-16 — eigenstaendige PBX-API.** Die komplette PBX-Steuerung lebt
> jetzt als **Standalone-Python-Service in CT 220** (`pbx/api/`, eigene SQLite) —
> nicht mehr in der Haupt-API:
> - Ring-Group + **Zeitsperre pro Mitglied** (`bypass_hours`, „klingelt immer")
> - **SIP-Telefone (LAN/VPN)** — Verwaltung im UI, generiert `pjsip_phones.conf`
> - **Technik-Konferenz**: `100` am SIP-Telefon, **`*100`** als Mid-Call-Eskalation
> - **Voicemail-KI autark**: Whisper (Groq) → Claude-Analyse → **WhatsApp direkt
>   via Gateway** (`/gateway/send`) → Call-Log. Auto-Reklamation optional per Webhook.
> - Trunk-Status (lokales AMI), Test-Call, Call-Log
>
> Admin-UI vom selben Container serviert: **`pbx.rosenweg4303.ch`**. Die Haupt-API
> ist nur noch optionaler Webhook-Empfaenger (Auto-Reklamation). **Deploy +
> Migration: [DEPLOY-PBX-API.md](DEPLOY-PBX-API.md).** CT 220 laeuft aktuell auf
> **pve1 (100.64.2.20)**, CT-IP **100.64.2.29**.

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
API_BASE=http://100.64.2.52:3000
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

## SIP-Transporte (Stand 2026-09-09)

Asterisk lauscht auf drei Transporten:

| Transport | Bind | Von aussen erreichbar | Wofuer |
|---|---|---|---|
| `transport-udp` | `0.0.0.0:5060` | **ja** (UDM-Forward udp/5060) | peoplefone-Trunk |
| `transport-tcp` | `0.0.0.0:5060` | nein | WLAN-Telefone im LAN/VPN |
| `transport-tls` | `0.0.0.0:5061` | nein | WLAN-Telefone, verschluesselt |

**Warum TCP/TLS.** Ein WLAN-Smartphone verliert seine UDP-/NAT-Bindung, sobald es
in Doze geht — die Registrierung sieht aus Asterisks Sicht noch gueltig aus, aber
das eingehende INVITE kommt nicht mehr an. Eine offene TCP-Verbindung ueberlebt
das. Deshalb bei Softphones (Linphone) **TCP** statt UDP waehlen, plus Ausnahme
von der Akku-Optimierung und ein kurzes Register-Expiry (60-180 s).

Die Endpoints in `pjsip_phones.conf` setzen **kein** `transport=` — Asterisk
antwortet auf dem Transport, ueber den sich das Telefon registriert hat. Es muss
also nichts pro Nebenstelle umgestellt werden.

**Zertifikat.** Let's Encrypt fuer `sip.rosenweg4303.ch`, per certbot mit
DNS-01 ueber Cloudflare direkt in CT 220 (`/root/.cloudflare.ini`, Token aus
CT 245 kopiert). Der Deploy-Hook
`/etc/letsencrypt/renewal-hooks/deploy/asterisk.sh` kopiert das erneuerte
Zertifikat nach `/etc/asterisk/keys/sip.{crt,key}` — noetig, weil
`/etc/letsencrypt/archive` `0700 root` ist und Asterisk als `asterisk` laeuft —
und macht `module reload res_pjsip`. Renewal uebernimmt `certbot.timer`.

`sip.rosenweg4303.ch` existiert **nur im internen Split-Horizon** (UniFi
static-dns → `100.64.2.55`), nicht in der oeffentlichen Zone. DNS-01 braucht
keinen A-Record, also bleibt die interne IP privat.

**Seit 12.09.2026 eingeschraenkt.** Die Portweiterleitung `udp/5060` stand auf
`src: any`. Die Scanner, die dort anklopften, liessen die Asterisk- und
fail2ban-Logs auf 4.4 GB wachsen, bis die Wurzel des Containers voll war. Die
Regel heisst jetzt `Asterisk-SIP peoplefone (udp/5060)` und hat
`src = 95.128.80.0/25`, `src_limiting_enabled = true`.

Warum genau dieses Netz: RIPE fuehrt `95.128.80.0 - 95.128.80.127` als
`netname: PEOPLEFONE`. Und vor allem — **Asterisk akzeptiert ueber
`pjsip identify` ohnehin nur 95.128.80.3/.5/.7**. Die Firewall-Regel ist damit
*weiter* als die Pruefung, die auf der Anwendungsebene schon greift: sie kann
keinen Anruf verhindern, der vorher durchkam. Ein /25 statt drei /32 gewaehlt,
damit ein zusaetzlicher peoplefone-Server nicht stillschweigend ausgesperrt wird.

Nach der Aenderung: Trunk weiter `Registered`, Gegenstelle `Avail` mit 2.9 ms.

**Noch offen:** `tcp/5061` ist von aussen nicht freigegeben. Telefone koennen
sich daher nur im WLAN/VPN registrieren, nicht von unterwegs.

## Linphone-Provisionierung (QR bei den Nebenstellen)

Im pbx-Admin-UI hat jede Nebenstelle einen Knopf **📱 QR**. Dahinter:

1. `POST /api/pbx/sip-extensions/<ext>/provisioning` (Technik/Praesident) legt ein
   **Einmal-Token** mit 15 Minuten Frist an und liefert ein serverseitig
   gerendertes SVG (`segno`) — kein Fremd-Skript im UI.
2. Der QR enthaelt nur `https://pbx.rosenweg4303.ch/prov/<token>`.
3. Am Telefon: Linphone → Assistent → **„Fetch Remote Configuration"** → scannen.
4. `GET /prov/<token>` liefert die linphonerc-XML und **verbrennt das Token**.
   Unbekannt, abgelaufen und verbraucht geben dieselbe 404 — der Zustand eines
   Links soll sich nicht abfragen lassen.

Die XML setzt Konto, `transport=tcp`, `reg_expires=120` und schaltet Video ab.
Steuerung ueber `/etc/default/pbx-api` (`PBX_SIP_HOST`, `PBX_SIP_TRANSPORT`,
`PBX_SIP_REG_EXPIRES`, `PBX_PROV_TTL_MIN`); die Vorgaben im Code passen bereits
zur Anlage, es muss nichts gesetzt werden.

**Warum Einmal-Token.** In der XML steht das SIP-Passwort im Klartext — anders
geht Provisionierung nicht. Also ist die URL selbst das Geheimnis, und sie darf
nur einen einzigen Abruf ueberleben. Ein ausgedruckter oder weitergeleiteter QR
ist danach wertlos.

### Zentrales Telefonbuch (CardDAV)

`contacts-sync` haelt in Nextcloud das komplette Verzeichnis unter
`addressbooks/users/kontakte/rosenweg/` (Stand 2026-09-09: 171 Eintraege).
Linphone fragt das als *Remote Contact Directory* direkt ab — kein DAVx5, keine
Systemkontakte. Der Abschnitt wandert automatisch in jede Provisioning-XML.

Konfiguriert in `/etc/default/pbx-api`:

```
PBX_CARDDAV_URL=https://nextcloud.rosenweg4303.ch/remote.php/dav/addressbooks/users/kontakte/rosenweg/
PBX_CARDDAV_USER=kontakte
PBX_CARDDAV_PASS=<occ user:add-app-password kontakte>
PBX_CARDDAV_REALM="Nextcloud des Rosenweg Kaiseraugst"
```

**Warum genau diese Schluessel.** Feature-Wiki und SDK-Doku widersprechen sich,
also entscheidet der Quellcode: `Core::reloadRemoteContactDirectories()` sucht
Sektionen mit Praefix **`carddav_`**, und `CardDavParams::readFromConfigFile()`
liest `server_url`, `results_limit`, `min_characters`, `timeout`,
`fields_for_user_input`, `fields_for_domain`, `use_exact_match_policy` — mehr
nicht. `enabled`, `type` und `uri` gibt es dort **nicht**.

**Warum ein zweiter auth_info-Block.** Der CardDAV-Client ruft nie
`setAuthInfo()`; beim 401 sucht liblinphone eine passende `LinphoneAuthInfo`
ueber **Realm und Host**. Darum `auth_info_1` mit `realm` = dem Realm aus dem
`WWW-Authenticate`-Header und `domain` = dem Nextcloud-Host.

**Der Hostname ist nicht beliebig.** `contacts-sync` spricht intern per HTTP mit
`Host: nextcloud.rosenweg9.ch` — dieser Name hat am Edge **keinen Traefik-Router**
und liefert nach aussen das TRAEFIK-DEFAULT-CERT. Fuer die Telefone gilt darum
`nextcloud.rosenweg4303.ch`, der ein gueltiges Zertifikat hat.

**Es gibt zwei CardDAV-Funktionen, und nur eine ist provisionierbar.**

| | `[carddav_0]` (provisioniert) | CardDAV-Adressbuch in den App-Einstellungen |
|---|---|---|
| liblinphone-Begriff | RemoteContactDirectory | FriendList vom Typ CardDAV |
| gespeichert in | `linphonerc` | `friends.db` (SQLite) |
| per QR lieferbar | **ja** | **nein** |
| Anzeige | Treffer beim Suchen ab 3 Zeichen | vollstaendige Liste, offline verfuegbar |

Das erklaert den Eindruck „Linphone hat CardDAV nicht eingerichtet": unter
Einstellungen → Kontakte listet die App ihre **FriendLists** auf, und dort steht
nichts, weil `carddav_0` eine andere Sache ist. Ob die Provisionierung
funktioniert hat, sieht man nur, indem man im Kontakte-Tab **drei Zeichen
tippt** — dann fragt `MagicSearch.Source.RemoteCardDAV` den Server ab
(`ContactsListViewModel.kt`), und im Apache-Log von CT 104 taucht ein REPORT auf.

Die FriendList laesst sich nicht mitliefern, weil sie nie in die Konfigurations-
datei geschrieben wird (`friend-list.cpp` kennt kein `writeToConfigFile`). Darum
zeigt das QR-Fenster die fuenf Werte zum Kopieren an — einmal pro Geraet unter
Einstellungen → Kontakte → *CardDAV-Adressbuch hinzufuegen* eintragen.

**Berechtigung.** Das App-Passwort gehoert dem Konto `kontakte` und kann damit
auch schreiben — Nextcloud kann App-Passwoerter nicht auf lesend einschraenken.
Fuer eigene, dedizierte Geraete vertretbar; es haengt unter dem Namen
„SIP-Telefone (Linphone)" in den Nextcloud-Sicherheitseinstellungen und ist dort
mit einem Klick widerrufbar.

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
