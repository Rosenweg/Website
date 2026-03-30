# TV7 (Init7 IPTV)

## Status: Multicast funktioniert noch nicht

### Aktueller Stand
- TV7 Web-Client (`tv.html`) funktioniert (Kanalliste, Player UI)
- udpxy LXC (CT 109, 100.64.9.200) ist installiert und läuft
- DNS: `tv.rosenweg4303.ch → 100.64.2.31` (muss auf neue IP aktualisiert werden)
- **Problem**: Kein Multicast-Empfang im LXC — 0 Bytes von UDP Streams
- IGMP Proxy ist in der UDM konfiguriert aber scheint nicht aktiv zu sein

### Nächste Schritte
1. In der UDM UI prüfen: Settings → Internet → WAN → IGMP Proxy aktivieren
2. Auf einem physischen Client (PC direkt am Switch) testen ob TV7 Multicast ankommt
3. Falls Multicast auf physischem Client auch nicht geht: Init7 kontaktieren (IGMP auf WAN?)
4. Falls nur LXC-Problem: udpxy auf physischem Host (pve1) statt in LXC laufen lassen

## Voraussetzungen

### Netzwerk (erledigt)
- [x] Init7 Internet-Anschluss (WAN1, Glasfaser)
- [x] IGMP Proxy auf UDM: WAN1 upstream, alle RW-Clients downstream
- [x] IGMP Snooping auf allen Client-VLANs aktiv
- [x] Multicast-Routing: `igmp_proxy_for: some` mit 15 Netzwerken

### Client
- [ ] TV7-fähiger Player (VLC, TV7 App, Smart TV mit M3U-Support)
- [ ] Playlist-URL: `https://api.init7.net/tvchannels.m3u`
- [ ] Client muss im Rosenweg-Netzwerk sein (eines der RW-Clients VLANs)

## Einrichtung pro Client

### VLC (PC/Mac/Linux)
1. VLC öffnen
2. Media → Netzwerkstream öffnen
3. URL: `https://api.init7.net/tvchannels.m3u`

### Smart TV (Samsung/LG/Android TV)
1. IPTV-App installieren (z.B. "IPTV Smarters", "TiviMate", "OTT Navigator")
2. Playlist-URL eintragen: `https://api.init7.net/tvchannels.m3u`

### Apple TV
1. App "IPTV Smarters" oder "GSE Smart IPTV" aus dem App Store
2. M3U Playlist hinzufügen: `https://api.init7.net/tvchannels.m3u`

### Init7 TV7 App
1. Verfügbar für Android, iOS, Apple TV, Fire TV
2. Download: https://www.init7.net/de/tv/tv7/
3. Kein Setup nötig — erkennt den Init7-Anschluss automatisch

## Kanäle

TV7 bietet ~250+ Sender inkl.:
- SRF 1/2, RTS, RSI (Schweizer TV)
- ARD, ZDF, ORF, 3sat
- RTL, ProSieben, Sat.1, VOX
- CNN, BBC, Euronews
- Alle in HD, viele in Full HD

## Technische Details

- **Protokoll**: IGMP Multicast (UDP)
- **Multicast-Range**: 239.x.x.x
- **Bandbreite**: ~5-15 Mbit/s pro Stream (HD)
- **Init7 WAN**: Glasfaser, genug Kapazität für mehrere gleichzeitige Streams
- **Kein Zusatzkosten**: TV7 ist im Init7-Abo enthalten

## Fehlerbehebung

| Problem | Lösung |
|---------|--------|
| Kein Bild | IGMP Proxy prüfen, Client muss im richtigen VLAN sein |
| Ruckeln | Switch-Port auf Multicast-Forwarding prüfen |
| Nur einige Sender | Firewall-Regeln prüfen, Multicast-Range freigeben |
| "Network error" | Client ist nicht im Rosenweg-Netzwerk |

## Integration in die Website

Auf der ISP-Seite könnte ein TV7-Bereich hinzugefügt werden:
- Link zur Init7 TV7 App
- Playlist-URL zum Kopieren
- Einrichtungsanleitung pro Gerät
