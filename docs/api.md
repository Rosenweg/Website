# API-Server – Übersicht, Anmeldung, Bereiche, Fehlercodes

Stand: 17.11.2026 (nach der Sicherheitsprüfung, PR #23). Dieses Dokument ist die
Landkarte der Haupt-API: wie man sich ausweist, welche Bereiche es gibt, wer welche
Routen aufrufen darf und was die Fehlercodes bedeuten. Sicherheitsregeln,
Grenzwerte und alle sicherheitsrelevanten Variablen stehen in
[`sicherheit.md`](sicherheit.md); die vollständige Rechte-Matrix nach Rollen in
[`../wiki/berechtigungen.md`](../wiki/berechtigungen.md).

---

## 1. Betrieb

| | |
|---|---|
| Code | `api/server.js` (Haupt-App, ~530 Routen), `api/routes/*.js` (Router: `email-archive`, `energie-lesen`, `grundbuch`, `meg`, `ssh-zugang`, `stations`), `api/lib/doodle.js`, `api/lib/alarmpanel.js`, `api/mcp/` (MCP-Server) |
| Middleware | `api/middleware/auth.js` (`authMiddleware`, `adminOnly`, `requirePermission`, `requireUserLogin`, `scopeErlaubt`) |
| Laufzeit | Docker-Image `ghcr.io/rosenweg/rosenweg-api`, Dienst `api` im Compose-Projekt `/opt/rosenweg-core/` auf **CT 128** (`100.64.2.52:3000`); Datei im Repo `backend-lxc/core/compose.yml` |
| Umgebung | `/opt/rosenweg-core/.env` (Geheimnisse) plus feste Werte in der Compose-Datei |
| Erreichbar | über die Frontend-LXCs (`location ^~ /api/` → `upstream rw_api` in `frontends-lxc/nginx/upstreams.conf`) unter `www.`, `isp.`, `pwa.`, `stwegN.`, `meg.rosenweg4303.ch` und `rosenweg9.ch`; MCP zusätzlich unter `mcp.rosenweg4303.ch` |
| Ausrollen | `cd /opt/rosenweg-core && docker compose pull api && docker compose up -d api` (Reihenfolge und Rückbau: [`sicherheit.md`](sicherheit.md) Abschnitt 8) |
| Gesundheit | `GET /api/health` → `{status, db, dokumente}`; 503 nur, wenn die DB nicht antwortet (eine leere Dokumentenablage meldet `dokumente: "leer"`, ohne 503) |

**CORS:** erlaubt sind `SITE_URL`, `https://rosenweg4303.ch`, `https://www.rosenweg4303.ch`,
`https://tv.rosenweg4303.ch` und jede `https`-Unterdomain von `rosenweg4303.ch` ohne
Port; Anfragen ohne `Origin` (curl, Geräte, Server) ebenfalls. Andere Herkunft →
**403** „Herkunft nicht erlaubt“.

**Körpergrössen:** JSON bis 10 MB; Dokument-Upload (`application/octet-stream`) und
Scanner bis 500 MB, Vollmacht-PDF 20 MB, Voicemail-WAV 50 MB, eingehende Mail 25 MB.
Grosse Körper werden erst gelesen, **nachdem** der Ausweis geprüft ist. Zu gross →
**413** „Anfrage zu gross“; nginx begrenzt `/api/` zusätzlich auf 100 MB.

---

## 2. Ausweise (Authentifizierung)

Alle geschützten Routen erwarten `Authorization: Bearer <token>`. `authMiddleware`
prüft der Reihe nach: **PAT** (Präfix `rw_pat_`) → **Sitzungstoken** → **Authentik-Token**.
Kein Header → **401** „Nicht authentifiziert“; nichts passt → **401** „Session
abgelaufen“. Dienste, Geräte und Hosts haben eigene Geheimnisse (Abschnitt 2.5).

### 2.1 Browser-Sitzung (Authentik OAuth2)

1. Seite ruft `GET /api/auth/login?redirect=/pfad` (bei `?reauth=1` mit
   `prompt=login`, z. B. vor dem Passwortwechsel).
2. Die API erzeugt einen **signierten, einmaligen `state`** (HMAC, Schlüssel je
   Prozessstart, 10 Min. gültig) und setzt das Cookie `rw_oauth_bind`
   (HttpOnly, Secure, SameSite=Lax, Path=`/api/auth/callback`, 10 Min.). Danach
   Umleitung zu Authentik.
3. Authentik → `GET /api/auth/callback?code=…&state=…`. Fehlt das Cookie oder passt
   es nicht zum `state` → Seite „Anmeldung abgebrochen“ (**400**). Ungültiger oder
   abgelaufener `state` → **400** „Ungültiger oder abgelaufener State-Parameter“.
   Nach einem Neustart der API muss eine laufende Anmeldung neu begonnen werden.
4. Die API tauscht den Code, legt/aktualisiert die Zeile in `users` und bindet sie
   an das Authentik-Konto (`users.authentik_sub`). Gehört die E-Mail schon einem
   anderen Konto → **403** „Diese E-Mail gehört zu einem anderen Konto“.
5. Sie legt eine Sitzung an (`sessions`, 30 Tage, verlängert sich bei Benutzung) und
   leitet zurück auf `<origin><redirect>#auth=<token,user>`. `js/authentik-auth.js`
   übernimmt das Token nur, wenn `login()` im selben Browser in den letzten 15 Min.
   gestartet wurde, und holt das Benutzerobjekt von `/api/auth/me`.

Erlaubte Rücksprung-Hosts stehen in `OAUTH_ALLOWED_HOSTS` (`api/lib/config.js`);
`redirect` muss ein Pfad sein (`/…`, nicht `//…`). Abmelden:
`GET /api/auth/logout?redirect=…` (beendet auch die Authentik-Sitzung).

**Rolle:** Beim Login bekommt die Zeile `role='admin'`, wenn die Person in `technik`
oder `Präsident` ist; daraus folgt `req.user.isAdmin`.

### 2.2 Authentik-Token

Ein Access-Token von Authentik (z. B. aus einer App) wird per Introspection geprüft
(`AUTHENTIK_URL/application/o/introspect/`, Ergebnis 1 Minute zwischengespeichert).
Auch hier gilt die Bindung an `users.authentik_sub`: passt das Konto nicht zur
gebundenen Zeile, wird der Token abgewiesen (**401**). Gruppen kommen aus dem Token.

### 2.3 Persönlicher Zugangstoken (PAT)

Für Skripte, Agenten und den MCP-Server.

- **Anlegen** nur aus einer Browser-Sitzung (Profil → Zugangstoken):
  `POST /api/me/tokens` mit `{ "name": "…", "scopes": ["…"], "expires_days": 90 }`.
  Antwort enthält den Klartext **einmalig** (`rw_pat_` + 64 Hex-Zeichen); gespeichert
  wird nur der SHA-256-Hash. `GET /api/me/tokens` listet, `DELETE /api/me/tokens/:id`
  widerruft.
- **Gültig**, solange nicht widerrufen, nicht abgelaufen und das Konto aktiv ist.
  Jede Benutzung schreibt `last_used_at` und `last_used_ip`. Wird das Konto in
  Authentik gelöscht, widerruft die API alle PATs.
- **Rechte:** die der Person (Gruppen aus `users.groups_json`), eingeschränkt durch
  die Scopes. `isAdmin` gilt bei `role='admin'` oder Gruppe `technik`.

**Scopes** (`scopeErlaubt` in `api/middleware/auth.js`; kein Scope = alle Rechte):

| Scope | erlaubt |
|---|---|
| `*` | alles |
| `all:read` / `all:write` | alle GET-Routen / alle anderen Methoden |
| `<segment>:read`, `<segment>:write`, `<segment>:*` | erstes Pfadsegment nach `/api/`, z. B. `wasch:*`, `reklamationen:write`, `energy:read` |
| `<segment>/<unter>:…` | feiner, z. B. `isp/vpn-accounts:read` |
| `docs:read` | nur MCP: Dokumentations-Ressourcen (siehe [`mcp.md`](mcp.md)) |

`GET` zählt als `read`, alles andere als `write` (darum braucht die Suche
`POST /api/ki-search` den Scope `ki-search:write`). Pfad und Scopes werden
klein geschrieben verglichen. Fehlt der Scope → **403** „PAT-Scope fehlt:
<segment>:<read|write>“.

**Für PATs gesperrte Pfade** (`PAT_GESPERRT`, gilt unabhängig von den Scopes; der
Pfad wird vorher normalisiert – Gross/Klein, doppelte und abschliessende `/`):

| Pfad unter `/api/` | Grund |
|---|---|
| `change-password` | Passwort ändern verlangt kein altes Passwort |
| `me/tokens` | Token dürfen keine Token erzeugen oder widerrufen |
| `me/passkeys` | Passkeys |
| `auth` (alles darunter, auch `auth/profile`, `auth/avatar`) | OAuth-Fluss, Profil-Login |
| `mqtt/my-app-passwords`, `mqtt/user-app-passwords` | MQTT-Zugangsdaten |

Antwort: **403** „Mit einem Zugangstoken nicht erlaubt — nur angemeldet im Profil“.
Zusätzlich sperrt `requireUserLogin` an der Route: `/api/me/tokens`, `/api/me/passkeys`,
`/api/ssh/me/*` (SSH-Schlüssel, GitHub-Abgleich), `/api/mqtt/my-access` und die
MQTT-App-Passwörter (**403** „Token-Verwaltung nur via Browser-Login“).

```bash
T="rw_pat_…"   # im Passwortmanager, nie im Repo
curl -s -H "Authorization: Bearer $T" https://www.rosenweg4303.ch/api/me
curl -s -H "Authorization: Bearer $T" https://www.rosenweg4303.ch/api/wasch/my/reservations
```

### 2.4 Einmal-Codes (ohne Konto)

| Route | Zweck | Zustand |
|---|---|---|
| `POST /api/reklamationen/code`, `POST /api/reklamationen/oeffentlich` | Reparatur melden ohne Konto | aktiv |
| `POST /api/doodle/code`, `POST /api/doodle/verify` | Terminumfrage ohne Konto | aktiv |
| `POST /api/otp/send`, `POST /api/otp/verify` | Login per E-Mail-Code | **abgeschaltet** (404), solange `OTP_LOGIN_ENABLED` nicht `1` |

Codes: 8 Ziffern, zweckgebunden, 10 Min. gültig, 5 Versuche je Code; Ausstellen
antwortet immer gleich. Grenzwerte (je IP, je Adresse, global) und die nginx-Drossel
`rw_otp`: [`sicherheit.md`](sicherheit.md) Abschnitt 4.2. Zu viele Fehlversuche →
**429** „Zu viele Fehlversuche. Bitte einen neuen Code anfordern.“; falscher Code →
**400** „Ungültiger Code“; abgelaufen/kein Code → **400** mit Hinweis, einen neuen
anzufordern.

### 2.5 Dienst-, Host- und Geräte-Ausweise

Diese Routen nehmen **kein** Benutzer-Token, sondern ein Geheimnis im Header. Alle
Vergleiche laufen in konstanter Zeit. Fehlt das Geheimnis in der Umgebung, ist die
Schnittstelle zu (fail closed).

| Routen | Header / Ausweis | Variable | falsch → | Variable fehlt → |
|---|---|---|---|---|
| `POST /api/email/inbound` | `X-Email-Secret` | `EMAIL_INBOUND_SECRET` | 401/403 | 401/403 |
| `POST /api/scan-upload` | `X-Api-Key`, Datei in `X-Filename` | `SCAN_API_KEY` | 401 | 401 |
| `/api/pbx/voicemail`, `call-notify`, `voicemail-reklamation`, `cnam/:nr`, `hours/check`, `ring-members/active`, `call-event` | `X-Pbx-Secret` | `PBX_SHARED_SECRET` | 401 | 503 |
| `/api/whatsapp/inbound`, `backfill`, `outbox-poll`, `status`, `delete-poll`, `delete-status`, `heartbeat`, `qr`; `/api/technik-bot/resolve/:id` | `X-Wa-Secret` | `WHATSAPP_SHARED_SECRET` | 401 | 503 |
| `GET /api/traefik/dynamic`, `GET /api/isp/traefik-config` | `X-Traefik-Secret` | `TRAEFIK_CONFIG_SECRET` | 403 | 403 |
| `POST /api/isp/relay-status/ingest`, `POST /api/isp/outbound-usage/ingest`, `GET /api/verteiler/mailcow-gate` | `X-Tracker-Secret` | `TRACKER_SHARED_SECRET` | 403 | 403 |
| `POST /api/pve-messages` | `X-Pve-Secret` | `PVE_MSG_SECRET` | 403 | 503 |
| `POST /api/alarm` | `X-Alarm-Secret` | `ALARM_SECRET` | 403 | 403 |
| `/api/mqtt/getuser`, `superuser`, `aclcheck`; `POST /api/wetter/:station/ingest` | Query `?k=` (vom Broker) | `MQTT_AUTH_SECRET` | 403 | 403 |
| `/api/ssh/authorized-keys/:login`, `konten`, `sitzung`, `dienste` (POST) | `X-Host-Token` | `SSH_HOST_TOKEN` | 403; nach > 20 Fehlversuchen je Quelle 429 | 503 |
| `GET /api/cf-ddns` | `Authorization` | `CF_DDNS_TOKEN` | Fehlertext | `badconfig` (500) |
| `POST /api/stations/login`, `POST /api/stations/app-login` | AD-Benutzer und -Passwort im Körper; liefern Einrichtungs- bzw. App-Token | – | 401; 10 Fehlversuche / 15 Min. je Name bzw. 50 je IP → 429 | 503, wenn das AD nicht erreichbar ist |
| `/api/stations/register`, `types` | `Bearer rw_setup_…` (Einrichtungstoken) | – | 401 | – |
| `/api/stations/:id/*`, `/api/benutzer/:login/einstellungen` | `Bearer rw_station_…` (Stationstoken) | – | 401 | – |
| `/api/stations/telefonbuch`, `os`, `POST /api/stations/:id/tunnel` | `Bearer rw_app_…` (App-Sitzung) | – | 401 | – |
| `/api/tv/stream/:id?token=`, `/api/tv/extern*` | signierter Stream-Token bzw. Extern-Token | `TV7_HMAC_SECRET` | 401 | – |
| `/api/pickup/:token` (Druck-Abholung) | Abholtoken im Pfad (8–64 Zeichen) | – | 404 „Druckauftrag nicht gefunden“ | – |

Werte stehen nur in `/opt/rosenweg-core/.env` bzw. beim jeweiligen Dienst (Liste
und Rotation: [`sicherheit.md`](sicherheit.md) Abschnitte 6 und 7.1). Header statt
Query, weil Query-Werte in Zugriffslogs landen; Ausnahme ist der MQTT-Broker (`?k=`).

---

## 3. Rollen in Kürze

| Rolle | Erkennung | Kurz |
|---|---|---|
| Technik / Präsident | Gruppe `technik` / `Präsident`; `isAdmin` | alles; bestehen jede `requirePermission`-Prüfung |
| Verwaltung | Gruppe `verwaltung` | Seitenrechte aus der Rechteverwaltung; schreibt in STWEG-Bereichen nur mit Gruppe dieser STWEG |
| Ausschuss | `stwegN-ausschuss`, `meg-ausschuss` | verwaltet nur **seine** STWEG |
| Eigentümer | `*-eigentuemer`, `eigentuemer` | eigene Daten, Projekte, Auslagen einreichen |
| Bewohner / Mieter | `*-bewohner`, `bewohner` | eigene Daten, Waschküche, Meldungen |
| Anonym | – | öffentliche Routen (Abschnitt 4.1) |

Seitenrechte (`requirePermission(seite, read|write)`) kommen aus der Tabelle
`permissions`. Vollständige Matrix: [`../wiki/berechtigungen.md`](../wiki/berechtigungen.md).

---

## 4. Bereiche und wichtigste Routen

Spalte **Wer**: `angemeldet` = jede gültige Anmeldung; `T/P` = Technik oder Präsident;
`A🅢` = Ausschuss der betroffenen STWEG; `Recht x:y` = `requirePermission('x','y')`.

### 4.1 Öffentlich (ohne Anmeldung)

| Route | Inhalt |
|---|---|
| `GET /api/health` | Zustand |
| `GET /api/auth/login`, `/callback`, `/logout` | Anmeldung |
| `POST /api/reklamationen/code`, `/oeffentlich`; `POST /api/doodle/code`, `/verify`; `GET/POST /api/doodle/public/:id` | Code-Abläufe |
| `GET /api/melde-ort/:code` | Melde-Ort zu einem QR-Code |
| `POST /api/kontakt` | Kontaktformular der Startseite: Mail an technik@ (Honigtopf, Drossel je IP und gesamt, Absender nur Reply-To; `lib/kontaktformular.js`) |
| `GET /api/energy/{surplus,surplus-available,lametric,shelly,solar-live,tariffs,tariffs/current}` | Geräte und Anzeigen, ohne `consumers` ([`energie-api.md`](energie-api.md)) |
| `GET /api/public/ausschuss`, `/api/public/technik`, `/api/verwaltungen/public` | öffentliche Kontakte |
| `GET /api/stweg/:stweg/wohnungen` | ohne Anmeldung nur `anzahl` (`eingeschraenkt: true`); Belegung, Besonderheiten, Wertquote je Wohnung nur mit Anmeldung als Mitglied der STWEG, ihre Verwaltung, T/P (F1, 28.11.2026) |
| `GET /api/stweg/:stweg/overview` | Zahlen zur STWEG (ohne Namen) |
| `GET /api/stweg-modules` | aktive Module je STWEG (bekannt: nur `waschkueche`; `seiten-editor` entfällt) |
| `GET /api/stweg/meine` | Gemeinschaften des Kontos (Rolle, `darf`, Module, `dokZugang`) für Rosenweg STWEG; `kooperation.schreiben` |
| `GET /api/stweg/:nr/mitteilungen` | Mitteilungen (Markdown `text` und gerendertes `html`); `nr` 0 = Kooperation; ohne Anmeldung nur `oeffentlich`; `?wichtig=1`; Schreibende sehen mit `?alle=1` auch abgelaufene |
| `GET /api/stweg-bilder/:id` | Bild einer Mitteilung (Sicht wie die Mitteilung) |
| `GET /api/stweg/:nr/kontakte.pdf`, `/wohnungen.pdf`, `GET /api/meg/einstellplaetze.pdf` | PDF mit Vermerk „vertraulich“ (Einstellplätze nur Verwalter der MEG) |
| `GET /api/verteiler/by-stweg/:stweg` | Namen und Adressen der Verteiler einer STWEG |
| `GET /api/calendar` | Termine (503, wenn `GOOGLE_CALENDAR_ICS_URL` fehlt) |
| `GET /api/public/project/:slug`, `…/document/:path` | öffentlich geschaltete Projekte: Kandidaten nur `id, name, webseite, status`, nur als öffentlich markierte Anhänge (`oeffentlich`) |
| `GET /api/unterschriftenliste/verify-json`, `verify`, `snapshot/:hash.pdf` | Echtheitsprüfung (30 / 10 Min. je Client) |
| `GET /api/display/pdf/:name`, `pdfbild/:name`, `geraetedatei/…`, `rss` | Anzeigen im Treppenhaus |
| `GET /api/isp/noc/public/*`, `/api/isp/status-summary`, `/api/isp/maintenance/public` | NOC-Wandbild (gekürzt), Störungen |
| `GET /api/isp/noc/public/stationen` (Token) bzw. `/api/isp/noc/stationen` (Technik/Präsident) | Stationen im NOC: Zusammenfassung + je Gerät Kennung, Rolle, Haus, Standort, Ampel, OS/Agent — **ohne** Personen, IPs, Overrides (`api/lib/nocstationen.js`, 15 s Cache); anonym (`NOC_PUBLIC_OPEN`) nur „Station n“ |
| `GET /api/isp/noc/public/server` (Token) bzw. `/api/isp/noc/server` (Technik/Präsident) | Server im NOC: Proxmox-Knoten (CPU/RAM/Last/Uptime, HA-LRM), Quorum, HA, Ceph-Health mit Gründen, SSD-Abnutzung (100 − `wearout`), Gäste mit Autostart, die nicht laufen; PBS-Belegung, GC/Prüf-/Aufräum-Jobs, fehlgeschlagene Aufgaben (24 h), letzte Sicherung je Gast (> 36 h gelb). Nur lesend über `PVE_AUDIT_TOKEN` (PVEAuditor) und `PBS_AUDIT_TOKEN` (Audit), 30 s Cache (`api/routes/nocserver.js`, `api/lib/nocserver.js`) |
| `GET /api/meg/einstellplaetze/verfuegbar` | freie Einstellplätze (ohne Personendaten) |
| `GET /api/tv/playlist.m3u`, `/api/tv/epg.xml` | TV-Senderliste |

| `GET /api/wetter/:station/history`, `GET /api/push/vapid-public-key`, `GET /api/nav/audience-map` | Wetter, Push-Schlüssel, Menü-Zuordnung |
| `GET /api/stations/drucker/:rechner` | Standarddrucker eines Rechners (`{"rechner","bekannt","standard"}`), **nur aus dem internen Netz** (jede Adresse in `X-Forwarded-For` muss innen liegen, sonst 403), `Cache-Control: no-store`; gesperrte/entfernte Stationen gelten als unbekannt |

### 4.2 Konto und Profil (`me`, `auth`)

| Route | Wer | Bemerkung |
|---|---|---|
| `GET /api/auth/me`, `GET /api/me` | angemeldet | Benutzer, Gruppen, Rechte |
| `GET /api/me/wohnungen`, `GET/PUT /api/me/wohnung/:id`, `PUT /api/me/kontakt/:id` | angemeldet, eigene | neue Kontakte nie mit fremden Personen verknüpft; fremde E-Mail/Telefon → 409 |
| `PUT /api/me/phones`, `PUT /api/me/emails`, `PUT /api/me/whatsapp-optin` | angemeldet | 409 bei Adressen anderer Personen/Konten |
| `GET/POST /api/me/mutation` | angemeldet | Adressmutation als Antrag |
| `POST /api/change-password` | Browser-Sitzung ≤ 15 Min. alt, nicht per PAT | 5 / Std.; 403 mit `reauth: true`, wenn die Sitzung zu alt ist; danach andere Sitzungen gelöscht |
| `PUT /api/auth/profile`, `PUT /api/auth/avatar` | Browser-Sitzung | Avatar nur PNG/JPEG/WebP ≤ 512 KB |
| `/api/me/tokens`, `/api/me/passkeys` | Browser-Sitzung | siehe 2.3 |
| `GET/PUT /api/me/einstellungen` | angemeldet | persönliche Einstellungen |
| `GET/PUT /api/me/app-daten/:app` | angemeldet, nur die Person selbst; Karten-Sitzung und geteiltes Telefon nur für die eigene App | persönliche Daten einer Rosenweg-App (z. B. Wecker der Uhr) als Einträge; `?seit=<version>`, je Eintrag gilt die letzte Änderung, Löschen als Grabstein (`api/lib/app-daten.js`) |

### 4.3 Benutzer und Rechte (`admin`, `permissions`, `personen`)

| Route | Wer |
|---|---|
| `GET /api/admin/users` | T/P alle; Ausschuss nur Konten der eigenen STWEG; sonst 403 |
| `POST /api/admin/users` | Recht `bewohner-verwaltung:write`; Nicht-T/P ohne Passwort, Name `vorname.nachname`, nur Bewohner-/Eigentümer-Gruppen der eigenen Ausschuss-STWEG; Kollision (auch Gross/Klein, auch E-Mail) → 409 |
| `PUT /api/admin/users/:pk` | T/P; Ausschuss nur Konten seiner STWEG, ohne E-Mail, Aktivierung, Gruppen, nie Technik-/Präsident-Konten |
| `DELETE /api/admin/users/:pk` | nur T/P (sonst 403 „Konten löschen kann nur Technik“) |
| `GET /api/admin/groups`, `PUT /api/admin/groups/:pk/add_user|remove_user` | Recht `bewohner-verwaltung`; Nicht-T/P nur eigene Bewohner-/Eigentümer-Gruppen; Gruppen-IDs nur als UUID |
| `GET/PUT /api/admin/pending-deletions…`, `GET /api/admin/mail-chain` | T/P |
| `GET/PUT /api/permissions`, `GET /api/permissions/pages` | Recht `rechteverwaltung` |
| `GET /api/personen`, `/api/personen/:id` | Recht `wohnungsverwaltung:read`, nur eigene STWEG(s); `geburtsdatum` nur T/P, `notiz` nur Ausschuss und T/P (Antwort `felder`) |
| `PUT /api/personen/:id`, `POST /api/personen`, `POST /api/personen/merge`, `GET /api/personen-dedup/kandidaten` | Recht `wohnungsverwaltung:write`; ändern/zusammenführen Ausschuss und Verwaltung nur eigene STWEG, geschützte Personen nur T/P (409); Zusammenführen hängt alle Verweise um (Antwort `umgehaengt`); protokolliert |
| `GET /api/users` | T/P; `GET /api/users/:id` nur eigene Zeile oder T/P |

### 4.4 STWEG-Verwaltung (`wohnungen`, `zev`, `unterschriftenliste`, `verwaltungen`, `stweg*`)

| Route | Wer |
|---|---|
| `GET /api/wohnungen/:stweg`, `…/:id`, `…/stats` | Recht `wohnungsverwaltung:read` + Gruppe dieser STWEG (T/P immer) |
| `POST/PUT /api/wohnungen/:stweg…`, `POST …/kontakte/:kid/archive` | Recht `wohnungsverwaltung:write` + `requireStwegWrite` (A🅢, T/P, Verwaltung mit Gruppe der STWEG) → sonst 403 „Schreiben nur für den Ausschuss dieser STWEG“; protokolliert (`admin_protokoll`, Bereich `objekte`) |
| `DELETE /api/wohnungen/:stweg/:id`, `POST …/import` | nur T/P, protokolliert |
| `POST /api/objekte/export` | Export vorher anmelden: `{ art: wohnungen\|eigentuemer\|personen, stweg?, format?, anzahl? }`; mit `stweg` Ausschuss/Verwaltung dieser STWEG oder T/P, sonst Ausschuss/Verwaltung/T/P; protokolliert |
| `GET /api/wohnungen/:stweg/:id/historie` | T/P, Verwaltung, Ausschuss (mit Zugang zur STWEG) |
| `GET /api/wohnungen/eigentuemer-uebersicht` | Recht `wohnungsverwaltung:read` |
| `GET/PUT /api/zev/config/:stweg`, `GET /api/zev/wohnungen/:stweg`, `POST /api/zev/sync/:stweg` | Recht `wohnungsverwaltung` + Ausschuss/Verwaltung **dieser** STWEG oder T/P (`requireZevAdmin`, `lib/zev.js` `zevAdminFuerStweg`; eine andere Gruppe der STWEG reicht seit 28.11.2026 nicht mehr). PUT/POST zusätzlich `requireStwegWrite`; Alias-Domain/-Prefix nur T/P. `sync` = Aliase in Mailcow abgleichen (keine smart-me-Schnittstelle) |
| `GET /api/zev/unzugeordnet`, `GET /api/zev/rechnungen/:stweg`, `POST /api/zev/rechnung/:id/zuordnen` | Recht `wohnungsverwaltung`; Zuordnen und Umhängen (protokolliert) A🅢 und Verwaltung der STWEG der Rechnung, Rechnungen ohne STWEG nur T/P; Listen mit `remail_status`, `has_pdf` |
| `GET /api/zev/meine-rechnungen`, `POST …/rechnung/:id/bezahlt` | angemeldet, eigene (`zevDarfRechnungSehen`); Datumsfelder zusätzlich als `rechnungsdatum_iso`, `zeitraum_von_iso`, `zeitraum_bis_iso` (yyyy-mm-dd), auch in den Admin-Listen |
| `GET /api/zev/rechnung/:id/pdf` | eigene; dazu Ausschuss/Verwaltung der STWEG (mit `wohnungsverwaltung:read`) und T/P für **unzugeordnete und Allgemeinzähler**-Rechnungen; Wohnungsrechnungen anderer nie |
| `GET /api/zev/uebersicht` | angemeldet: `{zevs:[{stweg, aktiv, haeuser, rechte:{lesen, schreiben, alias}, unzugeordnet}], bewohner, admin, unzugeordnet_ohne_stweg (T/P), poller:{letzter_abruf, fehler}, einrichtbar (T/P)}`; inaktive ZEVs nur mit Leserecht |
| `GET /api/zev/meine-statistik` | angemeldet: je Jahr `{jahr, anzahl, kwh, solar_kwh, netz_kwh, solar_anteil, chf, rp_kwh_solar, rp_kwh_netz}` aus den eigenen Rechnungen (Solar = Position mit „solar“ im Namen) |
| `GET /api/zev/neuigkeiten` | angemeldet, für die Hintergrundabfrage der App: eigene Rechnungen (`id, objekt, betrag_chf, zeitraum_*_iso, bezahlt`) und für Admins unzugeordnete (`id, stweg, empfangen_am`) |
| `GET /api/zev/wechsel/:stweg` | wie `config`: Meldungen an den Messdienst mit Status in der Freigabe-Outbox |
| `GET /api/unterschriftenliste/:stweg.pdf` | Recht `wohnungsverwaltung:read` + `requireStwegWrite` |
| `GET/PUT /api/unterschriftenliste/:hash/rueckläufe…` | lesen und schreiben nur Ausschuss/Verwaltung dieser STWEG und T/P (`zevAdminFuerStweg` bzw. `stwegSchreibErlaubt`); schreiben protokolliert; Listen 10 Jahre aufbewahrt |
| `GET /api/stweg/:nr/kontakte`, `GET /api/kontakte/:stweg` | Gruppe dieser STWEG oder T/P; `PUT /api/kontakte` nur T/P |
| `GET/POST/PUT/DELETE /api/verwaltungen…` | Ausschuss/T/P; Ausschuss liest eigene + STWEG-übergreifende, ändert nur eigene; die Hausverwaltung (`stwegN-verwaltung`) liest ihren eigenen Eintrag ohne Plattform-Passwort und Notizen und ändert nur Kontaktpersonen und Kontaktdaten (PUT, `…/kontakte`); anlegen/löschen nicht |
| `GET /api/verwaltungen/kontakte` | angemeldet, gefiltert nach Sichtbarkeitsstufe und STWEG |
| `POST /api/stweg-modules` | A🅢 oder T/P; nur bekannte Module (`waschkueche`) |
| `POST/PUT/DELETE /api/stweg/:nr/mitteilungen[/:id]`, `POST /api/stweg/:nr/bilder` | Technik/Präsident; sonst Seitenrecht `stweg-mitteilungen` = write UND Ausschuss oder Verwaltung dieser STWEG; Kooperation (nr 0) nur T/P. Löschen blendet aus; `GET …/:id/verlauf` zeigt die Fassungen. Die alten Abschnitte (`stweg_sections`) werden beim Start als Mitteilungen übernommen |
| `GET /api/stweg/:nr/kontakte` | Mitglieder der STWEG (auch Mieter), ihre Verwaltung, T/P alle; nur Kontakte, die schon gelten (`gueltig_ab` leer oder erreicht) |
| `GET /api/stweg/:stweg/events` | Gruppe dieser STWEG; `POST`, `PUT /:id`, `DELETE /:id`: T/P oder Recht `stweg-termine` schreiben + Ausschuss/Verwaltung dieser STWEG (`lib/termine.js`), Fehler am Feld `{error, feld}` |
| `GET /api/termine?stweg=` | Rosenweg Termine: Termine der eigenen STWEG(s) in einer Liste (`stwegs` je Termin), `stwegs` mit `schreiben` und `kalender` (Nextcloud-Kalender aus `TERMINE_NEXTCLOUD_KALENDER`, sonst null); `stweg=3,5` oder `alle` (T/P alle, sonst nur sichtbare → 403) |
| `GET/POST /api/meg/einstellplaetze` | lesen nur MEG (Mitglieder, MEG-Ausschuss, MEG-Verwaltung, T/P; fremde Plätze ohne Personendaten), sonst 403; schreiben MEG-Ausschuss, MEG-Verwaltung oder T/P; `/rechte` liefert `verwalten`, `sehen` |
| `/api/grundbuch/*` | angemeldet; erfassen/OCR nur Eigentümer, Ausschuss, T/P (keine Mieter), STWEG-gebunden (`grundbuch_anteile.stweg`); Namen/Adressen nur Ausschuss der STWEG, T/P oder wer erfasst hat; verifizieren Ausschuss der STWEG/T/P; OCR nur mit `parzelle`, `sub_id`, `bestaetigt_extern: true`, nicht per PAT/MCP, 30 / Std.; `PUT /parzellen/:p/stweg` nur T/P; `GET /parzellen/vorschlag` nur T/P, nur lesen (Parzelle, Vorschlag, Sicherheit, Zahlen; keine Namen) |
| `/api/vollmachten*` | angemeldet: eigene; Ausschuss und Verwaltung sehen ihre STWEG nur mit Recht `vollmachten` (Ausschuss Vorgabe lesen); T/P alle; für andere erfassen T/P und Verwaltung mit `vollmachten` = schreiben; Admin-Upload für alle Geber nur T/P mit `?als=admin`. Erfassen/Signieren/Hochladen als Geber nur Eigentümer bzw. Wohnungs-Verwalter der Wohnung oder STWEG (ohne Objekt 403); Liste mit `darf_erteilen`, je Zeile `darf_widerrufen`, `darf_papier_aktivieren`, `darf_ki_pruefen`. `signed_ip`, `signed_user_agent`, `signed_authentik_sub` (und `digital_signed_*`) nur für T/P, auch auf dem PDF |
| `POST /api/vollmachten/:id/sign-digital` | nur frisch angemeldet (Website/App, ≤ `STUFE_FRISCH_MIN` Min.), nie mit PAT, MCP (`X-Rosenweg-Kanal: mcp`), Karte oder Anlage-Token: sonst 403 `{reauth, fehler:'frisch'}` |
| `POST /api/vollmachten/:id/verify-ai` `{bestaetigt_extern:true}` | KI-Prüfung (PDF an OpenRouter/Anthropic): nur T/P und Verwaltung der STWEG mit Recht `vollmachten`, nicht per PAT/MCP; ohne Bestätigung 400 `bestaetigung_noetig` |
| `GET /api/vollmachten/lookup/personen?q=` | T/P und Verwaltung aller STWEGs: alle; sonst Name/E-Mail nur in STWEGs, wo das Konto Eigentümer (Gruppe oder Rolle `eigentuemer`/`verwalter`), Ausschuss oder Verwaltung (Recht) ist; Mieter leer |
| `/api/vollmachten/templates` | lesen: globale (`stweg` leer) und die der eigenen STWEG(s), je Vorlage `darf_bearbeiten`, oben `anlegen_stwegs` (null = alle inkl. global); anlegen/ändern/löschen global nur T/P, sonst Ausschuss der STWEG |

### 4.5 Reparaturen, Waschküche, Zutritt

| Route | Wer |
|---|---|
| `POST /api/reklamationen` | angemeldet, 5 / 10 Min. je Person |
| `GET /api/reklamationen/meine…`, `POST …/:id/meine-archivieren` | angemeldet, eigene |
| `GET /api/reklamationen`, `PUT /api/reklamationen/:id`, `…/:id/history`, `…/:id/foto`, `…/auto-assign`, `/api/reklamation-orte*` | Recht `reklamationen`; A🅢 sieht seine STWEG und Meldungen ohne STWEG; fremde `:id` → **404** |
| `GET /api/reklamationen/uebersicht[?stweg=N]` | angemeldet, eigene STWEG(s); mit `stweg` nur diese STWEG, wenn das Konto sie sehen darf (sonst 403) |
| `/api/wasch/rooms`, `reservations`, `my/*`, `settings` | angemeldet; Räume und Reservationen nur eigener STWEG(s); Serien höchstens 1 Jahr; höchstens 120 offene Reservationen (429) |
| `/api/wasch/admin/*`, `POST/PUT /api/wasch/rooms`, `PUT /api/wasch/settings` | T/P |
| `/api/access/me/*` | angemeldet; Türen nach Policy, Öffnen 10 / 10 Min. (429), Protokoll in `access_tueroeffnungen`; NFC-Sitzungen nur der eigenen (10 / 10 Min.) |
| `/api/access/*` (ohne `me`) | T/P |

### 4.6 Finanzen, Projekte, Handwerker

| Route | Wer |
|---|---|
| `GET/POST/PUT/DELETE /api/auslagen…`, Belege, Positionen, `scan-beleg` | Recht `auslagen:read`; sehen: Ersteller, A🅢, T/P (Entwürfe nur Ersteller und T/P); Status ändern A🅢/T/P, keine Selbstgenehmigung; „ausbezahlt“ T/P/Verwaltung bzw. Ersteller („erhalten“); Scan 30 / Std. |
| `PUT/DELETE /api/auslagen-stundensatz` | Recht `auslagen-stundensatz:write` |
| `/api/projects…` | lesen je Projekt (`projektLesen`, 28.11.2026): Eigentümer der STWEG des Projekts, Ausschuss der STWEG (auch ohne Eigentümergruppe), Verwaltung der STWEG mit Recht `projekte`, Projekte ohne STWEG (Kooperation) jeder Eigentümer/Ausschuss/jede Verwaltung mit Recht, T/P alle; `GET /api/projects` liefert nur lesbare (mit `darf_bearbeiten`), `/:slug` sonst 403; Kommentare ohne `user_email` (dafür `eigener`); `/:slug/auslagen` mit `user_email` nur für T/P und Verwaltung der STWEG; `GET /api/projects-mini` und `/api/doodle/projects` nur lesbare; Doodle-Umfragen mit `project_slug` nur für Leser des Projekts, Ersteller und Eingeladene; `PUT /:slug/public` `{public_access, bestaetigt}` (einschalten nur mit `bestaetigt:true`), `PUT /:slug/attachments/:id/public` `{oeffentlich, bestaetigt}`; kommentieren: Eigentümer (lesbare Projekte); anlegen (`POST /api/projects`) und bearbeiten: T/P, Ausschuss der STWEG des Projekts, Verwaltung der STWEG mit `projekte` = schreiben; Projekte der ganzen Kooperation (`stweg` leer) jeder Ausschuss bzw. eine Verwaltung aller STWEGs (`lib/projekte-rechte.js`) |
| `/api/handwerker*`, `/api/handwerker-events`, `/api/handwerker-notfall` | Recht `handwerker`, dazu STWEG-gebunden (`api/lib/handwerker-rechte.js`): Verwaltung liest/schreibt Verträge, Einsätze, Zuordnungen ihrer STWEG, Ausschuss liest; Stammdaten ändert die Verwaltung bei Firmen ihrer STWEG und des gemeinsamen Stamms (protokolliert), archivieren nur eigene; „alle STWEG“-Verträge/Zuordnungen, Event-Typen und hartes Löschen nur T/P; `PUT /api/handwerker/:id/zuweisungen` für Zuordnungen an Firmen des gemeinsamen Stamms |
| `/api/projects…` | lesen je Projekt (`projektLesen`, 28.11.2026): Eigentümer der STWEG des Projekts, Ausschuss der STWEG (auch ohne Eigentümergruppe), Verwaltung der STWEG mit Recht `projekte`, Projekte ohne STWEG (Kooperation) jeder Eigentümer/Ausschuss/jede Verwaltung mit Recht, T/P alle; `GET /api/projects` liefert nur lesbare (mit `darf_bearbeiten`), `/:slug` sonst 403; Kommentare ohne `user_email` (dafür `eigener`); `/:slug/auslagen` mit `user_email` nur für T/P und Verwaltung der STWEG; `GET /api/projects-mini` und `/api/doodle/projects` nur lesbare; Doodle-Umfragen mit `project_slug` nur für Leser des Projekts, Ersteller und Eingeladene; `PUT /:slug/public` `{public_access, bestaetigt}` (einschalten nur mit `bestaetigt:true`), `PUT /:slug/attachments/:id/public` `{oeffentlich, bestaetigt}`; kommentieren: wer das Projekt lesen darf, auch die Verwaltung (`PUT/DELETE /:slug/comments/:id` für eigene Kommentare 15 Minuten, `DELETE` sonst Bearbeiter); `DELETE /api/projects/:slug` nur T/P mit `bestaetigt` und Protokoll (`admin_protokoll`, Bereich `projekte`); `PUT` auf Zeitachse und Kandidaten ändert nur die gesendeten Felder; Zeitachse mit `als_termin` legt einen Termin in Rosenweg Termine an (`stweg_events.projekt_slug`); auf geteilten Telefonen (Anlage-Token) nur lesen und kommentieren; `/api/auth/me` liefert abgeleitet `projekte-bearbeiten` = write (Farbe blau in der App Rosenweg Projekte); anlegen (`POST /api/projects`) und bearbeiten: T/P, Ausschuss der STWEG des Projekts, Verwaltung der STWEG mit `projekte` = schreiben; Projekte der ganzen Kooperation (`stweg` leer) jeder Ausschuss bzw. eine Verwaltung aller STWEGs (`lib/projekte-rechte.js`) |
| `/api/handwerker*`, `/api/handwerker-events`, `/api/handwerker-notfall` | Recht `handwerker` |
| `GET /api/dashboard`, `POST /api/ki-search` (30 / Min.), `GET /api/telefonbuch` | angemeldet, Inhalt nach Rolle gefiltert |

### 4.7 Mail und Dokumente

| Route | Wer |
|---|---|
| `POST /api/mail-compose` | Recht `mail-compose:write`, 50 / Std.; immer über die Freigabe-Outbox |
| `/api/verwaltung-mail-queue*` | T/P; `POST …/:id/freigeben` nach Freigabe-Regel (`mail_approval_config`), schon freigegeben → 409 |
| `GET /api/verwaltung-mail-queue/zur-freigabe?seit=` | angemeldet; nur Mails, die die Person jetzt freigeben kann (Gruppe der Regel, noch nicht selbst freigegeben), mit Vorschau; `seit` (ISO) = neu eingestellt oder bearbeitet seitdem; Antwort `{mails, anzahl, jetzt}` (Rosenweg Mail-Freigabe) |
| `/api/mail-templates`, `/api/mail-approval-config` | T/P |
| `/api/mail-empfänger` | Recht `mail-empfänger`; `GET` für Ausschuss/Verwaltung nur Einträge ihrer STWEG(s) und STWEG-übergreifende (`stweg` NULL), fremde `?stweg=` → 403 |
| `/api/verteiler*`, `POST /api/verteiler/send`, `POST /api/email/send`, `/api/email/log`, `/api/dmarc/reports`, `/api/email/quota` | T/P |
| `GET /api/verteiler`, `POST /api/verteiler/send` (nur `verteiler_id`) | zusätzlich Verwaltung mit Recht `email-verteiler`: nur aktive Verteiler ihrer STWEG(s), ohne Mitgliederliste (`lib/verteiler-verwaltung.js`) |
| `POST /api/verteiler/send` mit `Idempotency-Key` (Kopf oder Feld `idempotency_key`, 8–128 Zeichen) | dieselbe Rundmail geht höchstens einmal hinaus (24 h je Konto): Wiederholung → gespeicherte Antwort mit `Idempotent-Replayed: true`; läuft noch/unterbrochen → 409; anderer Inhalt → 422. Ging nichts hinaus, ist der Schlüssel wieder frei |
| `POST /api/verwaltung-mail-queue/:id/freigeben` | zusätzlich: nicht durch Ersteller oder letzte Bearbeitende (Konto-ID, auch T/P) → 403 `vier_augen` |
| `GET /api/email-log` | T/P |
| `/api/email-archive*` | Recht `email-archiv` + Ausschuss/Verwaltung (eigene STWEG + `haus`) oder T/P; Lesen, Anhang, Suche, Export protokolliert (`/protokoll` nur T/P); Löschen nach 4-Augen (andere Konto-ID, gleiche STWEG oder T/P), höchstens ein offener Antrag je Mail; nach 10 Jahren anonymisiert |
| `GET /api/documents`, `GET /api/documents/:path` | angemeldet; `allgemein`, `scans`, eigene STWEG, `projekte` für Eigentümer; gesperrte Unterordner nur T/P |
| `POST/PUT/DELETE /api/documents…`, `POST /api/documents/move` | Ausschuss (eigene STWEG, `allgemein`, `projekte`) oder T/P |
| `GET /api/documents-ordner?path=`, `-suche?q=`, `-neu?seit=&ordner=`, `-rechte`, `-kennung/:id`, `-fassungen?path=`, `-fassungen/:id/datei` | angemeldet, Rechte wie `GET /api/documents` (Pfad für Pfad); nur lesend. Für die App Rosenweg Unterlagen: eine Ordnerebene mit Datum, Typ, ETag, Kennung und `schreiben` je Eintrag; Suche nach Name und Pfad; neue Dateien seit einer Zeit (per mtime, also auch Samba/Nextcloud); wo man schreiben darf; stabile Kennung → Datei; frühere Fassungen (beim Ersetzen, 30 Tage). `alles=1` (auch Druckertreiber, `.DS_Store`, `desktop.ini`) nur T/P. Code: `api/lib/unterlagen.js` |
| `GET /api/briefe`, `POST /api/briefe/upload` | Ausschuss oder T/P |
| `GET /api/briefe`, `GET /api/briefe/:datei/bild`, `POST /api/briefe/upload`, `POST /api/briefe/:datei/loeschantrag`, `…/loeschentscheid` | Ausschuss (eigene STWEG) oder T/P; Upload nur mit `stweg` und `bestaetigt_extern: true`, nicht per PAT/MCP, Tageslimit je Konto; `PUT /api/briefe/:datei/stweg` nur T/P |

### 4.8 Energie

Kurzfassung (Details [`energie-api.md`](energie-api.md)):

| Route | Wer |
|---|---|
| `GET /api/energy/{surplus,…,tariffs/current}` | offen |
| `GET /api/energy/*` (alles andere), `GET /api/energie/meine-zaehler` | angemeldet; nur zugeordnete Zähler; voll für T/P und Recht `energie-config:read` |
| `/api/energie-admin/*` | Recht `energie-config` (GET read, sonst write); 503 ohne `ENERGY_ADMIN_API_KEY` |
| `GET /api/zaehler-technik` | Gruppe `technik`, `präsident`, `verwaltung` oder `r9-eigentuemer`; volle Sicht nur Technik/Präsident oder `energie-config:read` |
| `/api/zähler/*` | Recht `zähler` (`POST /api/zähler/benutzer` T/P) |
| `GET /api/strompreis/elcom?gemeinde=4252&jahr=2026&kategorie=H4` | angemeldet; Standardprodukt des Netzbetreibers aus ElCom/LINDAS (`lib/elcom.js`, je Jahr/Kategorie einen Tag zwischengespeichert, bei Ausfall der letzte Wert mit `veraltet: true`). Antwort `{quelle:'elcom', gemeinde, bfs, jahr, kategorie, netzbetreiber, rp_kwh:{total, energie, netz, abgaben, kev, messung}, chf_kwh, stand}`; 404 ohne Daten, 502 ohne LINDAS. Nur zum Vergleich in Rosenweg ZEV und Energie, nie in Tarife |

### 4.9 Technik, Netz und Nebendienste

| Bereich | Routen | Wer |
|---|---|---|
| ISP | `/api/isp/*` | angemeldet für eigene Einträge (Reverse-Proxy, Weiterleitungen, Mail-Relays, VPN, VLAN-Anträge, Postfächer); Freigaben und Verwaltung T/P (`ispIsAdmin`). Einträge von Nicht-Admins in eigenen Cloudflare-Zonen oder mit Überschneidung werden nie automatisch freigegeben ([`sicherheit.md`](sicherheit.md) 4.7). |
| ISP: Haus-WLAN, Anschluss, VPN (nur Bewohner) | `GET /api/wifi`, `GET /api/isp/subscribers/me`, `PUT /api/isp/subscribers/me/:id/mac`, `GET /api/isp/fixed-ips`, `GET /api/isp/vpn-accounts/options`, `POST /api/isp/vpn-accounts`, `POST /api/isp/vlan-requests` (mit `wohnung_id`), Laptop-Tunnel `POST /api/stations/:id/tunnel` | nur wer in der Einheit **wohnt**, ab `gueltig_ab` (Rolle `mieter`/`bewohner`, oder `eigentuemer` bei Selbstbewohnung; nicht `verwalter`); T/P alles. Regel: `api/lib/isp-zugang.js`, Matrix: [`wiki/berechtigungen.md`](../wiki/berechtigungen.md) 2.6 |
| ISP: alle WLAN-Passwörter | `GET /api/wifi?alle=1` → `allPpsks` (ohne `alle` nur `kann_alle_sehen`) | T/P, **protokolliert** (Bereich `isp`, mit der Karte auch Kartenprotokoll) |
| ISP: WLAN-Passwort eines privaten Netzes | `GET /api/isp/vlan-requests/:id/wlan-passwort` | Antragsteller, Mitnutzer; T/P fremde **protokolliert**. In `GET /api/isp/vlan-requests` stehen fremde Passwörter nicht mehr (`has_wlan_password`) |
| ISP: VPN-Zugang anlegen | `POST /api/isp/vpn-accounts` `{ vlan, bezeichnung, public_key? }` | mit `public_key` (Base64, 44 Zeichen): Schlüssel bleibt auf dem Gerät, Antwort `schluessel: 'geraet'`, `config_vorlage` mit Platzhalter `%PRIVATKEY%`, kein `config`; ohne: Rückfall, Server erzeugt den Schlüssel, Antwort `schluessel: 'server'`, `config`, `hinweis` |
| ISP: VPN-Konfiguration, QR | `GET /api/isp/vpn-accounts/:id/config`, `…/qr` | Besitzer; T/P fremde **protokolliert**. 409 bei Schlüssel auf dem Gerät, 410 bei gesperrtem Zugang |
| ISP: VPN beim Auszug | `GET /api/isp/vpn-accounts/wohnsitz` (Liste, sperrt nie), `POST /api/isp/vpn-accounts/:id/sperren` `{ grund }` | T/P. Täglicher Abgleich und nach Kontakt-Änderungen sperrt Zugänge von Personen, die seit 28.11.2026 als Bewohner gesehen wurden und nicht mehr wohnen; Kontolöschung sperrt alle der Adresse. Sperren = Peer bei wg-control entfernt, Zeile bleibt (`gesperrt_am`, `gesperrt_grund`). `VPN_AUSZUG_SPERREN=aus`: nur melden |
| ISP: Protokoll | `GET /api/isp/protokoll?limit=` | T/P |
| ISP: „nur meine“ | `?nur=meine` an `GET /api/isp/vpn-accounts`, `/vlan-requests`, `/mailbox-requests` | auch T/P bekommen nur die eigenen; Antwort `nur_meine: true` |
| NOC | `/api/isp/noc/dashboard`, `/noc/unifi` | T/P (Token-Wandbild siehe `NOC_PUBLIC_TOKEN`) |
| Proxmox, PVE | `/api/proxmox/*`, `GET/POST/DELETE /api/pve-messages…` | T/P |
| PBX | `/api/pbx/ring-members`, `config`, `calls`, `trunk-status`, `test-call` | T/P |
| WhatsApp | `/api/whatsapp/admin/*`, `qr.png`, `qr-status` | T/P |
| MQTT, Anzeigen | `/api/mqtt/meters…`, `service-users`, `topic-rules`, `publish`, `user-*`; `/api/display/state`, `pdf`, `ankuendigungen`, `announce` | T/P (`requireMqttTechnik`) |
| MQTT eigen | `POST /api/mqtt/token` (12 h, mit Karte 30 min), `DELETE /api/mqtt/token` (widerrufen), `GET /api/mqtt/my-access`, `/api/mqtt/my-app-passwords` | angemeldet (App-Passwörter nur Browser) |
| SSH | `/api/ssh/me*` (Browser), `/api/ssh/sitzungen`, `hosts`, `matrix`, `dienste` (GET) | eigene Schlüssel angemeldet; Verwaltung T/P |
| Stationen | `/api/stations/admin/*` (darin `POST admin/windows`: Windows-Rechner von Hand eintragen; `POST admin/ad-abgleich`: Windows-Rechner jetzt aus dem AD lesen; `POST admin/:id/anschluss-uebernehmen`: Anschluss-Wächter — neuen Switch-Port/AP übernehmen und, falls der Wächter gesperrt hat, freigeben; `POST admin/:id/anschluss-vergessen`: nächsten Anschluss ohne Sperre lernen; `DELETE admin/:id/doppelt`: Meldung „doppelte Station“ erledigt) | T/P |
| Scanner | `GET /api/scanner` (Geräte, wann zuletzt gesetzt, Protokoll), `POST /api/scanner/:id/passwort-drucken` (neues Passwort: Zettel auf DruckerR9, dann im AD; Passwort nie in Antwort, DB oder Log); Seite `scanner.html`, siehe `fileserver-lxc/scans/README.md` | T/P |
| Sicherungen | `GET /api/sicherungen/pbs` (PBS-Übersicht, nur lesend), `GET /api/sicherungen/pcs`, `PUT /api/sicherungen/pcs/:id` (MAC, Adresse), `POST/DELETE /api/sicherungen/pcs/:id/vormerkung` (CT 135), `POST /api/sicherungen/pcs/:id/start` (`sichern` im Sicherungs-System); Seite `sicherungen.html` | T/P |
| TV | `/api/tv/channels` (je Sender auch `tvg` = EPG-Schlüssel und `udpxy_url` = Direktweg im Haus), `stream-url`, `extern/token*`; für die App Rosenweg TV: `GET /api/tv/jetzt` (Jetzt/Danach aller Sender, Schlüssel `tvg`), `GET /api/tv/epg?kanal=<tvg>&von=&bis=` (Programm eines Senders, ISO-Zeit, Standard ab jetzt 24 h, höchstens 8 Tage; 400 bei falscher Zeit, 404 unbekannter Sender; gleicher Cache wie `epg.xml`, `api/lib/tv-epg.js`) | angemeldet |
| Push | `/api/push/subscribe`, `unsubscribe`, `test` (5 / 10 Min.) | angemeldet |
| Alarmpanel | `/api/alarmpanel/sensors`, `events` | lesen angemeldet; Sensoren anlegen, ändern, testen, Webhook ansehen T/P |
| Doodle | `/api/doodle/*` | Doodle-Sitzung (Code) bzw. Mitglied; Einladungen 50 je Umfrage, 100 / Tag |
| MCP | `POST /mcp`, `GET /api/mcp/aufrufe` | PAT (siehe [`mcp.md`](mcp.md)); Protokoll T/P |
| Verbindungen | `/api/connections`, `/api/connections/stats` | T/P |

---

## 5. Fehlercodes

Fehlerantworten sind JSON `{ "error": "<Text>" }`. Der Text ist für Menschen gedacht;
interne Details (DB-Meldungen, Stacktraces) gehen nur ins Log (`fehlerFuerClient`).
Unerwartete Fehler in Routen ergeben **500** „Interner Fehler“.

| Code | Wann | Was tun |
|---|---|---|
| **400** | Eingabe ungültig (fehlendes Feld, falsches Format, ungültige STWEG-Nummer, ungültige Zähler-ID); falscher oder abgelaufener Einmal-Code; ungültiger OAuth-`state` oder fehlendes Bind-Cookie | Eingabe korrigieren; bei der Anmeldung neu beginnen |
| **401** | kein `Authorization`-Header; Sitzung abgelaufen; PAT ungültig, abgelaufen oder widerrufen; Konto deaktiviert; Authentik-Token gehört nicht zur gebundenen Benutzerzeile; falsches Dienstgeheimnis bei PBX, WhatsApp, Scanner, eingehender Mail; ungültiges Stations-/App-/Einrichtungs-/Stream-Token | neu anmelden bzw. Token/Geheimnis prüfen. Die Webseiten melden sich nur bei 401 ab. |
| **403** | angemeldet, aber nicht berechtigt: fehlendes Seitenrecht („Keine Berechtigung“), falsche Rolle („Nur für Technik oder Präsident“, „Nur für Ausschuss/Technik“), fremde STWEG („Schreiben nur für den Ausschuss dieser STWEG“), fremder Zähler; PAT-Scope fehlt oder Pfad für PATs gesperrt; Passwortwechsel ohne frische Anmeldung (`reauth: true`); E-Mail gehört einem anderen Konto; falsches Geheimnis bei Traefik, Tracker, PVE, Alarm, MQTT-Broker, SSH-Host; CORS-Herkunft nicht erlaubt | Rechte bei der Technik anfragen; Passwort: „Jetzt neu anmelden“ im Profil |
| **404** | Datensatz gibt es nicht **oder** gehört nicht zum eigenen Bereich und soll nicht verraten werden (z. B. fremde Reklamation); unbekannter Pfad unter `/api/energy/` oder `/api/energie-admin/`; OTP-Login abgeschaltet | ID prüfen |
| **409** | Konflikt: Benutzername oder E-Mail existiert schon (auch in anderer Gross-/Kleinschreibung); E-Mail/Telefon gehört einer anderen Person oder einem Konto; geschützte Person (eigenes Konto oder Wohnungen in anderer STWEG); Hostname/Domain/Redirect bereits vergeben; Mail nicht mehr im Status `pending` oder schon von dieser Person freigegeben; ZEV-Rechnung schon zugeordnet; Grundbuch-Anteil schon reserviert/erfasst | Daten prüfen; geschützte Personen ändert die Person selbst oder die Technik |
| **413** | Anfragekörper zu gross | Datei verkleinern |
| **429** | Grenzwert überschritten: Code-Anforderung/-Prüfung (API und nginx `rw_otp`), Passwortwechsel, Türöffnung, NFC, KI-Suche, Beleg-Scan, Grundbuch-OCR, Vollmacht-KI, Personensuche, Echtheitsprüfung, Mail-Composer, Verteiler-Versand, Postfach-Antrag (auch: ein anderer Antrag läuft noch), VPN-Konten, Stations-Tunnel, DNS-Prüfung, Push-Test, Waschküche (120 offene); falsche SSH-Host-Tokens | warten; Werte: [`sicherheit.md`](sicherheit.md) Abschnitt 5 |
| **500** | unerwarteter Fehler; `CF_DDNS_TOKEN` fehlt | API-Log auf CT 128: `docker compose logs api` |
| **502** | ein Nachbardienst antwortet nicht oder mit Fehler: Energy-Collector, Mailcow, UniFi Access, MQTT, Authentik-API | Dienst prüfen |
| **503** | Funktion nicht konfiguriert (fail closed): `PBX_SHARED_SECRET`, `WHATSAPP_SHARED_SECRET`, `PVE_MSG_SECRET`, `SSH_HOST_TOKEN`, `ENERGY_ADMIN_API_KEY`, `WG_CONTROL_TOKEN`, `GOOGLE_CALENDAR_ICS_URL` fehlen, MQTT nicht konfiguriert; `/api/health`, wenn die DB nicht antwortet | Variable in `/opt/rosenweg-core/.env` setzen, API neu starten |

---

## 6. Grenzwerte

Die API zählt Grenzwerte im Arbeitsspeicher (`rateLimitGuard`, je Person bzw. Quelle;
nach einem Neustart beginnen sie neu) – ausser den Fehlversuchen der Einmal-Codes,
die in `otp_codes.versuche` stehen. Davor drosselt nginx die Code-Routen (Zone
`rw_otp`, 10 / Min. je Client-IP, Burst 10, Antwort 429). Vollständige Tabelle:
[`sicherheit.md`](sicherheit.md) Abschnitt 5.

---

## 7. Umgebungsvariablen

Alle **sicherheitsrelevanten** Variablen (Pflicht-Geheimnisse, Schalter wie
`OTP_LOGIN_ENABLED`, `NOC_PUBLIC_OPEN`, TLS-Notausgänge) stehen mit ihrer Wirkung in
[`sicherheit.md`](sicherheit.md) **Abschnitt 6**. Werte nie ins Repo; Geheimnisse
stehen im Passwortmanager und in `/opt/rosenweg-core/.env`.

Feste, nicht geheime Werte aus `backend-lxc/core/compose.yml`:

| Variable | Wert | Zweck |
|---|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` | `postgres`, `5432`, `rosenweg`, `rosenweg` | Haupt-DB im Compose-Netz |
| `ENERGY_DB_HOST`, `ENERGY_DB_PORT`, `ENERGY_DB_NAME`, `ENERGY_DB_USER` | `100.64.2.53`, `5432`, `energy`, `energy` | Energie-DB auf CT 129 |
| `ENERGY_COLLECTOR_URL` | `http://100.64.2.53:3001` | Energy-Collector |
| `AUTHENTIK_URL` | `http://100.64.2.37:9000` | Authentik intern (Server-zu-Server) |
| `AUTHENTIK_EXTERNAL_URL` | `https://authentik.rosenweg4303.ch` | Browser-Umleitungen |
| `SITE_URL` | `https://www.rosenweg4303.ch` | Basis für Links und CORS |
| `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM` | `mail-eu.smtp2go.com`, `2525`, `noreply@rosenweg4303.ch` | Mailversand |
| `PORT` | `3000` | Port der API |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0` | **noch gesetzt**, soll ersetzt werden ([`sicherheit.md`](sicherheit.md) 6.2) |

Weitere Einstellungen aus `.env` (Auswahl, ohne Geheimnisse): `DOCS_PATH`
(Dokumentenablage, Standard `/documents`), `IMAP_HOST` (Standard `imap.gmail.com`),
`IMAP_POLL_INTERVAL` (Sekunden, Standard 60), `IMAP_MAILBOXES` (Standard
`INBOX,Junk`), `GOTENBERG_URL`, `GOTENBERG_MAX_CONCURRENT` (Standard 3), `PVE_API_URL`,
`WG_CONTROL_URL`, `PRINT_API_URL`, `PBS_FINGERPRINT`, `PXE_VORMERK_ZIEL` (Sicherungen;
Schlüssel unter `/opt/rosenweg-core/sicherung/`, siehe `api/routes/sicherungen.js`), `AD_PASSWORD_API_URL`, `MCP_HOST` (Standard
`mcp.rosenweg4303.ch`), `VERTEILER_DOMAIN`. Geheimnisse wie `AUTHENTIK_CLIENT_SECRET`,
`AUTHENTIK_API_TOKEN`, `SMTP_PASS`, `IMAP_PASS`, `MAILCOW_API_KEY`, `UNIFI_API_KEY`,
`CLOUDFLARE_API_TOKEN`, `OPENROUTER_API_KEY`, `PBS_AUDIT_TOKEN` (PBS, nur DatastoreAudit),
`PBS_PC_TOKEN` (Geheimnis von `sicherung@pbs!pc`), `PVE_AUDIT_TOKEN` (NOC, nur PVEAuditor) stehen nur in `.env`
(`<im Passwortmanager>`).

---

## 8. E-Mail-Eingang (IMAP-Polling)

- Die API fragt das Sammelpostfach (`IMAP_USER`) alle `IMAP_POLL_INTERVAL` Sekunden
  ab, in den Ordnern `IMAP_MAILBOXES` (Standard `INBOX` und `Junk`).
- Plus-Adressen werden auf Verteiler abgebildet
  (`…+ausschuss@…` → Verteiler `ausschuss@rosenweg4303.ch`).
- Sonderfälle: `dmarc@` → DMARC-Ordner, `archiv@` → E-Mail-Archiv (`email_archive`),
  alles andere → Verteiler-Versand mit Protokoll in `email_log`.
- Zertifikatsprüfung über `IMAP_SERVERNAME`; Notausgang `IMAP_TLS_INSECURE=1` nur
  vorübergehend (siehe [`sicherheit.md`](sicherheit.md) 6.2).
