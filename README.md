# STWEG-Kooperation Rosenweg - Website

Website der STWEG-Kooperation Rosenweg in Kaiseraugst, Aargau.

## Über das Projekt

- **8 STWEGs** (7 Wohngebäude + 1 Tiefgarage) am Rosenweg
- **Authentik SSO** für Authentifizierung
- **API-Backend** für Verteilerlisten, Waschküche, Verwaltung
- **Energie-Monitor** mit Solartarif/Netztarif-Tracking

## Architektur

| Komponente | Technologie |
|---|---|
| Frontend | HTML, Tailwind CSS, Vanilla JS |
| Backend | Node.js API (`api/server.js`) |
| Auth | Authentik SSO |
| Hosting | Proxmox-Cluster, ein LXC je Dienst (Frontends: nginx; API: Docker Compose auf CT 128) |
| E-Mail | Mailcow + Proxmox Mail Gateway; API-Versand über SMTP2GO |
| Proxy | Traefik am Rand (CT 245), DNS bei Cloudflare |

## Struktur

```
├── index.html              # Hauptseite
├── verwaltung.html         # Bewohner-/Rechteverwaltung
├── email-verteiler.html    # E-Mail-Verteilerlisten
├── energie-monitor.html    # Energieverbrauch & Solar
├── entsorgung.html         # Entsorgungskalender
├── js/                     # Shared JavaScript
│   ├── nav.js              # Navigation
│   ├── authentik-auth.js   # SSO Integration
│   └── site-config.js      # Konfiguration
├── api/                    # Node.js API Backend
├── energy-collector/       # Energie-Datensammler
├── stweg1..7/, meg/        # STWEG-/MEG-Seiten
├── door-signs/             # Türschilder (A4 PDF)
├── frontends-lxc/          # nginx-Konfiguration + deploy.sh der Frontend-LXCs
├── backend-lxc/            # Compose-Dateien API (CT 128) und Energie (CT 129)
├── edge-traefik/           # Reverse-Proxy (CT 245)
├── scripts/                # Betriebsskripte (SSH-Zugang, Dienstwacht, Ausrollen …)
├── docs/                   # Dokumentation, Einstieg docs/infrastruktur.md
└── docker-stack.yml        # historisch (Swarm, abgebaut)
```

## Deployment

Ein Push auf `main` lässt GitHub Actions die Images bauen (`ghcr.io/rosenweg/…`);
**ausgerollt wird von Hand**:

- API: auf CT 128 `docker compose pull api && docker compose up -d api` in `/opt/rosenweg-core`
- Frontends: `frontends-lxc/deploy.sh` im jeweiligen Container bzw. `scripts/rw-web-ausrollen.sh` für einzelne Dateien

Einzelheiten: [`docs/infrastruktur.md`](docs/infrastruktur.md) und
[`docs/website.md`](docs/website.md).

## Sicherheit

Das Repository ist **öffentlich**. Nie Geheimnisse, Tokens, Passwörter oder
Exporte mit Schlüsseln einchecken – Werte gehören in die `.env`-Dateien auf den
Containern. Regeln, Grenzwerte und offene Punkte nach der Prüfung vom
17.11.2026: [`docs/sicherheit.md`](docs/sicherheit.md).

## Kontakt

**Technischer Dienst Rosenweg**
- Stefan Müller - stefan+rosenweg@juroct.ch
