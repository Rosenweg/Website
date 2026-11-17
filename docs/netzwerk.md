# Netzwerk — Rosenweg

Stand: 17.11.2026. Vollständige Dienst- und Containerliste:
[`infrastruktur.md`](infrastruktur.md). VLANs und UniFi-Hardware:
[`unifi.md`](unifi.md). Hostnamen und Pfade: [`routing.md`](routing.md).
Sicherheitsregeln: [`sicherheit.md`](sicherheit.md).

> Bis Juni 2026 standen hier die Swarm-Knoten CT 201–203 (`100.64.2.24–26`) und
> die Swarm-Adresse `100.64.2.27`. Diese gibt es nicht mehr; `100.64.2.27` gehört
> heute CT 206 (fileserver2).

## Übersicht

```
Internet (WAN1 + WAN2 Failover)
    │
    ▼
UDM-Pro — Technikraum RW9, Gateway 100.64.2.1 im Dienste-Netz
    │
    ├── VLAN 2  (RK-Dienste, 100.64.2.0/24) → alle Dienst-LXCs, Fileserver, DCs
    ├── VLAN 9  (RK-Clients, 100.64.9.0/24) → TV7-Streamer, udpxy, Kooperations-Geräte
    ├── VLAN 90 (RW9-Technik, 100.64.90.0/24) → Zähler (Modbus), ioBroker, Shelly
    ├── weitere VLANs, je Haus ein Benutzernetz mit eigenem Router-CT (500–518)
    │
    └── DNAT 80/443/465/587/993/25/8883 → edge-traefik CT 245 (100.64.2.40)
        udp/5060 (nur 95.128.80.0/25, peoplefone) → PBX CT 220 (100.64.2.55)
```

**IPv6 bleibt überall eingeschaltet.** Schutzregeln (nftables) werden immer
für IPv4 **und** IPv6 geschrieben (Beispiele: `whatsapp-bot/lxc/wa-2525-fw.nft`,
`backend-lxc/energy/firewall/energy-firewall.nft`).

## Wichtige Adressen

| Adresse | Was |
|---|---|
| 100.64.2.1 | Gateway (UDM), DNS für die Dienst-LXCs |
| 100.64.2.20 / .21 / .22 | pve1 / pve2 / pve3 |
| 100.64.2.27 | CT 206 fileserver2 |
| 100.64.2.28 | CT 106 fileserver |
| 100.64.2.29 | `files.ad.rosenweg4303.ch`, schwenkt per keepalived zwischen CT 106 und 206 |
| 100.64.2.30 | CT 108 dc1 |
| 100.64.2.31 | CT 230 PMG |
| 100.64.2.32 | CT 111 cups-server (Druck-API :8080) |
| 100.64.2.33 | CT 240 Mailcow |
| 100.64.2.34 | CT 113 vpn-wg (wg-control :3001) |
| 100.64.2.36 | CT 104 Nextcloud |
| 100.64.2.37 | CT 114 Authentik (9000/9443, LDAP 389/636) |
| 100.64.2.38 | CT 115 Z-Push |
| 100.64.2.39 | CT 116 WhatsApp-Bridge |
| 100.64.2.40 | CT 245 edge-traefik |
| 100.64.2.41–.50, .54 | Frontend-LXCs CT 118–127, 130 |
| 100.64.2.51 | CT 105 MQTT-Broker |
| 100.64.2.52 | CT 128 core-backend (API) |
| 100.64.2.53 | CT 129 energy-stack |
| 100.64.2.55 | CT 220 asterisk-pbx |
| 100.64.2.56 | CT 131 core-messenger |
| 100.64.9.23 | CT 250 TV7-Streamer |
| 100.64.9.24 | CT 109 tv-proxy (udpxy :4022) |
| 100.64.90.50 | ioBroker (Heizung) |
| 100.64.90.70–.82 | Stromzähler (Modbus :502), einziges erlaubtes Zählernetz des Collectors |

## DNS

### Extern (Cloudflare)

- Web-Hostnamen zeigen (A oder CNAME auf `public.rosenweg4303.ch`) auf die
  öffentliche Adresse; die UDM leitet an edge-traefik weiter.
- Einzelheiten und Prüfung von Fremd-Domains: [`routing.md`](routing.md).

### Intern (Split-Horizon)

- Dienst-LXCs nutzen `100.64.2.1` (UDM) als DNS.
- UDM Conditional Forward: `ad.rosenweg4303.ch` → `100.64.2.30` (DC);
  dc1/dc2 sind autoritativ für `ad.rosenweg4303.ch`.
- Einige Namen lösen intern anders auf als extern (z. B.
  `mail.rosenweg4303.ch` → `100.64.2.33`, `kooperation.rosenweg4303.ch` →
  `100.64.2.40`, `sip.rosenweg4303.ch` → `100.64.2.55` nur intern). Tests aus
  dem Hausnetz sagen darum nichts über die Erreichbarkeit von aussen.

## Zugriffsbeschränkungen (Stand 17.11.2026)

| Dienst | Port | Erlaubt | Mechanismus |
|---|---|---|---|
| WhatsApp-Gateway SMTP (CT 116) | 2525 | nur PMG `100.64.2.31` | nftables `inet rw_wa_2525` |
| Energie-Collector (CT 129) | 3001 | CT 128 und Frontend-LXCs | nftables (`energy-firewall.nft`) |
| Energie-DB (CT 129) | 5432 | nur CT 128 | dito |
| Asterisk-AMI (CT 220) | 5038 | `127.0.0.1`, `100.64.2.52` | ACL in `manager.conf` (zusätzlich Firewall empfohlen) |
| wg-control (CT 113) | 3001 | LAN-Adresse, Bearer-Token | `WG_CONTROL_BIND`, Token |
| SIP-Trunk (CT 220) | udp/5060 | `95.128.80.0/25` | UDM-Portweiterleitung + `pjsip identify` |
| Code-Endpunkte der API | 443 | 10/Min je IP | nginx `rw_otp` auf den Frontends |
| Z-Push ActiveSync | 443 | 10/s gesamt, 5 Fehlversuche/15 Min je Benutzer | nginx + Backend |

## Fileserver (CT 106)

| Port | Service | Beschreibung |
|------|---------|-------------|
| 445 | Samba | SMB Shares |
| 21 | vsftpd | FTP Scanner-Upload |
| 30000-30100 | vsftpd | FTP Passive Ports |

## Domain Controller (CT 108)

| Port | Service | Beschreibung |
|------|---------|-------------|
| 53 | Samba DNS | AD DNS |
| 88 | Kerberos | AD Auth |
| 135 | RPC | AD RPC |
| 389 | LDAP | AD LDAP |
| 445 | SMB | AD SMB |
| 636 | LDAPS | AD LDAPS |
| 3268 | Global Catalog | AD GC |
| 8446 | Password API | Passwort-Setzung (Bearer `AD_PASSWORD_API_SECRET`) |
