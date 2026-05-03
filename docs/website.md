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

```bash
# 1. Push löst GitHub Actions Build aus
git push

# 2. Build abwarten
gh run watch <run-id> --exit-status

# 3. Website deployen
ssh root@100.64.2.24 "docker service update --force --image ghcr.io/rosenweg/rosenweg-website:latest rosenweg_website"

# 4. API deployen
ssh root@100.64.2.24 "docker service update --force --image ghcr.io/rosenweg/rosenweg-api:latest rosenweg_api"
```
