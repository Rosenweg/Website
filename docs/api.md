# API Server — Rosenweg

## Übersicht

Node.js Express Server (`api/server.js`) mit folgenden Funktionen:
- Authentik OAuth2 SSO Login/Callback
- Dokumentenverwaltung (CIFS-Mount)
- Email-Verteiler (IMAP-Polling + SMTP2GO)
- Energie-Monitoring (Stromzähler)
- Benutzerverwaltung (Authentik + AD)
- DMARC-Report Parsing
- Proxmox-Integration

## Authentifizierung

### OAuth2 Flow
1. Browser → `/api/auth/login?redirect=/path` → Redirect zu Authentik
2. Authentik → `/api/auth/callback?code=...&state=...` → Token-Exchange
3. API setzt Session-Token → Redirect zurück mit `#auth={token,user}`

### Token-Validierung
- Bearer Token im `Authorization` Header
- Introspection via `AUTHENTIK_URL/application/o/introspect/`
- Cache: 1 Minute TTL
- User wird in DB angelegt/aktualisiert bei jedem Login

### Rollen
- `admin`: Mitglied der Authentik-Gruppe `Technik` oder `Präsident`
- `bewohner`: Alle anderen

## Endpunkte

### Auth
| Method | Path | Auth | Beschreibung |
|--------|------|------|-------------|
| GET | `/api/auth/login` | — | OAuth2 Login-Redirect |
| GET | `/api/auth/callback` | — | OAuth2 Callback |
| GET | `/api/auth/me` | Bearer | User-Info |
| POST | `/api/change-password` | Bearer | Passwort in Authentik + AD ändern |

### Dokumente
| Method | Path | Auth | Beschreibung |
|--------|------|------|-------------|
| GET | `/api/documents/*` | Bearer | Datei/Ordner lesen |
| POST | `/api/documents/*` | Bearer+Admin | Datei hochladen |
| DELETE | `/api/documents/*` | Bearer+Admin | Datei löschen |
| GET | `/api/documents/preview/*` | Bearer | DOCX/PDF Vorschau (via Gotenberg) |
| POST | `/api/scan-upload` | API Key | Scanner-Upload |

### Email-Verteiler
| Method | Path | Auth | Beschreibung |
|--------|------|------|-------------|
| GET | `/api/verteiler` | Bearer+Admin | Verteiler-Liste |
| GET | `/api/verteiler/:name/emails` | Bearer+Admin | Mails eines Verteilers |

### Energie
| Method | Path | Auth | Beschreibung |
|--------|------|------|-------------|
| GET | `/api/energy/meters` | Bearer | Zähler-Liste |
| GET | `/api/energy/readings` | Bearer | Messwerte |
| GET | `/api/energy/tariffs` | Bearer | Tarife (Netztarif, Solartarif) |

### Benutzerverwaltung
| Method | Path | Auth | Beschreibung |
|--------|------|------|-------------|
| GET | `/api/users` | Bearer+Admin | Alle Benutzer |
| PUT | `/api/users/:id` | Bearer+Admin | Benutzer bearbeiten |
| POST | `/api/users/:id/password` | Bearer+Admin | Passwort setzen (Authentik + AD) |

### DMARC
| Method | Path | Auth | Beschreibung |
|--------|------|------|-------------|
| GET | `/api/dmarc/reports` | Bearer+Admin | DMARC-Reports aus Gmail parsen |

### SMTP Quota
| Method | Path | Auth | Beschreibung |
|--------|------|------|-------------|
| GET | `/api/smtp-quota` | Bearer+Admin | SMTP2GO Kontingent |

## Umgebungsvariablen

### Datenbank
| Variable | Wert | Beschreibung |
|----------|------|-------------|
| DB_HOST | postgres | PostgreSQL Host (Docker-intern) |
| DB_PORT | 5432 | PostgreSQL Port |
| DB_USER | rosenweg | DB Benutzer |
| DB_PASSWORD | RwDb2026 | DB Passwort |
| DB_NAME | rosenweg | DB Name |

### Energie-DB
| Variable | Wert | Beschreibung |
|----------|------|-------------|
| ENERGY_DB_HOST | energy-db | Energie-DB Host |
| ENERGY_DB_USER | energy | Energie-DB Benutzer |
| ENERGY_DB_PASSWORD | energy2026 | Energie-DB Passwort |
| ENERGY_DB_NAME | energy | Energie-DB Name |

### Authentik
| Variable | Wert | Beschreibung |
|----------|------|-------------|
| AUTHENTIK_URL | https://server:9443 | Interne URL (Server-to-Server) |
| AUTHENTIK_EXTERNAL_URL | https://authentik.rosenweg4303.ch | Externe URL (Browser-Redirects) |
| AUTHENTIK_CLIENT_ID | 35oy6Q... | OAuth2 Client ID |
| AUTHENTIK_CLIENT_SECRET | QTIL0L... | OAuth2 Client Secret |
| AUTHENTIK_API_TOKEN | oqCfoI... | Admin API Token |

### Email
| Variable | Wert | Beschreibung |
|----------|------|-------------|
| SMTP_HOST | mail-eu.smtp2go.com | SMTP2GO Host |
| SMTP_PORT | 2525 | SMTP2GO Port (TLS) |
| SMTP_USER | rk-website | SMTP2GO User |
| SMTP_PASS | BvyLJU... | SMTP2GO Passwort |
| MAIL_FROM | noreply@rosenweg4303.ch | Absender |
| IMAP_USER | rosenweg4303@gmail.com | Gmail für IMAP-Polling |
| IMAP_PASS | ykst kwwe kakp tqjn | Gmail App-Passwort |

### AD / Passwort-Sync
| Variable | Wert | Beschreibung |
|----------|------|-------------|
| AD_PASSWORD_API_URL | http://100.64.2.30:8446/ | DC Password API |
| AD_PASSWORD_API_SECRET | RwAdPwApi2026! | DC Password API Token |

### Sonstiges
| Variable | Wert | Beschreibung |
|----------|------|-------------|
| SITE_URL | https://www.rosenweg4303.ch | Website URL |
| DOCS_PATH | /documents | CIFS-Mount Pfad |
| SCAN_API_KEY | 171fd3... | API Key für Scanner-Upload |
| PORT | 3000 | API Server Port |

## IMAP-Polling

- Pollt Gmail (`rosenweg4303@gmail.com`) alle 60 Sekunden
- Verarbeitet Plus-Tags: `rosenweg4303+ausschuss@gmail.com` → Verteiler `ausschuss@rosenweg4303.ch`
- Spezialbehandlung:
  - `dmarc@` → In DMARC-Ordner verschieben
  - `archiv@` → In Email-Archiv-DB speichern
  - Alle anderen → Verteiler-DB + Weiterleitung
