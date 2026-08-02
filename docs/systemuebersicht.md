# Rosenweg Kooperation - Systemuebersicht

> Stand: 2026-08-02 | ~120 API-Endpunkte, 8 STWEGs, 50+ Seiten, 3 Datenbanken
>
> Die Fachkapitel stammen vom 10. April 2026 und sind seither nicht nachgemessen.
> Nachgemessen ist der Abschnitt [Infrastruktur](#infrastruktur).

## Website & Bewohner-Portal

| Faehigkeit | Status | Ort |
|-----------|--------|-----|
| Startseite mit Login | Implementiert | `index.html` |
| Benutzerprofil (Passwort, Avatar, Daten) | Implementiert | `profil.html`, `/api/auth/me`, `/api/change-password` |
| Authentik OAuth2 SSO Login/Logout | Implementiert | `/api/auth/login`, `/api/auth/callback` |
| Bewohner-Navigation (8 STWEGs) | Implementiert | `js/nav.js`, `stweg1-8/` |
| Kiosk-Anzeige (Tuerschilder) | Implementiert | `door-signs/`, `kiosk/` |
| Avatar-Upload | Implementiert | `/api/auth/avatar` |

## Verwaltung & Administration

| Faehigkeit | Status | Ort |
|-----------|--------|-----|
| Benutzerverwaltung (Authentik + AD) | Implementiert | `verwaltung.html`, `/api/admin/users` |
| Wohnungsverwaltung (pro STWEG, Import) | Implementiert | `objektverwaltung.html`, `/api/wohnungen/:stweg` |
| Authentik <-> AD Sync | Implementiert | `/api/wohnungen/sync-authentik` |
| Rechteverwaltung (Permissions-Matrix) | Implementiert | `rechteverwaltung.html`, `/api/permissions` |
| Kontakte pro STWEG | Implementiert | `/api/kontakte/:stweg` |
| Proxmox-Verwaltung (VMs, ACL) | Implementiert | `proxmox-verwaltung.html`, `/api/proxmox/*` |
| Passwort-Sync (Authentik + AD gleichzeitig) | Implementiert | `/api/change-password` |
| Projekte (Abstimmungen, Kandidaten, Timeline) | Implementiert | `projekte.html`, `/api/projects/*` |
| Kalender (Google Calendar ICS) | Implementiert | `/api/calendar` |
| Oeffentliche Ausschuss/Technik-Seite | Implementiert | `/api/public/ausschuss`, `/api/public/technik` |

## Email-System

| Faehigkeit | Status | Ort |
|-----------|--------|-----|
| Email-Verteiler (ausschuss, technik, stweg1-8 etc.) | Implementiert | `email-verteiler.html`, `/api/verteiler` |
| IMAP-Polling (Gmail, alle 60s) | Implementiert | server.js setInterval |
| Verteiler-Weiterleitung via SMTP2GO | Implementiert | `/api/verteiler/send` (Rate-Limit: 10/10min) |
| Email-Archiv (archiv@ -> DB + Dateien) | Implementiert | `email-archiv.html`, `/api/email-archive` |
| DMARC-Report-Parsing (ZIP/GZ -> XML) | Implementiert | `dmarc.html`, `/api/dmarc/reports` |
| Email-Zustellberichte (Delivery Report) | Implementiert | SMTP2GO Activity API (nur intern) |
| Email-Quota (SMTP2GO Kontingent) | Implementiert | `/api/email/quota` |
| Email-Log (Sendungen, Status) | Implementiert | `/api/email/log` |

## Mail-to-Print

| Faehigkeit | Status | Ort |
|-----------|--------|-----|
| Druck via Email (druckerr9@, druckerr13@) | Implementiert | IMAP-Poller -> CUPS |
| Absender-Whitelist (DB + Authentik) | Implementiert | Exakter Email-Match |
| Deckblatt (Gotenberg HTML->PDF) | Implementiert | Empfaenger, Adresse, QR-Code |
| Empfaenger-Tag (+name in Email) | Implementiert | z.B. druckerr9+ingrid.limbach@ |
| Pickup-Bestaetigung (QR-Code) | Implementiert | `abholung.html`, `/api/pickup/:token` |
| Benachrichtigung (Technik + Praesident) | Implementiert | Bei getaggten Druckauftraegen |

## Energie-Monitoring

| Faehigkeit | Status | Ort |
|-----------|--------|-----|
| Stromzaehler-Erfassung (Modbus TCP, 5s) | Implementiert | energy-collector (13 Zaehler RW9) |
| Verbrauch pro Wohnung/Haus | Implementiert | `energie-monitor.html` |
| Zaehler-Konfiguration | Implementiert | `energie-config.html`, `zaehler.html` |
| Tarif-Management (Netz/Solar) | Implementiert | `/api/energy/tariffs` |
| Ueberschuss-Daten (Echtzeit) | Implementiert | `/api/energy/surplus` |
| LaMetric-Integration | Implementiert | `/api/energy/lametric` |
| Shelly-Steuerung (Surplus-basiert) | Implementiert | `scripts/shelly-surplus-switch.js` |
| Zaehler-Benutzer-Mapping | Implementiert | `/api/energy/meters/:id/users` |
| Export (CSV) | Implementiert | `/api/energy/export/:meterId` |
| Vergleich & Projektion | Implementiert | `/api/energy/compare`, `/api/energy/projection` |

## Netzwerk & ISP

| Faehigkeit | Status | Ort |
|-----------|--------|-----|
| WLAN-Passwoerter (PPSK pro Gebaeude) | Implementiert | `wlan.html`, `/api/wifi` |
| TV7 Web-Client (HLS Proxy) | Implementiert | `tv.html`, `/api/tv/channels`, `/api/tv/stream` |
| ISP-Uebersicht (Init7) | Implementiert | `isp.html` |
| Netzwerk-Admin (UniFi Geraete/Clients) | Implementiert | `netzwerk.html` |
| DMARC-Reports | Implementiert | `dmarc.html` |
| FPUEV Verbindungsnachweis | Implementiert | `verbindungen.html`, `/api/connections` |
| Syslog-Collector (UDP/TCP) | Implementiert | Port 5514, Firewall+WiFi+DHCP+NAT Events |
| Connection-Polling (UniFi, alle 5min) | Implementiert | Connect/Disconnect/Snapshot Events |
| CSV-Export Verbindungen | Implementiert | `/api/connections` mit Download |

## Waschkueche

| Faehigkeit | Status | Ort |
|-----------|--------|-----|
| Raeume verwalten | Implementiert | `/api/wasch/rooms` |
| Reservierungen (Einzel + Serie) | Implementiert | `waschkueche-reservierung.html` |
| Meine Reservierungen | Implementiert | `/api/wasch/my/reservations` |
| Tuerzugang (RFID-Freischaltung) | Implementiert | `/api/wasch/admin/doors` |
| Kostenverfolgung pro Benutzer | Implementiert | `/api/wasch/my/costs` |
| Monatliche Abrechnung (Cron am 1.) | Implementiert | `/api/wasch/admin/billing/run` |
| Waschkuechen-Poster (A4/Kiosk) | Implementiert | `waschkueche-poster.html` |
| Admin-Dashboard | Implementiert | `waschkueche-admin.html` |

## Dokumente & Fileserver

| Faehigkeit | Status | Ort |
|-----------|--------|-----|
| Dokumenten-Browser (Samba/CIFS) | Implementiert | `/api/documents/*` |
| Upload/Download/Loeschen | Implementiert | POST/GET/DELETE `/api/documents/*` |
| Ordner erstellen/verschieben | Implementiert | `/api/documents/folder`, `/api/documents/move` |
| Datei-Vorschau (DOCX/XLSX -> PDF) | Implementiert | Gotenberg LibreOffice Konvertierung |
| Scanner-Upload (FTP -> API) | Implementiert | `/api/scan-upload` |
| Berechtigungen pro Ordner/STWEG | Implementiert | Rollenbasiert |
| Git-Backup nach GitHub (stuendlich) | Implementiert | Cron + `doc-github-backup.sh` |
| Backup-Alert bei Fehler (Email) | Implementiert | SMTP2GO Alert an Technik |
| Papierkorb (.recycle, 30 Tage) | Implementiert | Cron-Cleanup |

## Sicherheit & Authentifizierung

| Faehigkeit | Status | Ort |
|-----------|--------|-----|
| Authentik OAuth2 SSO | Implementiert | authentik.rosenweg4303.ch |
| Active Directory (Samba DC) | Implementiert | CT 108 (100.64.2.30) |
| LDAP-Outpost (Port 389/636) | Implementiert | Authentik Service |
| OTP-Login (SMS/Email) | Implementiert | `/api/otp/send`, `/api/otp/verify` |
| Token-Introspection (Cache 1min) | Implementiert | Bearer Token Validation |
| Admin-Check (Technik/Praesident) | Implementiert | Middleware `adminOnly` |
| STWEG-Zugriffssteuerung | Implementiert | Middleware `requireStwegAccess` |
| CORS (nur rosenweg4303.ch) | Implementiert | Origin-Whitelist |
| Rate-Limiting (Verteiler, OTP) | Implementiert | In-Memory Throttle |
| HMAC-signierte TV-Proxy-Tokens | Implementiert | Kurzlebig, kein Session-Leak |

## Infrastruktur

> **Der Docker Swarm ist Geschichte.** Bis April 2026 lief alles als Stack auf
> drei Manager-Nodes (`docker-pve1/2/3`, CT 201-203, `100.64.2.24-26`). Diese
> Container gibt es nicht mehr, die Adressen antworten nicht. Heute hat jeder
> Dienst seinen eigenen LXC. Was unten steht, ist am **2. August 2026**
> nachgemessen — `pct list` auf pve1/2/3 und je ein Verbindungstest.

### Proxmox-Hosts

| Host | IP | Rolle |
|------|-----|-------|
| pve1 | 100.64.2.20 | Backend, Frontends, Mail, Router-CTs |
| pve2 | 100.64.2.21 | Fileserver, Domänencontroller, Authentik |
| pve3 | 100.64.2.22 | Traefik am Rand, PBX, Druck, Gateways |

### LXC Container (gemessen 2026-08-02)

**pve1**

| CT | Name | IP | Funktion |
|----|------|-----|----------|
| 128 | core-backend | 100.64.2.52 | **Rosenweg-API** (Port 3000, `/api/health` antwortet) |
| 129 | energy-stack | 100.64.2.53 | Energie-Erfassung (Port 3001) |
| 118 | fe-www | 100.64.2.41 | Startseite |
| 119-127, 130 | fe-stweg1-7, fe-meg, fe-isp, fe-pwa | 100.64.2.42-50, .54 | je ein Frontend pro STWEG bzw. Bereich |
| 105 | rk-mqtt-server | 100.64.2.51 | MQTT-Broker (Anzeigen, Stationen) |
| 104 | nextcloud | 100.64.2.36 | Nextcloud |
| 240 | mailcow | 100.64.2.33 | Mailserver |
| 109 | tv-proxy | 100.64.9.24 | TV-Proxy |
| 113 | vpn-wg | 100.64.2.34 | WireGuard-Gateway in alle Benutzernetze |
| 500-518 | rw*-usernetze-router | 100.64.x.250 | je ein Router pro Haus |

**pve2**

| CT | Name | IP | Funktion |
|----|------|-----|----------|
| 106 | fileserver | 100.64.2.28 | Samba/CIFS — Homes und `dokumente` |
| 206 | fileserver2 | 100.64.2.27 | Replikat |
| 108 | dc1 | 100.64.2.30 | Active Directory (`AD.ROSENWEG4303.CH`) |
| 114 | authentik | 100.64.2.37 | SSO (Port 9443) |
| 131 | core-messenger | 100.64.2.56 | Messenger-Backend |
| 260 | nfs-shared | 100.64.2.35 | NFS |

**pve3**

| CT | Name | IP | Funktion |
|----|------|-----|----------|
| 245 | edge-traefik | 100.64.2.40 | Reverse Proxy, Port 80/443 |
| 220 | asterisk-pbx | 100.64.2.55 | Telefonanlage |
| 111 | cups-server | 100.64.2.32 | Druckserver |
| 230 | pmg | 100.64.2.31 | Proxmox Mail Gateway |
| 116 | whatsapp-bridge | 100.64.2.39 | WhatsApp-Anbindung |
| 115 | zpush | 100.64.2.38 | ActiveSync |

**Noch nicht nachgesehen:** was in CT 101 (`docker`, pve1) läuft, und wo NetBox,
Gotenberg und der Cloudflare-Tunnel heute liegen. Sie standen im Swarm; dass
sie noch laufen, ist damit nicht belegt.

### Plattform

| Faehigkeit | Status | Ort |
|-----------|--------|-----|
| Ein LXC je Dienst | Implementiert | siehe Tabellen oben |
| Traefik Reverse Proxy + Let's Encrypt | Implementiert | CT 245 `edge-traefik`, Port 80/443 |
| Gotenberg (Dokument-Konvertierung) | Unklar | lief im Swarm; heutiger Ort nicht geprüft |
| Cloudflare Tunnel | Unklar | lief im Swarm; heutiger Ort nicht geprüft |
| NetBox (Netzwerk-Dokumentation) | Unklar | lief im Swarm; heutiger Ort nicht geprüft |

Die frühere Swarm-Mechanik — Shepherd für Auto-Image-Updates, der
Service-Watchdog, der IPVS-Fix fürs Overlay-Netz, Replica-Zahlen — ist mit dem
Swarm entfallen. `docker-stack.yml`, [`infrastruktur.md`](infrastruktur.md) und
[`cloudflare.md`](cloudflare.md) im selben Repo beschreiben sie noch; sie sind
nicht nachgeführt.

## OpenClaw Dokumenten-Manager

> CT 113 heisst heute `vpn-wg` (100.64.2.34). Der Dokumenten-Manager läuft dort
> nicht mehr — wo er hingekommen ist, wurde nicht ermittelt.

## OpenClaw Dokumenten-Manager

| Faehigkeit | Status | Ort |
|-----------|--------|-----|
| AI-Agent (Claude Sonnet 4.6 via OpenRouter) | Implementiert | CT 113 (100.64.2.33) |
| Telegram-Bot (@rkdokubot) | Implementiert | Pairing mit User 575184440 |
| Dokumenten-Klassifizierung | Implementiert | AGENT.md Regeln |
| STWEG-Zuordnung nach Hausnummer | Implementiert | AGENT.md Mapping |
| Zugriff auf Fileserver (/srv/documents) | Implementiert | CIFS-Mount |
| Zugriff auf Website-Repo | Implementiert | Git-Klon unter /opt/claw-workspace/repos/ |

---

## Zusammenfassung

- **~120 API-Endpunkte** in server.js + energy-collector
- **8 STWEGs**, ~60 Wohnungen, 16 Haeuser
- **3 Datenbanken**: Rosenweg (PostgreSQL), Energy (PostgreSQL), SQLite (Sessions)
- **Ein LXC je Dienst** auf pve1/2/3 — der Docker Swarm ist abgeloest
- **Compliance**: FPUEV (6 Monate Verbindungslog), DMARC, Email-Archiv
- **Backup**: Stuendlich nach GitHub mit Alert bei Fehler
