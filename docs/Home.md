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
| Hosting | Proxmox-Cluster (pve1–3), ein LXC je Dienst; Frontends mit nginx, API in Docker Compose (CT 128) |
| Reverse-Proxy | Traefik am Rand (CT 245), DNS bei Cloudflare |
| E-Mail | Mailcow (CT 240) + Proxmox Mail Gateway (CT 230); API-Versand über SMTP2GO |
| Datenbank | PostgreSQL (CT 128, Energie in CT 129) |

## Hauptfunktionen

- **Bewohnerverwaltung** - Authentik-Benutzer verwalten, Gruppen/Rechte zuweisen
- **E-Mail-Verteilerlisten** - Mailcow-Aliase, Freigabe-Outbox, Archiv
- **Waschküchen-Reservierung** - Online-Buchung mit Türschloss-Integration
- **Energie-Monitor** - Solartarif/Netztarif Tracking
- **IT & Netzwerk** - UniFi Dashboard
- **Entsorgungskalender** - REWAG Entsorgungstermine
- **Türschilder** - Druckbare A4-Schilder mit QR-Codes

## Betrieb und Sicherheit

- [Infrastruktur](infrastruktur.md) — wo welcher Dienst läuft, Einstieg für Techniker
- [Sicherheit](sicherheit.md) — Vorfälle, Schutzregeln, Grenzwerte, Variablen, offene Punkte
- [SSH-Zugang](ssh-zugang.md) — Schlüssel aus dem Profil, Konten, sudo

## Kontakt

**Technischer Dienst Rosenweg**
- Stefan Müller (STWEG 3)
- Andreas Debona (STWEG 7)
- E-Mail: technik@rosenweg4303.ch
