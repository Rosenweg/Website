# Frontend-LXCs (nginx, ohne Docker)

Stand: 17.11.2026 (nach der Sicherheitsprüfung, PR #23). Sicherheitsregeln,
Grenzwerte und Vorfälle stehen zentral in
[`../docs/sicherheit.md`](../docs/sicherheit.md); dieses Dokument beschreibt den
Betrieb der Frontend-Container: Aufbau, Ausrollen, Prüfen, Zurückbauen.

Jedes Frontend läuft in einem eigenen kleinen LXC mit nativem nginx. Es gibt
**kein Docker und keinen Swarm** mehr für die Frontends; die früheren
Swarm-Dienste `rosenweg_website`, `rosenweg_isp`, `rosenweg_stweg1..7`,
`rosenweg_meg` sind abgelöst (Hintergrund:
[`../docs/deswarm-plan.md`](../docs/deswarm-plan.md)).

## Aufbau

```
Internet ─▶ edge-traefik (CT 245, 100.64.2.40, TLS mit cf-Zertifikat)
              │ HTTP, Host-Header bleibt
              ▼
          Frontend-LXC :80 (nginx, Docroot /var/www/rosenweg)
              ├─ /api/energy/<offene Geräte-Routen> ─▶ rw_energy = 100.64.2.53:3001 (CT 129)
              ├─ /api/energy/<alles andere>         ─▶ rw_api    = 100.64.2.52:3000 (CT 128)
              └─ /api/                               ─▶ rw_api    = 100.64.2.52:3000 (CT 128)
```

- edge-traefik terminiert TLS und spricht **HTTP** zum Frontend. Alle vhosts
  setzen darum `X-Forwarded-Proto "https"` fest; ohne das baut die API
  `http://`-Rücksprungadressen für die Anmeldung.
- Die Backend-Adressen stehen **nur** in [`nginx/upstreams.conf`](nginx/upstreams.conf)
  (`upstream rw_api`, `upstream rw_energy`). Zieht die API oder der Collector um,
  wird nur diese Datei geändert und überall ausgerollt.
- Traefik setzt `X-Forwarded-For` selbst auf die Quelle, die es sieht
  (Cloudflare-Knoten oder direkter Client) und vertraut keinem eingehenden Wert.
  nginx nimmt daraus den ersten Eintrag als Client-IP für die Code-Drossel
  (`$rw_client_ip`, siehe unten).

## Belegung

| Site | CT | IP | Typ (`TYPE`) | Hostnamen | Route am Edge |
|------|----|----|------|-----------|---------------|
| www | 118 | 100.64.2.41 | `website` | www.rosenweg4303.ch, rosenweg4303.ch | `extra-routes.yml` (`www-lxc-svc`) |
| isp | 119 | 100.64.2.42 | `isp` | isp.rosenweg4303.ch, noc.rosenweg4303.ch | DB (`isp_reverse_proxy_routes`) |
| stweg1 | 120 | 100.64.2.43 | `stweg` | stweg1.rosenweg4303.ch | DB |
| stweg2 | 121 | 100.64.2.44 | `stweg` | stweg2.rosenweg4303.ch | DB |
| stweg3 | 122 | 100.64.2.45 | `stweg` | stweg3.rosenweg4303.ch, rosenweg9.ch, www.rosenweg9.ch | DB (stweg3) + `extra-routes.yml` (`rw9-lxc-svc`) |
| stweg4 | 123 | 100.64.2.46 | `stweg` | stweg4.rosenweg4303.ch | DB |
| stweg5 | 124 | 100.64.2.47 | `stweg` | stweg5.rosenweg4303.ch | DB |
| stweg6 | 125 | 100.64.2.48 | `stweg` | stweg6.rosenweg4303.ch | DB |
| stweg7 | 126 | 100.64.2.49 | `stweg` | stweg7.rosenweg4303.ch | DB |
| meg | 127 | 100.64.2.50 | `stweg` | meg.rosenweg4303.ch | DB |
| pwa | 130 | 100.64.2.54 | `pwa` | pwa.rosenweg4303.ch | `extra-routes.yml` (`pwa-lxc-svc`) |

Quelle der Wahrheit für die Belegung ist [`sites.tsv`](sites.tsv); `provision.sh`
führt dieselbe Tabelle als `case`. Die Container heissen `fe-<site>` (z. B.
`fe-www`, `fe-stweg3`) und laufen im Normalfall auf **pve1**, sind aber
HA-schwebend (kein fester Knoten). Vor einem `pct`-Befehl darum den aktuellen
Knoten nachsehen:

```bash
ssh root@100.64.2.20 'pvesh get /cluster/resources --type vm --output-format json' \
  | python3 -c 'import json,sys; [print(r["vmid"], r["name"], r["node"], r["status"]) for r in json.load(sys.stdin) if str(r.get("name","")).startswith("fe-")]'
```

LXC-Eigenschaften: Debian 13, unprivilegiert, 1 Kern, 256 MB RAM, 4 GB auf Ceph
(`lxcs`), Bridge `vmbr2`, Gateway `100.64.2.1`, `onboot=1`, kein `nesting`.

## Dateien

| Datei im Repo | Ziel im LXC | Zweck |
|---|---|---|
| `deploy.sh` | läuft aus `/opt/rosenweg/repo/frontends-lxc/` | Repo holen, nginx-Konfiguration installieren, Docroot bauen, `nginx -t`, neu laden |
| `nginx/upstreams.conf` | `/etc/nginx/conf.d/00-upstreams.conf` | Backend-Adressen, Code-Drossel `rw_otp` |
| `nginx/sicherheit-header.conf` | `/etc/nginx/snippets/rosenweg-sicherheit.conf` | gemeinsame Sicherheits-Header (seit 17.11.2026) |
| `nginx/<TYPE>.conf` | `/etc/nginx/sites-available/rosenweg.conf`, Symlink in `sites-enabled/` | vhost je Typ (`website`, `isp`, `stweg`, `pwa`) |
| – | `/etc/rosenweg-frontend.conf` | `SITE=<site>` und `TYPE=<typ>` (legt `provision.sh` an) |
| – | `/opt/rosenweg/repo` | flacher Checkout von `github.com/Rosenweg/Website` (`main`) |
| – | `/var/www/rosenweg` | ausgelieferter Docroot (Eigentümer `www-data`) |
| `provision.sh` | läuft auf einem PVE-Knoten | neuen Frontend-LXC anlegen |
| `sites.tsv` | – | Belegungstabelle |

## Was ausgeliefert wird (Positivlisten)

`deploy.sh` baut den Docroot je Typ aus einer **Positivliste**. Was nicht
ausdrücklich genannt ist, kommt nicht auf den Server. Vorher war es eine
Sperrliste; mit jedem neuen Repo-Ordner wurde dadurch etwas öffentlich (am
5.9.2026 der ganze Repo-Baum, am 17.11.2026 entdeckte Schlüssel-Exporte, siehe
`docs/sicherheit.md` Abschnitt 1.3).

| Typ | Inhalt des Docroots |
|---|---|
| `website` | `css/`, `img/`, `js/` und im Wurzelverzeichnis `*.html`, `*.png`, `*.pdf`, `*.webmanifest`, `*-sw.js`, `CNAME`, dazu genau `site-config.json`, `zaehler-config.json`, `access-manifest.json`. Ausgeschlossen bleiben die ISP-Seiten (`isp*.html`, `wlan.html`, `tv.html`, `netzwerk.html`, `verbindungen.html`, `dmarc.html`, `pbx-admin.html`) und `js/nav-isp.js`. |
| `isp` | genau `isp.html`, `isp-admin.html`, `isp-mein-zugang.html`, `wlan.html`, `tv.html`, `netzwerk.html`, `verbindungen.html`, `dmarc.html`, `noc-fullscreen.html`, zwei Logos, `site-config.json`, dazu `js/`. `js/nav-isp.js` wird zu `js/nav.js`; `index.html` zeigt auf `isp.html`. |
| `stweg` | aus `stweg1..7/` und `meg/` nur Web-Dateitypen (`html pdf png jpg jpeg svg webp ico js css`), **ohne** `data/`-Ordner und ohne `README.md`; dazu `js/`, `css/`, `site-config.json`, drei Logos, `waschkueche.html` (als `_waschkueche.html`) und `steuerung.html`. |
| `pwa` | Inhalt von `pwa/` als Wurzel, dazu `js/`, `logo-rosenweg.png`, `site-config.json`. |

Der Abgleich nach `/var/www/rosenweg` läuft mit `rsync --delete`; Dateien auf
`*.alt` (Sicherungen von `scripts/rw-web-ausrollen.sh`) bleiben dabei erhalten.

## Sperr- und Schutzregeln in nginx

Zusätzlich zur Positivliste sperrt nginx selbst, falls doch wieder etwas in den
Docroot gerät:

| Typ | Antwort 404 für |
|---|---|
| alle | Pfade, die mit `.` beginnen (ausser `/.well-known/`), und Dateien auf `.md .py .sh .yml .yaml .conf .cfg .sql .env .csv .bak .alt .vor-*` |
| `website` | zusätzlich `.service .timer .zone .xlsx .run`, und **jede `.json` ausser** `site-config.json`, `zaehler-config.json`, `access-manifest.json` |
| `stweg` | zusätzlich jede `.json` ausser `/site-config.json` und alles unter `/data/` |
| `isp`, `pwa` | keine zusätzliche JSON-Sperre (der Docroot enthält nur die genannten Dateien) |

**Sicherheits-Header** (`sicherheit-header.conf`, auf Server-Ebene und in jeder
`location` mit eigenem `add_header` eingebunden – nginx vererbt `add_header`
sonst nicht):

```
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: SAMEORIGIN
Content-Security-Policy: frame-ancestors 'self'
Strict-Transport-Security: max-age=31536000
```

Bewusst ohne `script-src` (die Seiten nutzen Inline-Skripte) und HSTS ohne
`includeSubDomains`. Wer eine neue `location` mit eigenem `add_header` anlegt,
muss dort `include /etc/nginx/snippets/rosenweg-sicherheit.conf;` ergänzen,
sonst fehlen die Header für diese Adressen.

**Energie-API:** In `website`, `stweg` und `pwa` gehen nur
`/api/energy/{surplus,surplus-available,lametric,shelly,solar-live,tariffs,tariffs/current}`
direkt zum Collector (CT 129). Alle anderen `/api/energy/…`-Pfade gehen an die
Haupt-API, die Anmeldung und Zähler-Zuordnung prüft
(`api/routes/energie-lesen.js`). Details: `docs/sicherheit.md` Abschnitt 4.6.

**Code-Drossel `rw_otp`** (in `upstreams.conf` definiert, in jedem
`location ^~ /api/` mit `limit_req zone=rw_otp burst=10 nodelay` aktiv): je
Client-IP 10 Anfragen pro Minute, Burst 10, nur für
`/api/reklamationen/{code,oeffentlich}`, `/api/doodle/{code,verify}`,
`/api/otp/{send,verify}` (Gross/Klein egal, optionaler Schrägstrich am Ende).
Überschreitung → **HTTP 429**. Alle anderen `/api/`-Pfade sind nicht gedrosselt.

## Ausrollen

### Normalfall: ganzes Frontend auf den Repo-Stand bringen

Nach jeder Änderung an `frontends-lxc/nginx/*`, `deploy.sh` oder wenn ein
Frontend vollständig auf `main` gebracht werden soll:

```bash
# im LXC (direkt per SSH oder über den PVE-Knoten):
ssh root@100.64.2.41 /opt/rosenweg/repo/frontends-lxc/deploy.sh
# bzw.
ssh root@100.64.2.20 'pct exec 118 -- /opt/rosenweg/repo/frontends-lxc/deploy.sh'
```

`deploy.sh` macht der Reihe nach:

1. `/etc/rosenweg-frontend.conf` lesen (fehlt sie oder `SITE`/`TYPE` → Abbruch
   mit `FEHLER: … fehlt`).
2. `git fetch --depth 1 origin main` und `git reset --hard origin/main` in
   `/opt/rosenweg/repo`. **Lokale Änderungen im Checkout gehen dabei verloren.**
3. `upstreams.conf`, `sicherheit-header.conf` und `<TYPE>.conf` installieren,
   `sites-enabled/default` entfernen.
4. Docroot in einem Temp-Verzeichnis bauen, mit `rsync --delete` nach
   `/var/www/rosenweg` spiegeln, `chown www-data`.
5. `nginx -t`; nur wenn das gelingt `systemctl reload nginx`. Erfolgsmeldung:
   `[deploy] OK — <site> (<typ>) deployed, nginx reloaded`.

Für alle elf Frontends nacheinander (vom Knoten aus, auf dem sie laufen):

```bash
for ct in 118 119 120 121 122 123 124 125 126 127 130; do
  echo "== CT $ct"; pct exec $ct -- /opt/rosenweg/repo/frontends-lxc/deploy.sh || echo "!! CT $ct fehlgeschlagen"
done
```

### Erster Lauf nach dem 17.11.2026: zweimal ausführen

Läuft auf einem Container noch die **alte Fassung** von `deploy.sh` (vor PR #23),
schlägt der erste Lauf bei `nginx -t` fehl:

```
nginx: [emerg] open() "/etc/nginx/snippets/rosenweg-sicherheit.conf" failed (2: No such file or directory)
```

Grund: bash liest das Skript, das gerade läuft, aus der alten Datei weiter,
obwohl `git reset` sie schon ersetzt hat. Die alte Fassung kennt die
Header-Datei nicht und installiert sie nicht; die neuen vhosts binden sie aber
ein. Weil `nginx -t` scheitert, wird **nicht** neu geladen – der laufende nginx
liefert mit der alten Konfiguration im Speicher weiter aus.

Was dann zu tun ist: `deploy.sh` **sofort ein zweites Mal** starten. Der zweite
Lauf ist die neue Fassung, installiert die Header-Datei, und `nginx -t` gelingt.
Bis dahin nginx nicht neu **starten** (`systemctl restart`), sonst scheitert der
Start an derselben fehlenden Datei und das Frontend ist ganz aus.

### Einzelne Dateien (Inhalt, ohne Konfiguration)

Für reine Inhaltsänderungen an einzelnen Seiten oder Skripten gibt es
`scripts/rw-web-ausrollen.sh` (Beschreibung in
[`../docs/website.md`](../docs/website.md#deployment)). Es ändert keine
nginx-Konfiguration. Wird danach `deploy.sh` ausgeführt, gilt wieder der
Repo-Stand von `main`.

### Neuen Frontend-LXC anlegen

```bash
# Template muss auf dem Knoten liegen, Storage "lxcs" aktiv
scp frontends-lxc/provision.sh root@100.64.2.20:/tmp/
ssh root@100.64.2.20 'TEMPLATE=local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst /tmp/provision.sh <site>'
```

`provision.sh` bricht ab, wenn die CT-ID schon existiert. Es legt den LXC an,
installiert `nginx git rsync ca-certificates`, klont das Repo nach
`/opt/rosenweg/repo` (Umgebungsvariable `GIT_URL`, Standard das öffentliche
Repo), schreibt `/etc/rosenweg-frontend.conf`, ruft `deploy.sh` auf und macht
einen lokalen Test mit dem passenden Host-Header.

Ist das Repo eines Tages privat, braucht der Klon einen Zugang. **Kein Token in
die URL schreiben** – sie landet in `/opt/rosenweg/repo/.git/config` und in der
Shell-Historie. Stattdessen einen nur lesenden Deploy-Key für den Container
hinterlegen und `GIT_URL=git@github.com:Rosenweg/Website.git` setzen.

Danach:

- Edge-Route anlegen (Datenbank-Route in `isp-admin.html` oder Eintrag in
  `edge-traefik/extra-routes.yml`).
- Neue IP in die Energie-Firewall von CT 129 aufnehmen
  (`backend-lxc/energy/firewall/energy-firewall.nft`), sonst erreicht das neue
  Frontend die offenen Energie-Routen nicht.
- SSH-Zugang: `scripts/rw-ssh-aufnehmen.sh … --auch-cts` erneut auf dem Knoten
  laufen lassen (siehe [`../docs/ssh-zugang.md`](../docs/ssh-zugang.md)).

## Prüfen

Im Container:

```bash
nginx -t
cat /etc/rosenweg-frontend.conf
ls -l /etc/nginx/snippets/rosenweg-sicherheit.conf /etc/nginx/conf.d/00-upstreams.conf
git -C /opt/rosenweg/repo log -1 --oneline        # muss origin/main sein
curl -s -H 'Host: www.rosenweg4303.ch' http://127.0.0.1/health   # OK
```

Von aussen (Beispiel fe-www; für STWEG-Hosts den Hostnamen tauschen):

```bash
# Header vorhanden?
curl -sI https://www.rosenweg4303.ch/ | grep -iE 'x-frame|content-security|strict-transport|nosniff|referrer'
# Sperrregeln greifen (alle 404):
curl -so /dev/null -w '%{http_code}\n' https://www.rosenweg4303.ch/README.md
curl -so /dev/null -w '%{http_code}\n' https://www.rosenweg4303.ch/networks_full.json
curl -so /dev/null -w '%{http_code}\n' https://stweg3.rosenweg4303.ch/data/kontakte.json
# erlaubte JSON (200):
curl -so /dev/null -w '%{http_code}\n' https://www.rosenweg4303.ch/site-config.json
# Energie: Lastprofile nur angemeldet (401), Anzeige-Route offen und ohne "consumers":
curl -s https://www.rosenweg4303.ch/api/energy/meters
curl -s https://www.rosenweg4303.ch/api/energy/surplus | grep -c consumers   # 0
# Drossel: 1 + Burst 10 gehen durch, ab etwa der 12. schnellen Anfrage 429
# (verbraucht das Kontingent der eigenen IP fuer eine Minute)
for i in $(seq 1 15); do curl -so /dev/null -w '%{http_code} ' -X POST https://www.rosenweg4303.ch/api/doodle/code; done; echo
```

Anmeldung auf einer geschützten Seite einmal im Browser durchspielen
(Rücksprung muss auf `https://` landen).

## Zurückbauen

- **Repo-Stand zurück:** Im LXC `git -C /opt/rosenweg/repo reset --hard <alter-commit>`
  geht nicht dauerhaft, weil `deploy.sh` wieder `origin/main` holt. Zurückbauen
  heisst darum: Änderung in `main` rückgängig machen (Revert-Commit) und
  `deploy.sh` erneut ausführen.
- **Sofort, ohne Repo:** Die beim Rollout am 17.11.2026 ersetzten Dateien liegen
  als `<datei>.vor-sicherheit-2026-11-17` daneben (siehe
  `docs/sicherheit.md` Abschnitt 8.3). Zurückkopieren, `nginx -t`,
  `systemctl reload nginx`. Achtung: Die alten vhosts erlauben wieder alle
  `.json` und alle `/api/energy/`-Pfade direkt zum Collector.
- **Sicherung einer nginx-Konfiguration** immer mit `cp -L` (die Datei in
  `sites-enabled/` ist ein Symlink), Ablage in `sites-available/`.
- **Einzelne Datei** aus `rw-web-ausrollen.sh`: die daneben liegende `.alt`-Kopie
  zurückbenennen.

## Historie: Umstellung vom Swarm (Juni 2026)

Die Frontends wurden einzeln vom Swarm-Traefik (`100.64.2.27`) auf die LXCs
umgestellt (Reihenfolge meg → stweg → stweg3/rosenweg9 → isp/noc → www), indem
in `isp_reverse_proxy_routes` die `backend_url` auf die LXC-IP gesetzt bzw. in
`extra-routes.yml` ein eigener `*-lxc-svc` eingetragen wurde. Die
Swarm-Dienste und die Adressen `100.64.2.24–27` gibt es nicht mehr; ein
Rückweg dorthin besteht nicht.
