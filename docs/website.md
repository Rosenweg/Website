# Website — Rosenweg

## Übersicht

Statische HTML-Seiten + API Server. Kein Framework, plain HTML/CSS/JS mit Tailwind CSS (CDN).

- **URL**: `https://www.rosenweg4303.ch`
- **Image**: `ghcr.io/rosenweg/rosenweg-website:latest` (3 Replicas, Nginx)
- **API Image**: `ghcr.io/rosenweg/rosenweg-api:latest` (1 Replica, Node.js)

## Seiten

### Öffentlich (ohne Login)
| Seite | Pfad | Beschreibung |
|-------|------|-------------|
| Login | `/index.html` | Startseite, Login-Button |

### Authentifiziert (Bewohner)
| Seite | Pfad | Beschreibung |
|-------|------|-------------|
| Profil | `/profil.html` | Persönliche Daten, Passwort ändern |
| Energie-Monitor | `/energie-monitor.html` | Stromverbrauch, Tarife, Charts |
| Zähler | `/zaehler.html` | Zähler-Konfiguration |
| Entsorgung | `/entsorgung.html` | Abfallkalender REWAG |
| Projekte | `/projekte.html` | Laufende Projekte |

### Admin (Technik-Gruppe)
| Seite | Pfad | Beschreibung |
|-------|------|-------------|
| Verwaltung | `/verwaltung.html` | Benutzerverwaltung |
| Wohnungsverwaltung | `/objektverwaltung.html` | Wohnungen zuweisen |
| Rechteverwaltung | `/rechteverwaltung.html` | Rollen/Rechte |
| Email-Verteiler | `/email-verteiler.html` | Verteiler-Mails anzeigen |
| Email-Archiv | `/email-archiv.html` | Archivierte Mails |
| Energie-Config | `/energie-config.html` | Tarife, Zähler konfigurieren |
| IT-Netzwerk | entfernt, siehe `docs/unifi.md` | — |
| Proxmox | `/proxmox-verwaltung.html` | PVE Status |

### STWEG-Seiten
| Pfad | Beschreibung |
|------|-------------|
| `/stweg1/` bis `/stweg8/` | Pro-STWEG Startseite |
| `/stweg3/pages/admin.html` | STWEG3 Admin |
| `/stweg3/pages/waschkueche-admin.html` | Waschküche-Verwaltung |
| `/stweg3/pages/stweg3-kontakte.html` | Kontakte |

### Spezial
| Pfad | Beschreibung |
|------|-------------|
| `/door-signs/` | Türschilder (Kiosk-Modus) |
| `/kiosk/` | Kiosk-Anzeige |

## Shared JavaScript

| Datei | Funktion |
|-------|----------|
| `js/authentik-auth.js` | SSO Login, Token-Management, `apiFetch()` |
| `js/nav.js` | Navigation (alle Seiten), STWEG-Adressen |

### authentik-auth.js — Wichtige Methoden

- `AuthentikAuth.login(redirect)` — Redirect zu Authentik
- `AuthentikAuth.logout()` — Session löschen, Redirect zu Login
- `AuthentikAuth.isLoggedIn()` — Prüft ob Session-Token vorhanden
- `AuthentikAuth.getUser()` — User-Objekt aus localStorage
- `AuthentikAuth.getToken()` — Bearer Token
- `AuthentikAuth.apiFetch(url, options)` — Fetch mit Auth-Header, **auto-logout bei 401**
- `AuthentikAuth.init({requireAuth, requireAdmin, onLogin, onLogout})` — Seiten-Init

**Wichtig**: `apiFetch()` ruft `logout()` bei HTTP 401 auf. API-Endpunkte dürfen daher 401 nur für echte Session-Ablauf-Fehler zurückgeben, nicht für Business-Logik-Fehler (z.B. falsches Passwort → 400 oder 403 verwenden).

## Nginx-Konfiguration

- Reverse Proxy: `/api/*` → `http://api:3000`
- JS/CSS: `Cache-Control: no-cache` (Revalidierung bei jedem Request)
- Bilder/Fonts: `Cache-Control: max-age=604800, immutable` (7 Tage)
- SPA-Fallback: Nein (statische Seiten)

## Deployment

Die Frontends liefen einmal als Swarm-Dienste aus Docker-Images. Der Betrieb
war nicht stabil genug, darum laufen sie heute als LXC-Container mit einem
schlichten nginx, das statische Dateien ausliefert. **Es gibt keinen
automatischen Weg vom Push auf die Seite** — ausgerollt wird von Hand, und
zwar dateiweise.

Wichtig: Es gibt mehrere `fe-*`-Container mit **unterschiedlichem** Inhalt.
Die Hauptseite liegt allein auf `fe-www` (CT 118, 100.64.2.41) unter
`/var/www/rosenweg`. `fe-stweg1..7`, `fe-meg`, `fe-isp` und `fe-pwa` führen
ihre eigenen, kleineren Bestände. Wer blind spiegelt, überschreibt Fremdes.

```bash
# 1. Dateien auf einen pve-Knoten legen
scp -J stefan@10.0.10.149 profil.html hilfe.html root@100.64.2.20:/tmp/

# 2. Dort sichern, was ersetzt wird
ssh -J stefan@10.0.10.149 root@100.64.2.20 \
  'pct exec 118 -- sh -c "cd /var/www/rosenweg && cp -a profil.html profil.html.alt"'

# 3. Hineinschieben und Eigentuemer richten
ssh -J stefan@10.0.10.149 root@100.64.2.20 '
  pct push 118 /tmp/profil.html /var/www/rosenweg/profil.html --perms 644
  pct exec 118 -- chown www-data:www-data /var/www/rosenweg/profil.html'

# 4. Nachsehen, ob es wirklich draussen ist
curl -sI https://www.rosenweg4303.ch/profil.html | grep -i last-modified
```

nginx braucht kein Neuladen — es liest die Dateien bei jedem Request.

Die API dagegen läuft weiterhin in Docker, auf CT 128 (`core-backend`):

```bash
ssh -J stefan@10.0.10.149 root@100.64.2.20 \
  'pct exec 128 -- sh -c "cd /opt/rosenweg-core && docker compose pull api && docker compose up -d api"'
```
