# Rosenweg Dokumentation

Obsidian Vault mit der technischen Dokumentation der Rosenweg-Kooperation.

## Inhalt

### Sicherheit
- [Sicherheit](sicherheit.md) — Vorfälle 16./17.11.2026, Schutzmechanismen, Grenzwerte, Umgebungsvariablen, Ausrollen/Rückbau, offene Punkte
- [Konto-Löschung](konto-loeschung.md) — Frist, Rechte, Nachlauf (Anlage, Nextcloud, Mailbox, Karten) mit Wiederholung, Aufräumlauf nach 3 Monaten, offene Bereiche (TODO)

### Infrastruktur
- [Infrastruktur](infrastruktur.md) — Proxmox, Container je Dienst, Geheimnis-Ablagen, Datenbanken
- [Systemübersicht](systemuebersicht.md) — Funktionen und Status
- [Routing](routing.md) — Hostnamen, Pfade, Edge-Routen
- [SSH-Zugang](ssh-zugang.md) — Schlüssel aus dem Profil, Konten, sudo
- [UniFi](unifi.md) — UDM-Pro, Switches, APs, VLANs, Protect, Access
- [Netzwerk](netzwerk.md) — IPs, DNS, Firewall, Ports
- [Active Directory](active-directory.md) — Samba DC, Fileserver, Domain Join, Passwort-Sync
- [Cloudflare](cloudflare.md) — Zone, API-Token und wo er gebraucht wird (Tunnel/Email Routing veraltet)

### Applikationen
- [Entwickeln](entwickeln.md) — Einstieg: Funktionen, Architektur, Struktur, Ausrollen (früher im Repo-README)
- [Website](website.md) — Seiten, JS, Deployment, Nginx
- [API](api.md) — Endpunkte, Auth, Umgebungsvariablen
- [Email](email.md) — Mailcow/PMG, IMAP-Abruf, Druck per Mail, SMTP2GO, DMARC
- [Energie](energie.md) — Stromzähler, Collector, Tarife

### Betriebsanleitungen der Dienste (im Repo)
- [Frontend-LXCs](../frontends-lxc/README.md) — `deploy.sh`, Sicherheits-Header, Sperrregeln
- [Backend-LXCs](../backend-lxc/README.md) — API (CT 128), Energie (CT 129)
- [Edge-Traefik](../edge-traefik/README.md) — CT 245
- [WhatsApp](../whatsapp-bot/README.md), [CT 116](../whatsapp-bot/lxc/README.md), [Gateway-Daten](../whatsapp-bot/lxc/gateway-data.md)
- [PBX](../pbx/README.md), [PBX-API-Deploy](../pbx/DEPLOY-PBX-API.md) — CT 220
- [Z-Push](../zpush/README.md) — CT 115
- [wg-control](../wg-control/README.md) — CT 113
- [TV7-Streamer](../tv7-streamer/README.md) — CT 250
- [Kontakte-Sync](../contacts-sync/README.md)
- [Skripte](../scripts/README.md)

### Pläne
- [Proxmox Mail Gateway](plans/proxmox-mail-gateway.md) — PMG + Mailcow Setup
- [FPÜV Verbindungsnachweis](plans/fpuev-verbindungsnachweis.md) — Syslog + Polling
- [TV7](plans/tv7.md) — Init7 IPTV via Multicast
- [Scan Agent](plans/scan-agent.md) — Automatische Formular-Verarbeitung

### Journal
- [Tageseinträge](journal/) — Tägliche Arbeitsnotizen
