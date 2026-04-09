# Infrastruktur — Rosenweg 4303 Kaiseraugst

## Übersicht

3-Node Proxmox Cluster mit Docker Swarm für die Rosenweg-Kooperation (8 STWEGs, ~60 Wohnungen).

```
Internet
    │
    ▼
Cloudflare (DNS, CDN, Tunnel, Email Routing)
    │
    ├── CF Tunnel ──► Docker Swarm (Website, API, Authentik, NetBox)
    ├── CF Email ──► Gmail (rosenweg4303@gmail.com)
    └── SMTP2GO ◄── API (Outbound Mail)
```

## Proxmox Hosts

| Host | IP (Netbird) | IP (LAN) | Rolle |
|------|-------------|-----------|-------|
| pve1 | 100.64.90.20 | 100.64.2.20 | Proxmox VE, meiste CTs |
| pve2 | 100.64.90.21 | 100.64.2.21 | Proxmox VE, DC + Docker |
| pve3 | 100.64.90.22 | 100.64.2.22 | Proxmox VE, Docker |

Zugriff auf LXC Container direkt via LAN-IP: `ssh root@100.64.2.20` (pve1), etc.

## LXC Container

### pve1 (100.64.2.20)

| CT | Name | IP | RAM | Disk | Funktion |
|----|------|----|-----|------|----------|
| 100 | proxmox-datacenter-manager | DHCP | 2GB | 10G | Proxmox Datacenter Manager |
| 102 | ntp3 | DHCP | 512MB | 8G | NTP Server |
| 103 | nextcloud-rosenweg-samba | 10.0.11.33 | 512MB | 8G | Nextcloud (alt) |
| 104 | n8n | DHCP | 2GB | 20G | n8n Automation (veraltet) |
| 105 | rk-mqtt-server | 10.0.2.32 | 1GB | 4G | MQTT Broker |
| 106 | fileserver | 100.64.2.28 | 1GB | 50G | Samba Fileserver (AD-Member) |
| 201 | docker-pve1 | 100.64.2.24 | 8GB | 100G | Docker Swarm Node |
| 901 | iobroker-technik | 100.64.90.50 | 2GB | 8G | ioBroker Hausautomation |

### pve2 (100.64.2.21)

| CT | Name | IP | RAM | Disk | Funktion |
|----|------|----|-----|------|----------|
| 108 | dc1 | 100.64.2.30 | 2GB | 20G | Samba AD Domain Controller |
| 202 | docker-pve2 | 100.64.2.25 | 8GB | 100G | Docker Swarm Node |
| 204 | scan-server | 100.64.139.71 | 512MB | 4G | Scan Server |
| 206 | fileserver-replica | 100.64.2.27 | 512MB | 50G | Fileserver Replikat (gestoppt) |

### pve3 (100.64.2.22)

| CT | Name | IP | RAM | Disk | Funktion |
|----|------|----|-----|------|----------|
| 101 | docker | DHCP | 2GB | 4G | Docker (alt) |
| 203 | docker-pve3 | 100.64.2.26 | 8GB | 100G | Docker Swarm Node |

## Docker Swarm

**3 Manager Nodes**, alle aktiv (docker-pve1, docker-pve2, docker-pve3).

### VIP (Virtual IP)
`100.64.2.27` — Sekundäre IP auf CT 201 (eth0), für externen Zugriff auf Authentik.

### Services

| Service | Replicas | Image | Ports |
|---------|----------|-------|-------|
| **rosenweg_website** | 3/3 | ghcr.io/rosenweg/rosenweg-website:latest | — |
| **rosenweg_api** | 1/1 | ghcr.io/rosenweg/rosenweg-api:latest | — |
| **rosenweg_traefik** | 1/1 | traefik:v3.2 | 80, 443 |
| **rosenweg_postgres** | 1/1 | postgres:17-alpine | — |
| **rosenweg_energy-db** | 1/1 | postgres:17-alpine | — |
| **rosenweg_energy-collector** | 1/1 | ghcr.io/rosenweg/energy-collector:latest | — |
| **rosenweg_doc-converter** | 1/1 | gotenberg/gotenberg:8 | — |
| **rosenweg_shepherd** | 1/1 | mazzolino/shepherd:latest | — |
| **authentik_server** | 1/1 | ghcr.io/goauthentik/server:2024.12 | 9000, 9443 |
| **authentik_worker** | 1/1 | ghcr.io/goauthentik/server:2024.12 | — |
| **authentik_postgresql** | 1/1 | postgres:17-alpine | — |
| **authentik_redis** | 1/1 | redis:7-alpine | — |
| **authentik_ldap** | 1/1 | ghcr.io/goauthentik/ldap:2024.12 | 389, 636 |
| **cloudflared_cloudflared** | 2/2 | cloudflare/cloudflared:latest | — |
| **netbox_netbox** | 1/1 | netboxcommunity/netbox:latest | 8000 |
| **netbox_netbox-worker** | 1/1 | netboxcommunity/netbox:latest | — |
| **netbox_postgres** | 1/1 | postgres:17-alpine | — |
| **netbox_redis** | 1/1 | redis:7-alpine | — |

### Overlay Networks

| Netzwerk | Funktion |
|----------|----------|
| rosenweg_rosenweg-net | Website, API, DBs, Traefik, Gotenberg |
| authentik_authentik-net | Authentik + DB + Redis |
| netbox_netbox-net | NetBox + DB + Redis |

### CIFS Volume (Dokumenten-Zugriff)

```
rosenweg_rosenweg-documents
  → //100.64.2.28/api
  → username=api-svc, domain=ROSENWEG, sec=ntlmsspi
  → Mounted in rosenweg_api als /documents
```

### Cronjobs (alle 3 Docker-CTs)

| Intervall | Script | Funktion |
|-----------|--------|----------|
| */5 Min | `/usr/local/bin/docker-ipvs-fix.sh` | ip_forward in Docker lb-Namespaces setzen |
| */2 Min | `/usr/local/bin/docker-service-watchdog.sh` | Ausgefallene Services automatisch neustarten |

## Active Directory

### Domain Controller (CT 108 — dc1)
- **Domain**: `AD.ROSENWEG4303.CH`
- **Workgroup**: `ROSENWEG`
- **IP**: 100.64.2.30
- **Forest Level**: Windows 2008 R2
- **37 Users**, **91 Groups** (aus Authentik synchronisiert)
- **Sync**: Authentik → AD alle 2 Minuten (`/opt/ad-sync/sync.py`)
- **Password API**: Port 8446, `ad-password-api.service` aktiv
  - Auth: `Bearer RwAdPwApi2026!`
  - Endpunkt: `POST http://100.64.2.30:8446/`

### Fileserver (CT 106 — fileserver)
- **Domain Member**: `ROSENWEG` (AD.ROSENWEG4303.CH)
- **IP**: 100.64.2.28
- **Dienste**: smbd, winbind, vsftpd (nmbd inaktiv)
- **Shares**:
  - `dokumente` → `/srv/documents` (valid users: @rosenweg)
  - `api` → `/srv/documents` (valid users: ROSENWEG\api-svc)
  - `scans` → `/srv/documents/Scans` (valid users: ROSENWEG\scanner)
- **FTP**: vsftpd, lokale Auth (kein Winbind)
  - User: `scanner`, Passwort: `****** (siehe .env)`
  - Chroot: `/srv/documents`, Scanner wechselt nach `scans/`
- **Disk**: 50GB, 5% belegt

## Authentik (SSO)

- **URL extern**: `https://authentik.rosenweg4303.ch` (via Cloudflare Tunnel)
- **URL intern**: `https://server:9443` (Docker-intern) oder `https://100.64.2.27:9443`
- **OAuth2 Provider**: Client ID `35oy6QKz0pjmNQGDeR97GDGhupMGNqWEgkGhIHtP`
- **Admin-Gruppe**: `Technik` (case-sensitive Check: `Technik` oder `technik`)
- **LDAP Outpost**: Port 389/636

### Wichtig
- Server-to-Server Calls müssen `AUTHENTIK_URL` (intern) nutzen, nicht die externe URL
- Browser-Redirects nutzen `AUTHENTIK_EXTERNAL_URL`
- `grant_type=password` ist NICHT aktiviert im OAuth2 Provider

## Email

### Inbound
- **MX**: Cloudflare Email Routing → Gmail (`rosenweg4303@gmail.com`)
- **IMAP-Polling**: API pollt Gmail alle 60s für Verteiler-Mails
- **Verteiler-Adressen**: `ausschuss@`, `technik@`, `praesident@`, etc.
- **DMARC-Reports**: `dmarc@rosenweg4303.ch` → Gmail DMARC-Ordner (107+ Reports)
- **Archiv**: `archiv@rosenweg4303.ch` → Gmail Archiv-Ordner + DB

### Outbound
- **SMTP2GO**: `mail-eu.smtp2go.com:2525` (TLS)
- **User**: `rk-website`
- **From**: `noreply@rosenweg4303.ch`

### DNS Records (Email)
- **SPF**: `v=spf1 include:_spf.mx.cloudflare.net include:spf.smtp2go.com ~all`
- **DKIM**: `s1102430._domainkey` → SMTP2GO, `cf2024-1._domainkey` → Cloudflare, `dkim._domainkey` → legacy
- **DMARC**: `p=quarantine; adkim=s; aspf=s; pct=100`

## Cloudflare

### Tunnel
- **ID**: `af2dc45e-2d4e-47cf-9d72-ac4ce71d96ec`
- **Replicas**: 2 (cloudflared)
- **Routes**:
  - `rosenweg4303.ch` / `www.rosenweg4303.ch` → Website
  - `authentik.rosenweg4303.ch` → Authentik

### DNS Records (Auswahl)

| Typ | Name | Ziel | Proxy |
|-----|------|------|-------|
| CNAME | rosenweg4303.ch | CF Tunnel | ☁️ |
| CNAME | www | CF Tunnel | ☁️ |
| CNAME | authentik | CF Tunnel | ☁️ |
| CNAME | netbox | CF Tunnel | ☁️ |
| A | mail | 138.199.226.209 | ⚡ |
| A | pve1 | 100.64.90.20 | ⚡ |
| A | pve2 | 100.64.90.21 | ⚡ |
| A | pve3 | 100.64.90.22 | ⚡ |
| MX | @ | route1/2/3.mx.cloudflare.net | ⚡ |

### Zone ID
`0b113bed342ed868b4b42c09149ea2b5`

## Deployment

### Website + API
1. `git push` → GitHub Actions Build
2. Images: `ghcr.io/rosenweg/rosenweg-website:latest`, `ghcr.io/rosenweg/rosenweg-api:latest`
3. Deploy: `ssh root@100.64.2.24 "docker service update --force --image ghcr.io/rosenweg/rosenweg-<service>:latest rosenweg_<service>"`

### Nginx Caching
- JS/CSS: `no-cache` (revalidate)
- Images/Fonts: 7 Tage, immutable

## Datenbanken

### rosenweg_postgres (API)
- **User**: `rosenweg`
- **Password**: `****** (siehe .env)`
- **DB**: `rosenweg`
- **Host**: `postgres` (Docker-intern)

### rosenweg_energy-db (Energie)
- **User**: `energy`
- **Password**: `****** (siehe .env)`
- **DB**: `energy`
- **Host**: `energy-db` (Docker-intern)

## Passwort-Sync

Passwort-Änderung über die Website (`/profil.html`) setzt das Passwort gleichzeitig in:
1. **Authentik** (via Admin API: `/core/users/{pk}/set_password/`)
2. **AD** (via Password API auf DC: `http://100.64.2.30:8446/`)

Der User muss nur einmal angemeldet sein (Session-Token) — altes Passwort wird nicht abgefragt.

## Monitoring

### Service Watchdog
Alle 2 Minuten auf allen 3 Docker-Nodes:
- Prüft `docker service ls` auf `running < desired`
- Startet ausgefallene Services automatisch neu
- Log: `/var/log/docker-watchdog.log`

### IPVS Fix
Alle 5 Minuten auf allen 3 Docker-Nodes:
- Setzt `net.ipv4.ip_forward=1` in Docker lb-Namespaces
- Verhindert Overlay-Netzwerk-Ausfälle nach Service-Neustarts
