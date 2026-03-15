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
| Hosting | Docker Swarm (3 Nodes) |
| E-Mail | SMTP2GO (Versand), Gmail IMAP (Empfang) |
| Proxy | Traefik + Cloudflare |

## Struktur

```
├── index.html              # Hauptseite
├── verwaltung.html         # Bewohner-/Rechteverwaltung
├── email-verteiler.html    # E-Mail-Verteilerlisten
├── energie-monitor.html    # Energieverbrauch & Solar
├── entsorgung.html         # Entsorgungskalender
├── it-netzwerk.html        # IT & Netzwerk Dashboard
├── js/                     # Shared JavaScript
│   ├── nav.js              # Navigation
│   ├── authentik-auth.js   # SSO Integration
│   └── site-config.js      # Konfiguration
├── api/                    # Node.js API Backend
├── energy-collector/       # Energie-Datensammler
├── stweg1-8/               # STWEG-spezifische Seiten
├── door-signs/             # Türschilder (A4 PDF)
├── scripts/                # Cloudflare E-Mail Sync
└── docker-stack.yml        # Docker Swarm Deployment
```

## Deployment

Push to `main` triggers GitHub Actions → Docker Image Build → Deploy via Docker Swarm.

## Kontakt

**Technischer Dienst Rosenweg**
- Stefan Müller - stefan+rosenweg@juroct.ch
