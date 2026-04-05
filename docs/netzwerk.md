# Netzwerk — Rosenweg

## Übersicht

```
Internet (WAN1 + WAN2 Failover)
    │
    ▼
UDM-Pro (100.64.9.1) — Technikraum RW9
    │
    ├── VLAN 2 (RK-Dienste) → Docker Swarm, Fileserver, DC
    ├── VLAN 9 (RK-Clients) → Kooperations-Geräte
    ├── VLAN 90 (RW9-Technik) → PVE Hosts, IoT, Shelly
    ├── VLAN 8 (Guest) → Gast-WLAN
    ├── ... (30+ VLANs, siehe unifi.md)
    │
    ├── Cloudflare Tunnel → Docker Swarm (100.64.2.24/25/26)
    └── Netbird VPN → PVE Hosts (100.64.90.x)
```

Siehe [UniFi](unifi.md) für vollständige VLAN- und Hardware-Dokumentation.

## IP-Adressen

### Proxmox Hosts (Netbird VPN)
| Host | Netbird IP | LAN IP |
|------|-----------|--------|
| pve1 | 100.64.90.20 | 100.64.2.20 |
| pve2 | 100.64.90.21 | 100.64.2.21 |
| pve3 | 100.64.90.22 | 100.64.2.22 |
| pve4 | 100.64.99.237 | — |

### Docker Swarm CTs
| CT | Hostname | IP |
|----|----------|-----|
| 201 | docker-pve1 | 100.64.2.24 |
| 202 | docker-pve2 | 100.64.2.25 |
| 203 | docker-pve3 | 100.64.2.26 |

### Sonstige CTs
| CT | Hostname | IP | Funktion |
|----|----------|-----|----------|
| 106 | fileserver | 100.64.2.28 | Samba + FTP |
| 108 | dc1 | 100.64.2.30 | AD Domain Controller |
| 901 | iobroker-technik | 100.64.90.50 | Hausautomation |
| 204 | scan-server | 100.64.139.71 | Scanner |

### Spezial
| IP | Beschreibung |
|----|-------------|
| 100.64.2.27 | VIP (Sekundär-IP auf CT 201, Authentik intern) |
| 100.64.2.1 | Gateway (UDM) |

## DNS

### Extern (Cloudflare)
- `rosenweg4303.ch` → CF Tunnel → Docker Swarm
- `authentik.rosenweg4303.ch` → CF Tunnel → Authentik

### Intern
- Docker-CTs, CT 106, CT 901: DNS = `100.64.2.1` (Gateway/UDM)
- UDM Conditional Forward: `ad.rosenweg4303.ch` → `100.64.2.30` (DC)
- CT 108 (DC): Autoritativ für `ad.rosenweg4303.ch`

### Intern → Authentik
- `authentik.rosenweg4303.ch` löst intern auf `100.64.2.27` (A-Record im... eigentlich via CF Tunnel CNAME)
- Server-to-Server: `https://server:9443` (Docker-intern) oder `https://100.64.2.27:9443`
- **Nicht** via Cloudflare Tunnel von intern erreichbar

## Firewall / Ports

### Docker Swarm (öffentlich via CF Tunnel)
| Port | Service | Beschreibung |
|------|---------|-------------|
| 80 | Traefik | HTTP → HTTPS Redirect |
| 443 | Traefik | HTTPS (Let's Encrypt) |

### Docker Swarm (intern)
| Port | Service | Beschreibung |
|------|---------|-------------|
| 9000 | Authentik | HTTP |
| 9443 | Authentik | HTTPS |
| 389 | Authentik LDAP | LDAP |
| 636 | Authentik LDAP | LDAPS |
| 8000 | NetBox | HTTP |

### Fileserver (CT 106)
| Port | Service | Beschreibung |
|------|---------|-------------|
| 445 | Samba | SMB Shares |
| 21 | vsftpd | FTP Scanner-Upload |
| 30000-30100 | vsftpd | FTP Passive Ports |

### Domain Controller (CT 108)
| Port | Service | Beschreibung |
|------|---------|-------------|
| 53 | Samba DNS | AD DNS |
| 88 | Kerberos | AD Auth |
| 135 | RPC | AD RPC |
| 389 | LDAP | AD LDAP |
| 445 | SMB | AD SMB |
| 636 | LDAPS | AD LDAPS |
| 3268 | Global Catalog | AD GC |
| 8446 | Password API | Passwort-Setzung |

## LXC Konfiguration

Alle Docker-CTs haben:
- `lxc.apparmor.profile: unconfined` (für IPVS)
- `docker-ipvs-fix.service` beim Boot
- Cronjob: IPVS-Fix alle 5 Minuten
- Cronjob: Service-Watchdog alle 2 Minuten
