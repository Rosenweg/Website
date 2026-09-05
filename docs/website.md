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
scripts/rw-web-ausrollen.sh --pruefen profil.html js/nav.js   # nur vergleichen
scripts/rw-web-ausrollen.sh profil.html js/nav.js             # ausrollen
```

Das Skript fragt den Cluster nach allen laufenden `fe-*`-Containern und legt
jede Datei dorthin, wo sie schon liegt — was ein Container hat, bekommt er
aktuell; was er nicht hat, bekommt er nicht (ausser mit `--neu`). Vor dem
Überschreiben entsteht eine `.alt`-Kopie, danach wird die Prüfsumme
verglichen. Einzige eingebaute Ausnahme: fe-isp bekommt `js/nav-isp.js` als
`js/nav.js` und nie das allgemeine `js/nav.js`.

Dahinter stehen zwei Vorfälle vom 5. September 2026:

- **`noc-fullscreen.html` liegt zweimal** — auf fe-www (`www.…/noc-fullscreen.html`)
  und auf fe-isp, das `noc.rosenweg4303.ch` bedient und `/` darauf umschreibt.
  Wer nur fe-www beliefert, ändert das Wandbild nicht; dort lag der Stand vom
  15. August, drei Kachel-Generationen alt. Jetzt beide über das Skript.
- **Auf fe-www lag seit dem 15. August der ganze Repo-Baum** öffentlich:
  `docs/` mit IP-Zuordnung und Zonendateien, `JOURNAL.md`, Compose-Dateien,
  Skripte, UniFi-Exporte, eine Präsenzliste als Excel. Verschoben nach
  `/root/webroot-aussortiert-20260905/` auf CT 118, und nginx liefert
  seither `*.md|py|sh|yml|service|timer|sql|env|zone|csv|xlsx|conf|bak|alt|vor-*`
  und alles mit führendem Punkt grundsätzlich nicht mehr aus
  (`/etc/nginx/sites-enabled/rosenweg.conf`, Sicherung `.vor-sperre-20260905`).
  Das Zugriffsprotokoll reichte nur bis zum selben Tag zurück; ob vorher
  jemand zugegriffen hat, ist nicht belegbar.

nginx braucht kein Neuladen — es liest die Dateien bei jedem Request.

## Zwischenspeicher — warum zwei gleiche Dateien verschieden aussehen

Am 5.9.2026 lieferten `www` und `noc` byteweise dieselbe `noc-fullscreen.html`
aus, und das Wandbild zeigte trotzdem den alten Stand. Der Grund stand in den
Kopfzeilen: Der **noc-Serverblock auf fe-isp hatte als einziger keine
Cache-Regel für HTML** — Browser und Cloudflare durften die Seite beliebig
lange behalten. Behoben mit `location ~* \.(html|json)$` samt
`CDN-Cache-Control: no-store` im noc-Block, plus einmaligem Leeren des
Cloudflare-Zwischenspeichers über die API.

Prüfen lässt sich das in einer Zeile:

```bash
curl -sI https://noc.rosenweg4303.ch/ | grep -i cache-control   # muss no-cache zeigen
```

### Der Block gehört *nicht* nach oben in die stweg-Konfiguration

Ein Versuch, dieselbe Regel auch bei `fe-stweg1..7` und `fe-meg` einzufügen,
hat acht Frontends lahmgelegt und musste zurückgenommen werden. Zwei Gründe:

1. **Die Regel war dort längst vorhanden** — als `location ~* \.html$` mit
   `try_files /$site$uri @www_fallback`. Diese Container bedienen mehrere
   STWEG unter einer Konfiguration; der Host wählt über `$site` das
   Unterverzeichnis.
2. **Eine zusätzliche Regex-Location ohne `try_files` gewinnt**, weil nginx
   Regex-Locations in Reihenfolge ihrer Definition prüft. Alle `.html`-Adressen
   wurden dadurch aus dem Wurzelverzeichnis statt aus `/$site/` bedient — 404.

Offen bleibt dort nur die nackte Adresse `/`: Sie wird von
`location = / { try_files /$site/index.html =404; }` bedient, und dieser Block
setzt keine Kopfzeile. Wer das ändern will, ergänzt **genau dort** ein
`add_header`, nicht eine neue Location weiter oben.

### Sicherungen von nginx-Konfigurationen

`/etc/nginx/sites-enabled/rosenweg.conf` ist ein **Symlink** nach
`sites-available/`. `cp -a` darauf kopiert nur den Symlink — die vermeintliche
Sicherung zeigt auf dieselbe Datei, und ein Zurückspielen tut nichts. Immer
`cp -L` verwenden und in `sites-available/` ablegen.

**Das NOC-Wandbild** ist der Grund für das Skript — siehe oben; von Hand nur noch im Notfall.

Die API dagegen läuft weiterhin in Docker, auf CT 128 (`core-backend`):

```bash
ssh -J stefan@10.0.10.149 root@100.64.2.20 \
  'pct exec 128 -- sh -c "cd /opt/rosenweg-core && docker compose pull api && docker compose up -d api"'
```
