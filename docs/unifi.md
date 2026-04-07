# UniFi Netzwerk — Rosenweg

## Übersicht

UniFi Dream Machine Pro als zentraler Gateway/Controller für die Rosenweg-Kooperation (8 STWEGs). Inter-Building Glasfaser-Netzwerk mit 37 VLANs.

- **ISP**: Init7 (Switzerland) Ltd.
- **WAN IP**: `37.17.232.133`
- **Uptime**: 100% (WAN-Monitoring)
- **Aktive Clients**: ~60
- **API Key**: `eQq7HtvQwjnAJzHwBLMrlueFDjSfmc6H`

```
Internet (Init7) ─── WAN1
                     │
Internet 2 ──── WAN2 (Failover)
                     │
              UDM-Pro (37.17.232.133)
                     │
         ┌───────────┼───────────┐
         │           │           │
    SFP+-Switch  PoE-Switch1  PoE-Switch1
    (10G Uplink) (R9 T+T)    (R9 Heizung)
         │           │           │
    ┌────┤     ┌─────┤     ┌─────┤
    │    │     │     │     │     │
   USP  Flex  APs  Express APs  Switch R13
   RPS  Dach              Heiz.
```

## Hardware (14 Geräte)

### Gateways (2x)

| Gerät | Modell | IP | MAC | Version | Uptime | Standort |
|-------|--------|-----|-----|---------|--------|----------|
| UDM Kooperation R9 T+T | UDM-Pro | 37.17.232.133 | e4:38:83:4d:02:dd | v5.0.16.30692 | 9d 16h | Technikraum RW9 |
| Express | UX | 100.64.0.44 | 94:2a:6f:20:17:de | v4.0.12.17054 | — | — |

### Switches (6x)

| Gerät | Modell | IP | MAC | Version | Uptime | Standort |
|-------|--------|-----|-----|---------|--------|----------|
| SFP+-Switch1 Kooperation R9 T+T | USXG (16-Port SFP+) | 100.64.0.32 | 18:e8:29:2d:fd:68 | v7.2.123 | 150d | Technikraum RW9 |
| Poe-Switch1 Kooperation R9 T+T | US8P60 (8-Port PoE) | 100.64.0.30 | f0:9f:c2:1f:ff:9d | v7.2.123 | 150d | Technikraum RW9 |
| USP-RPS Kooperation R9 T+T | USPRPS (Redundant PSU) | 100.64.0.4 | e4:38:83:e6:aa:ac | v7.2.123 | 150d | Technikraum RW9 |
| PoE-Switch1 R9 Heizungsraum | US24PRO (24-Port PoE) | 100.64.0.90 | ac:8b:a9:bf:37:cd | v7.2.123 | 69d | RW9 Heizungsraum |
| Poe-Switch2 R9 Dach | USF5P (Flex 5-Port PoE) | 100.64.0.91 | ac:8b:a9:bc:89:7d | v7.2.123 | 98d | RW9 Dach |
| PoE-Switch1 R13 Heizungsraum | US6XG150 (6-Port 10G PoE) | 100.64.0.239 | 18:e8:29:29:03:0f | v7.2.123 | 10d | RW13 Heizungsraum |

### Access Points (6x aktiv, 1 disconnected)

| Gerät | Modell | IP | MAC | Version | Uptime | Clients | Standort |
|-------|--------|-----|-----|---------|--------|---------|----------|
| WLAN-AP R9 Heizungsraum | U7-LT (WiFi 7 Lite) | 100.64.0.92 | d8:b3:70:a6:83:88 | v6.8.2 | 44d | 20 | RW9 Heizungsraum |
| WLAN-AP Kooperation R9 Hauptverteilung | U7-UKU | 100.64.0.31 | 9c:05:d6:70:2b:98 | v6.8.2 | 44d | 3 | RW9 Hauptverteilung |
| WLAN-AP R9 Dach | U7-MSH (Mesh) | 100.64.0.93 | 78:8a:20:20:03:1e | v6.8.2 | 44d | 1 | RW9 Dach |
| WLAN-AP R9 Zivilschutz Nord | U7-UKU | 100.64.0.95 | 9c:05:d6:2c:46:5c | v6.8.2 | 44d | 1 | RW9 Zivilschutz |
| WLAN-AP R13-Heizungsraum | U7-PG2 | 100.64.0.130 | 80:2a:a8:13:33:50 | v6.8.2 | 10d | 0 | RW13 Heizungsraum |
| WLAN-AP Kooperation R2 Keller | U7-MSH (Mesh) | 100.64.0.33 | 78:8a:20:20:01:34 | v6.8.2 | 5d | 0 | RW2 Keller |

## WiFi SSIDs

| SSID | Sicherheit | Beschreibung |
|------|-----------|-------------|
| Rosenweg | WPA2-PSK | Haupt-WLAN (Bewohner) |
| HausR9 | WPA2-PSK | Rosenweg 9 intern |
| Rosenweg-Guest | Open | Gast-WLAN (isoliert, VLAN 8) |

## WAN

| Interface | ISP | IP | Beschreibung |
|-----------|-----|-----|-------------|
| WAN1 | Init7 | 37.17.232.133/26 | Haupt-Internet (Glasfaser) |
| WAN2 | — | 192.168.200.2/24 | Failover |

### Port Forwards

| Name | Extern | Intern | Protokoll |
|------|--------|--------|-----------|
| MQTT | :1883 | 100.64.2.32:1883 | TCP |

### DNS
- Nameservers: `1.1.1.1`, `8.8.8.8`
- Conditional Forward: `ad.rosenweg4303.ch` → `100.64.2.30`

## VLANs / Netzwerke (37 total)

### Zentrale Netzwerke

| Name | VLAN | Subnet | Typ | DHCP | Beschreibung |
|------|------|--------|-----|------|-------------|
| Inter-Building Network | — | 100.64.0.0/24 | Corporate | Ja | Hauptnetzwerk (Glasfaser) |
| RK-Dienste | 2 | 100.64.2.0/24 | Corporate | Ja | Docker Swarm, Fileserver, DC |
| RK-Technik | 3 | 100.64.3.0/24 | Corporate | Ja | Technik-Management |
| RK-OSPF | 6 | 100.64.6.0/26 | Corporate | Nein | OSPF Routing |
| RK-BGP | 7 | 100.64.6.64/26 | Corporate | Ja | BGP Routing |
| Rosenweg-Guest | 8 | 192.168.2.0/24 | Guest | Ja | Gast-WLAN (isoliert) |
| RK-Clients | 9 | 100.64.9.0/24 | Corporate | Ja | Kooperations-Clients |

### Gebäude-Netzwerke (Clients)

| Name | VLAN | Subnet | Clients |
|------|------|--------|---------|
| RW1-Clients | 19 | 100.64.19.0/24 | — |
| RW2-Technik | 20 | 100.64.20.0/24 | 2 |
| RW2-Clients | 29 | 100.64.29.0/24 | — |
| RW4-Clients | 49 | 100.64.49.0/24 | — |
| RW5-Clients | 59 | 100.64.59.0/24 | — |
| RW6-Clients | 69 | 100.64.69.0/24 | — |
| RW8-Clients | 89 | 100.64.89.0/24 | 2 |
| RW9-Technik | 90 | 100.64.90.0/24 | 20 |
| RW9-Dienste | 91 | 100.64.91.0/24 | — |
| RW9-Kameras | 92 | 100.64.92.0/24 | 1 |
| RW9-Clients | 99 | 100.64.99.0/24 | 10 |
| RW10-Clients | 109 | 100.64.109.0/24 | — |
| RW12-Clients | 129 | 100.64.129.0/24 | — |
| RW13-Clients | 139 | 100.64.139.0/24 | 3 |
| RW14-Clients | 149 | 100.64.149.0/24 | — |
| RW16-Clients | 169 | 100.64.169.0/24 | — |
| RW17-Clients | 179 | 100.64.179.0/24 | — |
| RW18-Clients | 189 | 100.64.189.0/24 | — |

### Infrastruktur-VLANs

| Name | VLAN | Typ | Beschreibung |
|------|------|-----|-------------|
| Proxmox Sync | 4 | VLAN-only | Proxmox Cluster Sync |
| Ceph Sync | 5 | VLAN-only | Ceph Storage Sync |

### Bewohner-VLANs (VLAN-only, kein Subnet)

Format: `<HausNr><laufendeNr>` — erste Ziffer(n) = Hausnummer, Rest = fortlaufend nach Anforderungsdatum. VLAN-only (kein eigenes Subnet, direkt auf Switch-Port getaggt).

| Name | VLAN | Haus | Nr | Clients | Beschreibung |
|------|------|------|----|---------|-------------|
| MUELLER-911 | 911 | RW9 | 11 | 2 | Müller |
| MUELLER-912 | 912 | RW9 | 12 | — | Müller |
| MUELLER-913 | 913 | RW9 | 13 | — | Müller |
| MUELLER-914 | 914 | RW9 | 14 | — | Müller |
| Parkplatz53 | 915 | RW9 | 15 | 1 | Parkplatz 53 |
| MÜLLER-Test | 916 | RW9 | 16 | — | Test |

### VPN

| Name | Subnet | Typ | Beschreibung |
|------|--------|-----|-------------|
| Rosenweg Wireguard Client | 192.168.9.0/24 | Remote User VPN | WireGuard VPN Server |
| WG-HEL1 | 192.168.200.2/24 | VPN Client | Site-to-Site VPN |

## VLAN-Schema

```
VLAN X9 = Clients für Rosenweg X    (z.B. 19=RW1, 99=RW9, 139=RW13)
VLAN X0 = Technik für Rosenweg X    (z.B. 20=RW2, 90=RW9)
VLAN X1 = Dienste für Rosenweg X    (z.B. 91=RW9)
VLAN X2 = Kameras für Rosenweg X    (z.B. 92=RW9)
VLAN 2  = Zentrale Dienste (Docker, Fileserver, DC)
VLAN 8  = Gast-WLAN
VLAN 9  = Kooperations-Clients
VLAN <HausNr><Nr> = Bewohner-VLANs (VLAN-only, z.B. 911=RW9 Bew.11, 1803=RW18 Bew.03)
```

## Client-Verteilung (Live)

| Netzwerk | Clients |
|----------|---------|
| RW9-Technik (IoT, Shelly, PVE) | 20 |
| RW9-Clients | 10 |
| RK-Dienste (Server) | 8 |
| Inter-Building Network | 5 |
| RW13-Clients | 3 |
| RK-Clients | 3 |
| Sonstige | 11 |
| **Total** | **60** |

## UDM System

| Eigenschaft | Wert |
|-------------|------|
| Modell | UDM-Pro (UDMPRO) |
| Firmware | v5.0.16.30692 |
| CPU | 36.6% |
| RAM | 89.6% |
| WAN IP | 37.17.232.133/26 |
| ISP | Init7 (Switzerland) Ltd. |
| DNS | 1.1.1.1, 8.8.8.8 |

## Firewall-Zonen

Die UDM nutzt zonenbasierte Firewall-Regeln. Jede Zone enthält ein oder mehrere Netzwerke.

| Zone | Netzwerke |
|------|-----------|
| Rosenweg Kooperation | Inter-Building, RK-Dienste (2), RK-Clients (9), RK-Technik (3), RK-OSPF (6), RK-BGP (7) |
| Rosenweg 9 | RW9-Kameras (92), RW9-Dienste (91), RW9-Technik (90), RW9-Clients (99) |
| Rosenweg 1 | RW1-Clients (19) |
| Rosenweg 2 | RW2-Clients (29), RW2-Technik (20) |
| Rosenweg 4 | RW4-Clients (49) |
| Rosenweg 5 | RW5-Clients (59) |
| Rosenweg 6 | RW6-Clients (69) |
| Rosenweg 8 | RW8-Clients (89) |
| Rosenweg 10 | RW10-Clients (109) |
| Rosenweg 12 | RW12-Clients (129) |
| Rosenweg 13 | RW13-Clients (139) |
| Rosenweg 14 | RW14-Clients (149) |
| Rosenweg 16 | RW16-Clients (169) |
| Rosenweg 17 | RW17-Clients (179) |
| Rosenweg 18 | RW18-Clients (189) |
| External | Internet 1, Internet 2, WG-HEL1 |
| Vpn | Rosenweg Wireguard Client |
| Hotspot | Rosenweg-Guest (8) |
| Internal | (leer) |
| Gateway | (leer) |
| Dmz | (leer) |

### Benötigte Regeln für CUPS Druckserver

| Von | Nach | Ports | Beschreibung |
|-----|------|-------|-------------|
| Rosenweg Kooperation | Rosenweg 9 | TCP 631, 9100 | CUPS → DruckerR9 |
| Rosenweg Kooperation | Rosenweg 13 | TCP 631, 9100 | CUPS → DruckerR13 |
| Alle Zonen | Rosenweg Kooperation | TCP 631 | Clients → CUPS Server |

## UniFi Protect

- NVR integriert in UDM-Pro
- Kameras in VLAN 92 (100.64.92.0/24)
- 1 Kamera aktiv

## UniFi Access (Waschküche)

Zutrittskontrolle für Waschküche via UniFi Access Türschlösser.
- Konfiguration in DB (`wasch_settings`): `unifi_access_host`, `unifi_access_token`
- API-Integration in `api/server.js`
- Aktuell deaktiviert (`unifi_access_enabled = false`)
