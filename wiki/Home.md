# STWEG-Kooperation Rosenweg - Dokumentation

Technische Dokumentation der STWEG-Kooperation Rosenweg Website.

## Über die STWEG-Kooperation Rosenweg

Die STWEG-Kooperation Rosenweg besteht aus 8 Stockwerkeigentümergemeinschaften am Rosenweg in Kaiseraugst, Aargau.

- **STWEG 1-7**: Wohngebäude
- **STWEG 8**: Tiefgarage (Einstellhalle)
- **Gesamt**: 15 Ausschussmitglieder

**Website**: <https://rosenweg4303.ch>

## Architektur

| Komponente | Technologie |
|---|---|
| Frontend | HTML, Tailwind CSS, Vanilla JavaScript |
| Backend | Node.js API (api/server.js) |
| Auth | Authentik SSO |
| Hosting | Docker Swarm (3 Nodes, Traefik + Cloudflare) |
| E-Mail Versand | SMTP2GO |
| E-Mail Empfang | Cloudflare Forward → Gmail → IMAP Poll |
| Datenbank | PostgreSQL |

## Hauptfunktionen

- **Bewohnerverwaltung** - Authentik-Benutzer verwalten, Gruppen/Rechte zuweisen
- **E-Mail-Verteilerlisten** - Cloudflare → Gmail → IMAP → SMTP2GO Verteiler
- **Waschküchen-Reservierung** - Online-Buchung mit Türschloss-Integration
- **Energie-Monitor** - Solartarif/Netztarif Tracking
- **IT & Netzwerk** - UniFi Dashboard
- **Entsorgungskalender** - REWAG Entsorgungstermine
- **Türschilder** - Druckbare A4-Schilder mit QR-Codes

## Kontakt

**Technischer Dienst Rosenweg**
- Stefan Müller (STWEG 3)
- Andreas Debona (STWEG 7)
- E-Mail: technik@rosenweg4303.ch
