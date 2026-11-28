# Website – Aufbau, Ausrollen, Sicherheit

Technische Übersicht, aus dem README hierher verschoben. Gesamtübersicht der Dokumentation: [README.md](README.md).

## Über das Projekt

- **8 STWEGs** (7 Wohngebäude + 1 Tiefgarage) am Rosenweg
- **Authentik SSO** für Authentifizierung
- **API-Backend** für Verteilerlisten, Waschküche, Verwaltung
- **Energie-Monitor** mit Solartarif/Netztarif-Tracking
- **Telefonanlage** (Asterisk, `pbx/`) mit geteilten Smartphones (`/smartphones`), eigenen Handys und der Seite `/mein-telefon`
- **Apps** auf `/apps`: Downloads der Rosenweg-Apps; neue Versionen schicken die App-Repos beim Release selbst (wiederverwendbarer Workflow `.github/workflows/apps-release.yml`, Anmeldung per GitHub-OIDC)
- **Stationen**: Rosenweg OS und Windows-Rechner aus dem Active Directory; GPOs für Rosenweg-Look, Ordnerumleitung, Nextcloud als Laufwerk N: und die Programm-Positivliste (`ad-dc/`)
- **Salzvorrat** der Enthärtungsanlagen (`salz.html`, App Rosenweg Salz)

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
├── pbx/                    # Telefonanlage: Asterisk-Konfiguration, PBX-API, App-Katalog und /apps
├── ad-dc/                  # Samba AD: zweiter DC, SYSVOL-Abgleich, GPOs, Windows-OU
├── apps.html, smartphones.html, salz.html, stationen.html  # Seiten zu den Abschnitten oben
├── energy-collector/       # Energie-Datensammler
├── stweg1..7/, meg/        # STWEG-/MEG-Seiten
├── api/vorlagen/aushaenge/ # Türschilder + Poster (Druck mit Token-QR via tuerschilder.html)
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

Einzelheiten: [`docs/infrastruktur.md`](infrastruktur.md) und
[`docs/website.md`](website.md); Telefonanlage und PBX-API:
[`pbx/README.md`](../pbx/README.md).

App-Releases an `/apps`: Abschnitt „Seite /apps und App-Releases“ in
[`pbx/README.md`](../pbx/README.md).

## CI-Änderungen über viele Repos (Regel)

Nie in einem Zug 40 Pull Requests anlegen oder neu starten: Jeder PR startet die Prüfung auf
unseren vier Runnern, am 28.11.2026 stauten 45 PRs die Releases stundenlang. Mehrere Repos nur mit
`scripts/rw-massen-pr.sh` (höchstens 6 gleichzeitig, nur wenn weniger als 15 Jobs warten und weniger als 2
Releases laufen), Einzelheiten in [runner-waechter.md](runner-waechter.md#massenänderungen-gestaffelt).
Agenten halten sich daran, auch wenn der Auftrag „alle Repos“ lautet.

## Sicherheit

Das Repository ist **öffentlich**. Nie Geheimnisse, Tokens, Passwörter oder
Exporte mit Schlüsseln einchecken – Werte gehören in die `.env`-Dateien auf den
Containern. Regeln, Grenzwerte und offene Punkte nach der Prüfung vom
17.11.2026: [`docs/sicherheit.md`](sicherheit.md).

## Kontakt

**Technischer Dienst Rosenweg**
- Technik, über das Kontaktformular auf [www.rosenweg4303.ch](https://www.rosenweg4303.ch)
