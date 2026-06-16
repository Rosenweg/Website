# Deploy-Runbook — Standalone-PBX-API (CT 220)

Die PBX-Logik (Ring-Group, Geschäftszeiten, SIP-Telefone, Konferenz, Trunk-Status,
Call-Log) lebt **eigenständig in CT 220** neben Asterisk — analog zum WhatsApp-Gateway.
Die Haupt-API (`api/server.js`) behält nur die Voicemail-KI-Bridge (Whisper/Claude/
Mail/WhatsApp), die `transcribe_voicemail.py` direkt anspricht.

**Aktueller Stand der Umgebung (verifiziert 2026-06-16):** CT 220 läuft auf **pve1
(100.64.2.20)**, CT-IP **100.64.2.29** (README oben sagt pve2/100.64.2.30 — veraltet).
Trunk ist registriert; das alte pbx-admin zeigte „NICHT registriert", weil die Haupt-API
kein `PBX_AMI_SECRET` hatte. Die neue PBX-API löst das, weil sie das AMI lokal auf
`127.0.0.1:5038` anspricht und das Secret direkt aus `/etc/asterisk/manager.conf` liest.

---

## Komponenten

| Datei | Ziel im LXC | Zweck |
|---|---|---|
| `api/app.py`, `db.py`, `ami.py` | `/opt/pbx-api/` | Flask-Service (waitress) |
| `api/requirements.txt` | (venv) | Flask + requests + waitress |
| `api/pbx-api.service` | `/etc/systemd/system/` | systemd-Unit |
| `api/pbx-api.env.example` | `/etc/default/pbx-api` | Config (Pfade, MAIN_API_BASE) |
| `web/pbx-admin.html` | `/opt/pbx-api/web/` | Admin-UI (an pbx.rosenweg4303.ch) |
| `agi/*.py` | `/var/lib/asterisk/agi-bin/` | jetzt gegen `127.0.0.1:8095` |
| `asterisk-config/*.conf` | `/etc/asterisk/` | Dialplan + ConfBridge + pjsip-Include |

---

## Schritte (alle auf/über pve1)

### 1. Asterisk-Configs aktualisieren
```bash
# vom Repo-Root, via pve1 in den LXC
ssh root@100.64.2.20 'pct exec 220 -- mkdir -p /var/lib/asterisk/agi-bin'
# extensions.conf, pjsip.conf, confbridge.conf nach /etc/asterisk/
tar -C pbx/asterisk-config -cf - extensions.conf pjsip.conf confbridge.conf \
  | ssh root@100.64.2.20 'pct exec 220 -- tar -C /etc/asterisk -xf -'
# AGI-Scripts
tar -C pbx/agi -cf - pbx_get_ring_members.py pbx_check_hours.py pbx_log_call_event.py pbx_conf_invite.py \
  | ssh root@100.64.2.20 'pct exec 220 -- tar -C /var/lib/asterisk/agi-bin -xf -'
ssh root@100.64.2.20 'pct exec 220 -- chmod +x /var/lib/asterisk/agi-bin/*.py'
```

### 2. PBX-API installieren
```bash
ssh root@100.64.2.20 'pct exec 220 -- mkdir -p /opt/pbx-api/web /var/lib/pbx-api'
tar -C pbx/api -cf - app.py db.py ami.py voicemail.py migrate_from_postgres.py requirements.txt \
  | ssh root@100.64.2.20 'pct exec 220 -- tar -C /opt/pbx-api -xf -'
tar -C pbx/web -cf - pbx-admin.html \
  | ssh root@100.64.2.20 'pct exec 220 -- tar -C /opt/pbx-api/web -xf -'

ssh root@100.64.2.20 'pct exec 220 -- bash -lc "
  cd /opt/pbx-api
  python3 -m venv venv && venv/bin/pip install -r requirements.txt
  chown -R asterisk:asterisk /opt/pbx-api /var/lib/pbx-api
"'
```

### 3. Config + systemd
```bash
# /etc/default/pbx-api anlegen (MAIN_API_BASE etc.) — Vorlage: api/pbx-api.env.example
# PBX_SHARED_SECRET wird aus /etc/default/asterisk-env geerbt (gleicher Wert wie AGI).
# Fuer die Voicemail-KI zusaetzlich setzen: GROQ_API_KEY (oder OPENROUTER_API_KEY),
# OPENROUTER_API_KEY (Analyse), GATEWAY_SEND_URL + GATEWAY_API_KEY.
# GATEWAY_API_KEY = im WhatsApp-Gateway-UI (whatsapp.rosenweg4303.ch) einen
# benannten Key 'pbx-voicemail' anlegen (mg_...). Alias/Gruppe 'Rosenweg Technik'
# muss im Gateway aufloesbar sein.
scp pbx/api/pbx-api.service root@100.64.2.20:/tmp/   # dann in CT kopieren:
ssh root@100.64.2.20 'pct push 220 /tmp/pbx-api.service /etc/systemd/system/pbx-api.service'
ssh root@100.64.2.20 'pct exec 220 -- systemctl daemon-reload && systemctl enable --now pbx-api'
ssh root@100.64.2.20 'pct exec 220 -- curl -s localhost:8095/health'   # {"ok":true,...}
```

### 4. Datenmigration (Bestand → SQLite)  *(einmalig)*
```bash
# JSON-Dump aus Haupt-Postgres (auf einem Host mit psql-Zugriff):
psql "$PG_DSN" -At -c "SELECT json_build_object(
   'ring_members',COALESCE((SELECT json_agg(r) FROM pbx_ring_members r),'[]'),
   'config',      COALESCE((SELECT json_agg(c) FROM pbx_config c),'[]'),
   'calls',       COALESCE((SELECT json_agg(x) FROM pbx_calls x),'[]'))" > /tmp/pbx-dump.json
ssh root@100.64.2.20 'pct push 220 /tmp/pbx-dump.json /tmp/pbx-dump.json'
ssh root@100.64.2.20 'pct exec 220 -- bash -lc "cd /opt/pbx-api && PBX_DB_PATH=/var/lib/pbx-api/pbx.sqlite venv/bin/python migrate_from_postgres.py /tmp/pbx-dump.json"'
ssh root@100.64.2.20 'pct exec 220 -- chown asterisk:asterisk /var/lib/pbx-api/pbx.sqlite'
ssh root@100.64.2.20 'pct exec 220 -- systemctl restart pbx-api'
```

### 5. Asterisk neu laden  *(Schreibzugriff auf PBX — bewusst manuell)*
```bash
ssh root@100.64.2.20 'pct exec 220 -- bash -lc "
  asterisk -rx \"manager reload\"     # behebt das AMI-Auth-Problem (lädt manager.conf-Secret)
  asterisk -rx \"dialplan reload\"
  asterisk -rx \"module reload res_pjsip.so\"   # zieht pjsip_phones.conf
  asterisk -rx \"module load app_confbridge.so\" 2>/dev/null; true
  asterisk -rx \"confbridge reload\"             # Bridge/User/Menu-Profile (Konferenz + *100)
"'
# Asterisk muss Call-Files schreiben/lesen koennen (Konferenz-Einladungen):
ssh root@100.64.2.20 'pct exec 220 -- bash -lc "mkdir -p /var/spool/asterisk/tmp /var/spool/asterisk/outgoing && chown -R asterisk:asterisk /var/spool/asterisk"'
```
> `pjsip_phones.conf` wird von der PBX-API beim Anlegen des ersten SIP-Telefons erzeugt
> (+ `pjsip reload`). Vorher ist das `#include` leer → nur eine Asterisk-Warnung.

### 6. pbx.rosenweg4303.ch erreichbar machen  *(Infra, gated)*
- **Cloudflare DNS**: `pbx` → CF-Tunnel (proxied, HTTP). **SIP bleibt LAN/VPN**, kommt NICHT über CF.
- **CF-Tunnel-Ingress**: `pbx.rosenweg4303.ch` → `http://100.64.2.29:8095`.
- **Authentik**: Redirect-URI `https://pbx.rosenweg4303.ch/api/auth/callback` ergänzen.
- **Haupt-API** `api/lib/config.js`: Host in `OAUTH_ALLOWED_HOSTS` aufnehmen (wie isp/whatsapp).
- Danach: pbx-admin nicht mehr unter `www.rosenweg4303.ch/pbx-admin`, sondern unter `pbx.rosenweg4303.ch`.

### 7. Haupt-API aufräumen  *(später, separat)*
Wenn die PBX-API produktiv ist: die `/api/pbx/*`-Endpoints (Ring/Config/Trunk/Calls) in
`api/server.js` deprecaten/entfernen. **Bleiben muss** nur `/api/pbx/voicemail` +
`/api/pbx/call-notify` (KI/Mail/WA-Bridge). Tabellen `pbx_ring_members`/`pbx_config`/
`pbx_calls` nach erfolgreicher Migration droppen.

---

## SIP-Telefon einrichten (Nutzer)
1. Im pbx-admin unter **SIP-Telefone** Extension + Name anlegen (Passwort wird generiert).
2. Am Telefon/Softphone: Server/Domain **100.64.2.29**, Port **5060/UDP**, Benutzer = Extension,
   Passwort wie angezeigt. Transport UDP. Nur im LAN/VPN.
3. Telefon als Ring-Mitglied (Typ **SIP-Telefon**) hinzufügen, optional „klingelt immer".
4. Test: **1000** (Echo), **100** (Technik-Konferenz).

## Konferenz & Eskalation
- **100** an einem SIP-Telefon → Technik-Konferenz (Raum `technik`), alle aktiven
  Ring-Member werden per Call-File dazugeholt (ausser der Anrufer selbst).
- **\*100** mitten in einem angenommenen EINGEHENDEN Anruf (auch vom Handy) → holt
  die Gruppe live in denselben (stillen) Konferenzraum. Möglich, weil angenommene
  Inbound-Calls über `answered-conf` als 2er-ConfBridge laufen.

## Voicemail-KI (autark)
- `transcribe_voicemail.py` postet die WAV an die **lokale** PBX-API → Whisper (Groq)
  → Claude-Analyse → **WhatsApp direkt via Gateway** (`/gateway/send`, keyed) an
  „Rosenweg Technik" (Text + Audio) → Speicherung im Call-Log. Auto-Reklamation nur
  wenn `FORWARD_VOICEMAIL_URL` gesetzt ist (sonst bleibt die PBX autark).

## Verifikation (ohne echte Sends an Bewohner)
- `curl localhost:8095/health` → ok.
- pbx-admin öffnen → Trunk zeigt **● Registriert** (nach `manager reload`).
- SIP-Telefon registrieren → `asterisk -rx "pjsip show contacts"` zeigt es als `Avail`.
- **1000** wählen → Echo. **100** → Konferenz. **\*100** im laufenden Test-Inbound-Call.
- Voicemail: Testanruf ausserhalb der Zeit auf eine **Testnummer** → Nachricht →
  WhatsApp-Push in einer **Test-Gruppe** (Gateway-Alias temporär umbiegen), NICHT
  in die echte Bewohner-/Technik-Gruppe.
- **Hinweis:** `*100`-Eskalation (ConfBridge-Menu + Dial-G + DTMF vom Handy über
  peoplefone) am Gerät live testen — DTMF-Erkennung hängt vom Carrier-RTP ab.
