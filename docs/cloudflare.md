# Cloudflare — Rosenweg

## Zone

- **Domain**: `rosenweg4303.ch`
- **Zone ID**: `0b113bed342ed868b4b42c09149ea2b5`
- **API Token**: `mroiX7XyATokA65Txk9g1k60nm1DhwxOv5Nm-U53`

## Tunnel

- **Tunnel ID**: `af2dc45e-2d4e-47cf-9d72-ac4ce71d96ec`
- **Replicas**: 2 (Docker Service `cloudflared_cloudflared`)
- **Routen**:
  - `rosenweg4303.ch` → Docker Swarm (Traefik)
  - `www.rosenweg4303.ch` → Docker Swarm (Traefik)
  - `authentik.rosenweg4303.ch` → Authentik

**Wichtig**: Authentik ist intern NICHT via Cloudflare Tunnel erreichbar. Server-to-Server Calls müssen die interne URL (`https://server:9443` oder `https://100.64.2.27:9443`) nutzen.

## DNS Records

### Proxied (über Cloudflare CDN) ☁️

| Name | Typ | Ziel |
|------|-----|------|
| rosenweg4303.ch | CNAME | CF Tunnel |
| www | CNAME | CF Tunnel |
| authentik | CNAME | CF Tunnel |
| netbox | CNAME | CF Tunnel |
| homebox | CNAME | CF Tunnel (anderer) |
| paperlessngx | CNAME | CF Tunnel (anderer) |
| runtipi | CNAME | CF Tunnel (anderer) |

### DNS Only (kein Proxy) ⚡

| Name | Typ | Ziel | Beschreibung |
|------|-----|------|-------------|
| mail | A | 138.199.226.209 | Mailserver (extern) |
| mail | AAAA | 2a01:4f8:c013:bbab::1 | Mailserver IPv6 |
| pve1 | A | 100.64.90.20 | Proxmox Host 1 |
| pve2 | A | 100.64.90.21 | Proxmox Host 2 |
| pve3 | A | 100.64.90.22 | Proxmox Host 3 |
| pve4 | A | 100.64.99.237 | Proxmox Host 4 |
| pve-cluster1 | A | 100.64.90.20/21/22 | Cluster VIP (3 Records) |
| dc1 | A | 100.64.2.44 | Samba DC (veraltet?) |
| n8n | A | 100.64.2.22 | n8n (veraltet) |
| npm | A | 100.64.2.22 | Nginx Proxy Manager (veraltet) |
| kooperation | A | 37.17.232.133 | Externer Server |

### Email

| Name | Typ | Ziel | Beschreibung |
|------|-----|------|-------------|
| @ | MX | route1/2/3.mx.cloudflare.net | Cloudflare Email Routing |
| @ | TXT | v=spf1 include:_spf.mx.cloudflare.net include:spf.smtp2go.com ~all | SPF |
| _dmarc | TXT | v=DMARC1; p=quarantine; ... | DMARC Policy |
| cf2024-1._domainkey | TXT | v=DKIM1; ... | Cloudflare DKIM |
| s1102430._domainkey | CNAME | dkim.smtp2go.net | SMTP2GO DKIM |
| dkim._domainkey | TXT | v=DKIM1; ... | Legacy DKIM |
| em1102430 | CNAME | return.smtp2go.net | SMTP2GO Return Path |
| link | CNAME | track.smtp2go.net | SMTP2GO Tracking |

### Mail-Discovery

| Name | Typ | Ziel |
|------|-----|------|
| autoconfig | CNAME | mail.rosenweg4303.ch |
| autodiscover | CNAME | mail.rosenweg4303.ch |
| _autodiscover._tcp | SRV | 1 443 mail.rosenweg4303.ch |

### DNS Delegation

| Name | Typ | Ziel | Beschreibung |
|------|-----|------|-------------|
| dienste.rosenweg4303.ch | NS | freeipa1.rosenweg4303.ch | FreeIPA (veraltet?) |
| domain.rosenweg4303.ch | NS | dc1.rosenweg4303.ch | AD DNS Zone |

### Sicherheit

| Name | Typ | Ziel | Beschreibung |
|------|-----|------|-------------|
| _25._tcp.mail | TLSA | 3 1 1 ... | DANE TLS |
| _acme-challenge | TXT | (2 Records) | Let's Encrypt Validierung |

## Email Routing

Cloudflare empfängt Mails (MX) und leitet weiter:
- Catch-All → `rosenweg4303@gmail.com`
- DMARC Reports → `dmarc@rosenweg4303.ch` (via Gmail)

## Aufräum-Kandidaten

Folgende DNS-Records sind möglicherweise veraltet:
- `dc1.rosenweg4303.ch` → `100.64.2.44` (DC ist jetzt auf 100.64.2.30)
- `n8n.rosenweg4303.ch` → n8n wird nicht mehr aktiv genutzt
- `npm.rosenweg4303.ch` → Nginx Proxy Manager ersetzt durch Traefik
- `dienste.rosenweg4303.ch` NS → FreeIPA nicht mehr in Betrieb
- `freeipa1.rosenweg4303.ch` → FreeIPA nicht mehr in Betrieb
- `docker1.rosenweg4303.ch` → alte Docker-IP
