# Rosenweg Kooperation - Systemuebersicht

> Stand: 2026-04-10 | ~120 API-Endpunkte, 8 STWEGs, 50+ Seiten, 3 Datenbanken, 15+ Docker-Services

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

### Docker Services (Live-Stand 2026-04-10)

| Service | Replicas | Image |
|---------|----------|-------|
| rosenweg_website | 3/3 | ghcr.io/rosenweg/rosenweg-website:latest |
| rosenweg_api | 1/1 | ghcr.io/rosenweg/rosenweg-api:latest |
| rosenweg_postgres | 1/1 | postgres:17-alpine |
| rosenweg_energy-collector | 1/1 | ghcr.io/rosenweg/energy-collector:latest |
| rosenweg_energy-db | 1/1 | postgres:17-alpine |
| rosenweg_syslog-collector | 1/1 | ghcr.io/rosenweg/syslog-collector:latest |
| rosenweg_tv-proxy | 1/1 | ghcr.io/rosenweg/tv-proxy:latest |
| rosenweg_doc-converter | 1/1 | gotenberg/gotenberg:8 |
| rosenweg_traefik | 1/1 | traefik:latest |
| rosenweg_shepherd | 1/1 | mazzolino/shepherd:latest |
| authentik_server | 1/1 | ghcr.io/goauthentik/server:2024.12 |
| authentik_worker | 1/1 | ghcr.io/goauthentik/server:2024.12 |
| authentik_ldap | 1/1 | ghcr.io/goauthentik/ldap:2024.12 |
| authentik_postgresql | 1/1 | postgres:17-alpine |
| authentik_redis | 1/1 | redis:7-alpine |
| cloudflared_cloudflared | 2/2 | cloudflare/cloudflared:latest |
| netbox_netbox | 1/1 | netboxcommunity/netbox:latest |
| netbox_netbox-worker | 1/1 | netboxcommunity/netbox:latest |
| netbox_postgres | 1/1 | postgres:17-alpine |
| netbox_redis | 1/1 | redis:7-alpine |
| netbox_collector | 1/1 | netbox-collector:latest |

### Plattform

| Faehigkeit | Status | Ort |
|-----------|--------|-----|
| Docker Swarm (3 Manager-Nodes) | Implementiert | docker-pve1/2/3 (CT 201-203) |
| Traefik Reverse Proxy + Let's Encrypt | Implementiert | Port 80/443 |
| Cloudflare Tunnel (2 Replicas) | Implementiert | Externer Zugang |
| Gotenberg (Dokument-Konvertierung) | Implementiert | LibreOffice + Chromium |
| Service Watchdog (auto-restart) | Implementiert | Cron alle 2min |
| IPVS-Fix (Overlay-Netzwerk) | Implementiert | Cron alle 5min |
| Shepherd (Auto-Image-Updates) | Implementiert | Prueft regelmaessig auf neue Images |
| Healthchecks (pro Service) | Implementiert | Docker Healthcheck |
| Resource Limits (Memory) | Implementiert | docker-stack.yml |
| NetBox (Netzwerk-Dokumentation) | Implementiert | Port 8000 (3 Services) |

### LXC Container (Proxmox)

| CT | Name | IP | Funktion |
|----|------|-----|----------|
| 201 | docker-pve1 | 100.64.2.24 | Docker Swarm Manager (VIP) |
| 202 | docker-pve2 | 100.64.2.25 | Docker Swarm Manager |
| 203 | docker-pve3 | 100.64.2.26 | Docker Swarm Manager |
| 105 | authentik | 100.64.2.25 | SSO (im Swarm) |
| 106 | fileserver | 100.64.2.28 | Samba/CIFS Fileserver |
| 108 | samba-ad-dc | 100.64.2.30/31 | Active Directory DC |
| 113 | claw-document-manager | 100.64.2.33 | OpenClaw AI Agent |

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
- **15+ Docker-Services** auf 3 Swarm-Nodes
- **Compliance**: FPUEV (6 Monate Verbindungslog), DMARC, Email-Archiv
- **Backup**: Stuendlich nach GitHub mit Alert bei Fehler
