# Website — Rosenweg

Stand: 17.11.2026. Sicherheitsregeln (Header, Sperrlisten, Drosseln, Rollen)
stehen zentral in [`sicherheit.md`](sicherheit.md); der Betrieb der
Frontend-Container im Detail in
[`../frontends-lxc/README.md`](../frontends-lxc/README.md).

## Übersicht

Statische HTML-Seiten plus eine Node.js-API. Kein Framework: plain
HTML/CSS/JS, Tailwind CSS vom CDN.

| Teil | Wo | Wie ausgerollt |
|---|---|---|
| Hauptseite `www.rosenweg4303.ch` | CT 118 `fe-www`, 100.64.2.41, nginx, Docroot `/var/www/rosenweg` | `frontends-lxc/deploy.sh` (ganzer Stand) oder `scripts/rw-web-ausrollen.sh` (einzelne Dateien) |
| STWEG-Seiten, MEG, `rosenweg9.ch` | CT 120–127, 100.64.2.43–.50 | dito |
| ISP und NOC (`isp.`, `noc.`) | CT 119 `fe-isp`, 100.64.2.42 | dito |
| PWA (`pwa.`) | CT 130 `fe-pwa`, 100.64.2.54 | dito |
| API | CT 128 `core-backend`, 100.64.2.52:3000, Docker Compose unter `/opt/rosenweg-core` | `docker compose pull api && docker compose up -d api` |
| Energie-Collector | CT 129 `energy-stack`, 100.64.2.53:3001 | Compose unter `/opt/rosenweg-energy` |
| TLS, Hostnamen | CT 245 `edge-traefik`, 100.64.2.40 | siehe [`../edge-traefik/README.md`](../edge-traefik/README.md) |

Die Docker-Images `rosenweg-website`, `rosenweg-isp` und `rosenweg-stweg`
werden von GitHub Actions noch gebaut, aber **nirgends mehr betrieben**. Das
API-Image `ghcr.io/rosenweg/rosenweg-api` ist dagegen das, was auf CT 128 läuft
(jeder Commit zusätzlich unter seiner Git-SHA als Tag).

## Seiten

### Öffentlich (ohne Login)
| Seite | Pfad | Beschreibung |
|-------|------|-------------|
| Login | `/index.html` | Startseite, Login-Button |
| Reparatur melden | `pwa.rosenweg4303.ch/reparatur/` (Kurzadressen `/defekt-melden`, `/reparatur` auf www leiten dorthin um) | Meldung ohne Konto mit E-Mail-Code; Grenzen siehe `sicherheit.md` Abschnitt 4.2 |
| Echtheitsprüfung | `/echtheitspruefung.html` | 30 Prüfungen je 10 Min je Client |

### Authentifiziert (Bewohner)
| Seite | Pfad | Beschreibung |
|-------|------|-------------|
| Profil | `/profil.html` | Persönliche Daten, Passwort ändern (nur mit frischer Anmeldung, siehe unten), SSH-Schlüssel |
| Energie-Monitor | `/energie-monitor.html` | Stromverbrauch, nur zugeordnete Zähler |
| Zähler | `/zaehler.html` | Zähler-Übersicht |
| Entsorgung | `/entsorgung.html` | Abfallkalender |
| Projekte | `/projekte.html` | Laufende Projekte |

### Verwaltung, Ausschuss, Technik
| Seite | Pfad | Wer |
|-------|------|-----|
| Verwaltung | `/verwaltung.html` | Benutzerverwaltung; Nicht-Technik nur Bewohner-/Eigentümer-Gruppen der eigenen Ausschuss-STWEG |
| Wohnungsverwaltung | `/objektverwaltung.html` | Ausschuss **dieser** STWEG, Verwaltung mit Gruppe dieser STWEG, Technik/Präsident |
| Rechteverwaltung | `/rechteverwaltung.html` | Technik/Präsident |
| Email-Verteiler | `/email-verteiler.html` | gemäss Recht |
| Email-Archiv | `/email-archiv.html` | gemäss Recht |
| Email-Log | `/email-log.html` | nur Technik/Präsident |
| Energie-Config | `/energie-config.html` | Recht `energie-config` (Schreiben: `write`) |
| Proxmox | `/proxmox-verwaltung.html` | Technik |

Die genaue Rechtelogik je Bereich: `sicherheit.md` Abschnitt 4.3.

### STWEG-Seiten
| Pfad | Beschreibung |
|------|-------------|
| `stweg1..7.rosenweg4303.ch`, `meg.rosenweg4303.ch` | je STWEG eine Startseite (Docroot-Unterordner `/stwegN/` bzw. `/meg/`) |
| `rosenweg9.ch`, `www.rosenweg9.ch` | Eigendomain von STWEG 3 (gleicher Inhalt wie `stweg3.`) |
| `/waschkueche.html` | nur unter den STWEG-3-Hostnamen, sonst 404 |

Die früheren Ordner `stwegN/data/` (Kontaktlisten) werden nicht mehr
ausgeliefert; `/data/` ist auf den STWEG-Hosts gesperrt.

### Spezial
| Pfad | Beschreibung |
|------|-------------|
| `/tuerschilder.html` | Türschilder & Poster mit Token-QR drucken (Login); Ziel der QR: `/raum.html?t=<token>` |
| `kiosk/` (Repo) | Einrichtung der Kiosk-Geräte (`setup-kiosk.sh`) – kein Webinhalt |

## Shared JavaScript

| Datei | Funktion |
|-------|----------|
| `js/authentik-auth.js` | SSO-Login, Token-Verwaltung, `apiFetch()` – wird mit `?v=5` eingebunden |
| `js/nav.js` | Navigation (alle Seiten), STWEG-Adressen; auf fe-isp ersetzt durch `js/nav-isp.js` |

### authentik-auth.js — Wichtige Methoden

- `AuthentikAuth.login(redirect, opts)` — Weiterleitung zu Authentik über
  `/api/auth/login`. `opts.reauth` erzwingt eine neue Passwortabfrage
  (für den Passwortwechsel), `opts.auto` kennzeichnet einen automatischen Start
  (Schleifensperre, siehe unten). Auch `login({ reauth: true })` ist möglich.
- `AuthentikAuth.logout()` — Sitzung löschen, zurück zur Startseite.
- `AuthentikAuth.isLoggedIn()`, `getUser()`, `getToken()`, `isAdmin()`,
  `hasPermission(page, level)`.
- `AuthentikAuth.apiFetch(url, options)` — Fetch mit Auth-Header. Reine Objekte
  werden als JSON gesendet; `FormData`, `Blob`, Strings usw. unverändert.
  **Abmeldung nur bei HTTP 401** oder wenn die Antwort auf die Authentik-Anmeldung
  umgeleitet wurde – ein 5xx beendet die Sitzung nicht.
- `AuthentikAuth.init({requireAuth, requireAdmin, onLogin, onLogout})` — Seiten-Init.
- `AuthentikAuth.ready` (Promise) und das Event `authentik-auth-ready` auf
  `window` melden, wenn feststeht, ob jemand angemeldet ist (Wert: Nutzer oder
  `null`).

Regeln, die man beim Bauen von Seiten und Routen kennen muss:

- **401 heisst „Sitzung ungültig"** und meldet ab. Fachliche Fehler (falsches
  Passwort, fehlendes Recht) müssen 400 oder 403 liefern.
- **Rücksprung nur aus eigenem Start:** Ein `#auth=`-Token in der Adresse wird nur
  übernommen, wenn `login()` im selben Browser in den letzten 15 Minuten gestartet
  wurde (Merker `rosenweg_login_gestartet`). Sonst wird er verworfen. Das
  Nutzerobjekt kommt immer von `/api/auth/me`.
- **Schleifensperre:** Höchstens 2 automatische Login-Starts in 2 Minuten je Tab;
  danach erscheint ein Hinweis mit Knopf „Anmelden".
- **Browser-Bindung:** Die API setzt beim Start der Anmeldung das Cookie
  `rw_oauth_bind`. Fehlt es beim Rücksprung (anderer Browser, Cookies
  blockiert, API dazwischen neu gestartet), zeigt die API „Anmeldung
  abgebrochen" (HTTP 400). Dann die Anmeldung einfach neu beginnen.
- **Passwort ändern** (`profil.html`) geht nur aus einer höchstens 15 Minuten
  alten Authentik-Anmeldung; das Profil bietet dafür „Jetzt neu anmelden"
  (`login({ reauth: true })`). Höchstens 5 Versuche pro Stunde; danach werden
  alle anderen Sitzungen des Kontos beendet.
- **Kopien:** `whatsapp-bot/public/authentik-auth.js` ist eine byte-gleiche Kopie
  und muss bei Änderungen mitkopiert werden.

## Nginx-Konfiguration

Die vhosts liegen in `frontends-lxc/nginx/{website,isp,stweg,pwa}.conf`, die
Backend-Adressen in `frontends-lxc/nginx/upstreams.conf`. Kurzfassung:

| Pfad | Ziel |
|---|---|
| `/api/energy/{surplus,surplus-available,lametric,shelly,solar-live,tariffs,tariffs/current}` | Collector, CT 129 `100.64.2.53:3001` |
| alle anderen `/api/energy/…` und `/api/…` | API, CT 128 `100.64.2.52:3000` |
| `*.html`, `/` | `Cache-Control: no-cache, must-revalidate`, dazu `CDN-Cache-Control: no-store` |
| `*.css`, `*.js` | `no-store` (Browser und Cloudflare halten nichts) |
| Bilder/Fonts | 7 Tage, `immutable` |
| `/api/…` | nie zwischengespeichert (`no-store`, ETag/Last-Modified entfernt) |

Sicherheits-Header, Sperrregeln (`.md`, `.json`, `/data/` …) und die Drossel
`rw_otp` für die Code-Endpunkte: siehe
[`../frontends-lxc/README.md`](../frontends-lxc/README.md#sperr--und-schutzregeln-in-nginx)
und `sicherheit.md` Abschnitte 4.2 und 4.5.

## Deployment

Es gibt **keinen automatischen Weg vom Push auf die Seite.** Ausgerollt wird von
Hand, auf zwei Arten:

| Was | Werkzeug | Wirkung |
|---|---|---|
| nginx-Konfiguration geändert, Frontend komplett auf `main` bringen, neues Frontend | `frontends-lxc/deploy.sh` im Container | holt `origin/main`, installiert Konfiguration und Header-Datei, baut den Docroot aus der Positivliste neu (`rsync --delete`), `nginx -t`, Reload |
| einzelne Seiten oder Skripte geändert | `scripts/rw-web-ausrollen.sh` vom Arbeitsplatz | legt nur die genannten Dateien dorthin, wo sie schon liegen; ändert keine Konfiguration |

**Nach dem 17.11.2026 zuerst `deploy.sh` auf allen elf Frontends**, damit die
neuen Sperrregeln, die Header-Datei und die Energie-Aufteilung aktiv sind. Läuft
auf einem Container noch die alte Fassung des Skripts, scheitert der erste Lauf
bei `nginx -t` (Header-Datei fehlt) – dann **ein zweites Mal starten**. Genauer
Ablauf und Prüfbefehle:
[`../frontends-lxc/README.md`](../frontends-lxc/README.md#ausrollen).

### Einzelne Dateien mit `rw-web-ausrollen.sh`

Es gibt mehrere `fe-*`-Container mit **unterschiedlichem** Inhalt. Die
Hauptseite liegt allein auf `fe-www` (CT 118). `fe-stweg1..7`, `fe-meg`,
`fe-isp` und `fe-pwa` führen ihre eigenen, kleineren Bestände. Wer blind
spiegelt, überschreibt Fremdes.

```bash
scripts/rw-web-ausrollen.sh --pruefen profil.html js/nav.js   # nur vergleichen
scripts/rw-web-ausrollen.sh profil.html js/nav.js             # ausrollen
scripts/rw-web-ausrollen.sh --neu neue-seite.html             # auch dorthin, wo sie fehlt
```

Voraussetzung: SSH-Zugang über den Sprunghost (`RW_JUMP`, Standard
`stefan@10.0.10.149`) auf einen Cluster-Knoten (`RW_NODE`, Standard
`root@100.64.2.20`) und als root auf die Frontend-Container.

Das Skript fragt den Cluster nach allen laufenden `fe-*`-Containern und legt
jede Datei dorthin, wo sie schon liegt — was ein Container hat, bekommt er
aktuell; was er nicht hat, bekommt er nicht (ausser mit `--neu`). Vor dem
Überschreiben entsteht eine `.alt`-Kopie (nginx liefert `.alt` nicht aus),
danach wird die Prüfsumme verglichen. Die Zwischendatei auf dem Container hat
seit dem 17.11.2026 einen Zufallsnamen (`mktemp`), damit niemand dort vorab einen
Symlink an ihre Stelle legen kann. Eingebaute Ausnahmen: fe-isp bekommt
`js/nav-isp.js` als `js/nav.js` und nie das allgemeine `js/nav.js`; Dateien
unter `pwa/` gehen nur nach fe-pwa (ohne das Präfix `pwa/`).

nginx braucht nach `rw-web-ausrollen.sh` kein Neuladen — es liest die Dateien
bei jeder Anfrage. Zurück: die `.alt`-Datei wieder auf den alten Namen
umbenennen.

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

Die damals von Hand gesetzte Sperre steht seit dem 17.11.2026 im Repo
(`frontends-lxc/nginx/*.conf`) und wird mit `deploy.sh` auf alle Frontends
verteilt; zusätzlich baut `deploy.sh` den Docroot nur noch aus einer
Positivliste. Am 17.11.2026 fanden sich trotzdem noch alte Dateien aus der
Docker-Zeit (`networks_full.json`, `devices_full.json`, `network-data.json`,
`stweg*/data/kontakte.json`) – sie sind gelöscht, die darin enthaltenen
Schlüssel gelten als kompromittiert (`sicherheit.md` Abschnitte 1.3 und 7.1).

## Das Lagebild: eine Datei, zwei Orte

`js/noc-cockpit.js` rendert das NOC. Beide Seiten binden dasselbe Modul ein
und übergeben nur den Modus:

| Seite | Aufruf | Takt |
|---|---|---|
| `noc-fullscreen.html` (Wandbild, fe-www + fe-isp) | `modus: 'wandbild'` | 5 s |
| `isp-admin.html` (Cockpit oben auf der Seite) | `modus: 'eingebettet'` | 30 s |

Bis zum 5.9.2026 waren es **zwei getrennte Umsetzungen** desselben
Monitorings, die auseinanderliefen: Das Cockpit hatte Dienst-Ampeln,
Kontingent-Balken, Top-Sender und die Mail-Pfade; das Wandbild hatte
Dienstwacht, Nextcloud, die beiden Mail-Warteschlangen und den WAN-Durchsatz
mit Verlaufsgrafik. Jede Ergänzung landete nur in einer der beiden. Das Modul
ist die Vereinigung.

Neue Kachel? Nur in `js/noc-cockpit.js` — dann mit
`scripts/rw-web-ausrollen.sh js/noc-cockpit.js` ausrollen, und beide Seiten
haben sie.

### Anschlüsse: die drei Zustände

Die Kachel «Anschlüsse» zeigt je Anschluss einen Punkt. Bewertet wird in
`api/server.js` (`bewerteAnschluesse`), und dieselbe Funktion bedient die
Bewohnerseite `isp-mein-zugang.html` über `/api/isp/subscribers/me` — im NOC
alle Anschlüsse, dort nur die eigenen.

| Punkt | Bedeutung |
|---|---|
| grün | das reservierte Gerät ist da, unter seiner Adresse |
| gelb | eingetragen, aber nichts zu sehen — oder gesehen und noch ohne Adresse |
| rot | fremde MAC auf der reservierten Adresse, oder die reservierte MAC unter einer anderen |

Die Reservierung steht am Anschluss selbst: `isp_subscribers.fixed_ip` und
`mac_dot1x`. **Nicht** in `isp_fixed_ips` — das sind Service- und Wohnungs-IPs
und heute leer. Ohne hinterlegte MAC gibt es keinen Widerspruch und darum nie
rot; die Kachel nennt dann «ohne MAC-Bindung», damit die Lücke sichtbar bleibt.

Am 5.9.2026 hat die Kachel ihren ersten echten Fall gefunden und dabei die
ganze Kette durchlaufen — rot, gelb, grün:

1. **rot** — die reservierte MAC lief unter `100.64.0.59` statt `100.64.89.30`.
   Ursache: Im Anschluss-Datensatz fehlte der Switch-Port, deshalb blieb Port 2
   des SFP+-Switch1 ein Trunk mit dem Inter-Building Network als untagged
   Netz. Der Client-Router landete dort, und die UniFi-Reservierung (die am
   Netz RW8-Clients hängt) konnte nie greifen.
2. **gelb** — nach dem Nachtragen des Ports im ISP-Admin provisionierte UniFi
   den Port sofort auf VLAN 89. Das Gerät stand im richtigen Netz, hatte aber
   noch keine Adresse: Die alte Lease lief weiter.
3. **grün** — Lease abgelaufen, Reservierung gezogen, `100.64.89.30`.

Zwei Lehren stecken darin. Der Zwischenzustand «gesehen, aber ohne Adresse»
muss gelb sein, nicht grün — ohne Adresse benutzt das Gerät seine Reservierung
ja nicht. Und ein Gerät in einem fremden Netz ist ein Befund, kein Uplink: Ein
Zwischenstand, in dem ich das als Router-Uplink abgetan hatte, hat den echten
Fehler weggeräumt und musste zurückgenommen werden.

Den Weg zu den Zahlen wählt das Modul selbst: `?token=…` → öffentliche
Endpunkte mit `X-Noc-Token` (der Token wandert sofort aus der Adresszeile),
angemeldet → geschützte Endpunkte, sonst öffentlich ohne Ausweis. Ebenso im
Modul: Überlappungsschutz, Pause bei verstecktem Tab, und ein `sicher()`, das
eine kaputte Kachel nicht die ganze Seite kosten lässt.

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

Die nackte Adresse `/` wird von `location = / { try_files /$site/index.html
=404; }` bedient und setzte als einzige keine Kopfzeile. Das `add_header` steht
seit dem 5.9.2026 **genau dort — innerhalb des bestehenden Blocks**, nicht als
neue Location davor; `add_header` ändert kein Routing, eine Location schon.
Damit schicken alle zwölf Frontends für `/` und für `*.html` dieselbe
Kopfzeile.

### Sicherungen von nginx-Konfigurationen

`/etc/nginx/sites-enabled/rosenweg.conf` ist ein **Symlink** nach
`sites-available/`. `cp -a` darauf kopiert nur den Symlink — die vermeintliche
Sicherung zeigt auf dieselbe Datei, und ein Zurückspielen tut nichts. Immer
`cp -L` verwenden und in `sites-available/` ablegen.

**Das NOC-Wandbild** ist der Grund für das Skript — siehe oben; von Hand nur noch im Notfall.

## API ausrollen (CT 128)

Die API läuft in Docker Compose auf CT 128 (`core-backend`, pve1,
100.64.2.52:3000), Umgebung aus `/opt/rosenweg-core/.env` (Werte nie im Repo;
Liste der sicherheitsrelevanten Variablen: `sicherheit.md` Abschnitt 6):

```bash
ssh -J stefan@10.0.10.149 root@100.64.2.20 \
  'pct exec 128 -- sh -c "cd /opt/rosenweg-core && docker compose pull api && docker compose up -d api"'
```

Prüfen:

```bash
ssh -J stefan@10.0.10.149 root@100.64.2.20 'pct exec 128 -- sh -c "cd /opt/rosenweg-core && docker compose ps api && docker compose logs --tail 50 api"'
curl -s https://www.rosenweg4303.ch/api/health
```

Im Log beim Start auf Warnungen über fehlende Pflichtvariablen achten (z. B.
`AD_PASSWORD_API_SECRET fehlt`, `PRINT_API_SECRET fehlt`) – die betroffene
Funktion ist dann abgeschaltet, nicht mit einem Standardwert aktiv.

Zurück auf einen älteren Stand (jeder Commit liegt unter seiner SHA in der
Registry):

```bash
pct exec 128 -- bash -c 'cd /opt/rosenweg-core
  docker pull ghcr.io/rosenweg/rosenweg-api:<letzte-gute-sha>
  docker tag ghcr.io/rosenweg/rosenweg-api:<letzte-gute-sha> ghcr.io/rosenweg/rosenweg-api:latest
  docker compose up -d api'
```

Die vor dem Rollout vom 17.11.2026 gültige Umgebung liegt als
`/opt/rosenweg-core/.env.vor-sicherheit-2026-11-17` daneben.

## Wenn die Dienstwacht viel meldet

Am 11.09.2026 kamen 11 Meldungen an einem Tag statt der ueblichen 1. Die
Vermutung lag nahe, die Anlage sei instabil. Sie war es nicht: **10 der
Meldungen kamen von einem einzigen Dienst**, und alle vier Befunde auf
CT 245 hatten dieselbe Ursache — die Wurzel war zu 100% voll.

Daraus zwei Lehren fuer die Auswertung:

**Erstens: zaehlen, nicht lesen.** Welcher Dienst wie oft gemeldet hat,
steht in einer Zeile:

```sql
SELECT body, count(*) FROM whatsapp_messages
 WHERE body LIKE 'Dienstwacht%' AND created_at > now() - interval '2 days'
 GROUP BY 1 ORDER BY 2 DESC;
```

Ein Dienst, der im Minutentakt scheitert und wieder startet, erzeugt bei
jedem Durchlauf einen *neuen* Befund — die Wacht meldet ihn darum immer
wieder. Das sieht nach vielen Problemen aus und ist eines.

**Zweitens: `logrotate` und `man-db` sind keine Nebensache.** Beide
scheitern fast nur aus einem Grund — kein Platz. Sie gehoeren deshalb
ausdruecklich **nicht** in die Ignorierliste von `rw-dienstwacht.sh`:
sie waren am 11.09. die einzigen Vorboten, dass dem Edge-Router und der
PBX der Platz ausging. Was dort ignoriert werden darf, sind nur Units,
die in einem LXC *niemals* gelingen koennen (Kernel-Mounts, Netzwerk-
Units). Alles andere ist ein Symptom.

Aufraeumen und deckeln: [`rw-platz-machen.sh`](../scripts/rw-platz-machen.sh).
Es loescht nichts — es komprimiert, deckelt das Journal und legt Regeln
fuer Logdateien an, die von keiner erfasst werden.

### `226/NAMESPACE` — logrotate lief gar nicht

Auf CT 111 (cups-server) scheiterten `logrotate` und `man-db` nicht an
Platz, sondern an fehlenden Rechten:

```
logrotate.service: Failed at step NAMESPACE spawning /usr/sbin/logrotate:
Permission denied
logrotate.service: Main process exited, code=exited, status=226/NAMESPACE
```

Die Units bringen Sandbox-Direktiven mit (`PrivateTmp`, `ProtectSystem`,
`ProtectControlGroups`, `ProtectHostname`, `RestrictNamespaces` …), die
einen Mount- bzw. UTS-Namespace brauchen. Ohne `nesting=1` darf der
Container das nicht. Ergebnis: **logrotate lief dort seit dem 10.09.2026
ueberhaupt nicht mehr** — CT 111 waere der naechste volle Container
geworden.

Zwei Wege:

- **Struktureller Fix:** `pct set <id> --features nesting=1` + Neustart
  des Containers. Loest die ganze Klasse, kostet aber Ausfallzeit.
- **Ohne Neustart:** Drop-in unter
  `/etc/systemd/system/<unit>.service.d/lxc.conf`, das alle
  namespace-bildenden Direktiven auf `no` setzt. In einem LXC verliert man
  dadurch wenig — logrotate laeuft ohnehin als root. So auf CT 111 gemacht.

Einzeln nachziehen fuehrt ins Leere: es sind mehr als ein Dutzend
Direktiven, und jede nicht abgeschaltete laesst den Start weiter
scheitern. Alle auf einmal, oder `nesting=1`.
