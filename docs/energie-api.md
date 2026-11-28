# Energie-API – offene Geräte-Routen und angemeldeter Zugriff

Stand: 28.11.2026 (App „Rosenweg Energie“, Abschnitt 8; Grundlage 17.11.2026, PR #23). Dieses Dokument beschreibt alle HTTP-Routen rund um
die Stromzähler: welche ohne Anmeldung erreichbar sind (für Shelly, LaMetric und
Anzeigen), welche eine Anmeldung brauchen, wie die Anfragen durch nginx, die
Haupt-API und den Energy-Collector laufen und welche Fehlercodes vorkommen.
Sicherheitsregeln und Variablen im Überblick: [`sicherheit.md`](sicherheit.md)
Abschnitte 1.1, 4.6 und 6. Fachlicher Überblick (Seiten, Zähler, ZEV):
[`energie.md`](energie.md).

> **Wichtigste Änderung:** Bis zum 17.11.2026 war die ganze Collector-API ohne
> Anmeldung aus dem Internet lesbar (Lastprofile je Wohnung, Zähler-IPs,
> Seriennummern, E-Mail-Adressen der Zuordnungen). Heute sind nur noch sieben
> Geräte-/Anzeige-Routen offen; alle anderen verlangen eine Anmeldung und liefern
> nur die Zähler, die der Person zugeordnet sind. Die Liste `consumers`
> (Live-Leistung je Wohnung) ist aus den offenen Antworten entfernt.

---

## 1. Weg einer Anfrage

```
Browser / Gerät
   │  https://www.rosenweg4303.ch/api/energy/...   (auch stwegN., meg., pwa., rosenweg9.ch)
   ▼
Edge-Traefik (CT 245) ──► Frontend-LXC (nginx, fe-*)
                             │
          ┌──────────────────┴──────────────────────────────┐
          │ offene Route?                                    │ alles andere
          │ surplus | surplus-available | lametric |         │
          │ shelly | solar-live | tariffs | tariffs/current  │
          ▼                                                  ▼
   Energy-Collector (CT 129, 100.64.2.53:3001)       Haupt-API (CT 128, 100.64.2.52:3000)
   upstream rw_energy                                upstream rw_api
                                                     api/routes/energie-lesen.js
                                                     Anmeldung + Zuordnung prüfen,
                                                     dann mit Admin-Schlüssel
                                                     ──► Energy-Collector
```

- **nginx** (`frontends-lxc/nginx/website.conf`, `stweg.conf`, `pwa.conf`; dazu die
  älteren `nginx.conf`/`nginx.stweg.conf` im Repo-Wurzelverzeichnis): ein Block
  `location ^~ /api/energy/` mit einer verschachtelten Regex-Location für die sieben
  offenen Routen. Nur diese gehen direkt an `rw_energy`, alles andere an `rw_api`.
  Die Upstream-Adressen stehen nur in `frontends-lxc/nginx/upstreams.conf`.
- **isp.rosenweg4303.ch** hat keinen eigenen Energie-Block: dort laufen auch die
  offenen Routen über die Haupt-API. Die API reicht sie unverändert durch und
  entfernt bei `surplus`/`surplus-available` die Liste `consumers` (die API ist für
  den Collector ein interner Leser und bekäme sie sonst mitgeliefert).
- **Firewall auf CT 129** (`backend-lxc/energy/firewall/energy-firewall.nft`,
  Unit `rw-energy-firewall`): Port 3001 nur von CT 128 (`.52`) und den
  Frontend-LXCs (`.41`–`.50`, `.54`), Port 5432 (energy-db) nur von CT 128; IPv4 und
  IPv6. Kommt ein Frontend-LXC dazu, muss er in die Sets der Datei.

### 1.1 Schutz im Collector selbst

`energy-collector/collector.js` hat zwei eigene Sperren:

| Sperre | Variable (Collector) | Wirkung |
|---|---|---|
| Admin-Schlüssel | `ADMIN_API_KEY` (aus `ENERGY_ADMIN_API_KEY` in `/opt/rosenweg-energy/.env`) | Alle schreibenden Routen und die Zuordnungs-Routen (`/meters/:id/users`, `/user/:email/meters`) verlangen `Authorization: Bearer <Schlüssel>`. Fehlt der Schlüssel in der Umgebung → **503** „Admin-API nicht konfiguriert“; falscher oder fehlender Header → **401**. Jeder Admin-Aufruf ausser erfolgreichen GET steht im Collector-Log als `[admin] … src=… auth=ok|invalid|missing|unconfigured status=…` (E-Mail-Adressen im Pfad als `<mail>`). |
| Interne Leser | `INTERN_LESER` (aus `ENERGY_INTERN_LESER`, Soll `100.64.2.52`) | Lesende Routen ausser den offenen und `/health` beantwortet der Collector nur, wenn die Quell-IP in der Liste steht oder der Admin-Schlüssel mitkommt; sonst **403** „Nur ueber die Haupt-API mit Anmeldung“. Einträge mit abschliessendem `.` oder `:` gelten als Präfix. |

> **Achtung:** Ist `INTERN_LESER` leer, lässt der Collector alle Lese-Routen für
> jede Quelle durch (Warnung `[intern-leser] WARNUNG …` im Log). Das war als
> Übergang beim Ausrollen gedacht. Nach dem Umstellen der nginx-Frontends muss
> `ENERGY_INTERN_LESER=100.64.2.52` in `/opt/rosenweg-energy/.env` stehen und der
> Collector neu gestartet sein. Prüfen auf CT 129:
> `cd /opt/rosenweg-energy && docker compose logs energy-collector | grep intern-leser`
> darf nach dem letzten Start nichts zeigen.

Ausserdem prüft der Collector Zählerziele (`energy-collector/meter-target.js`): nur
Adressen in `METER_NETWORKS` (`100.64.90.0/24`), Modbus nur auf
`MODBUS_ALLOWED_PORTS` (`502`), nie Loopback, Link-Local, `FORBIDDEN_HOSTS`
(`100.64.2.52`, `100.64.2.53`) – beim Anlegen, beim Test und bei jedem Abfragen.

---

## 2. Offene Routen (ohne Anmeldung)

Gedacht für Geräte und Anzeigen. Alle antworten mit `Access-Control-Allow-Origin: *`
(ausser `solar-live`, `tariffs`, `tariffs/current`, die den Standard-CORS des
Collectors haben – für Geräte ohne Browser unerheblich). Personendaten enthalten sie
nicht.

| Route | Inhalt | Parameter |
|---|---|---|
| `GET /api/energy/surplus` | Netto-Überschuss (was ins Netz geht) | `group` (Standard `r9`), `field`, `format` |
| `GET /api/energy/surplus-available` | Überschuss plus aktuelle Heizstab-/Boilerleistung | `group`, `field` |
| `GET /api/energy/lametric` | Frames im LaMetric-Format | `group`, `fields` |
| `GET /api/energy/shelly` | kompakte Werte für Shelly-Skripte und den Shelly-Emulator | `group`, `variant` |
| `GET /api/energy/solar-live` | Solaranlage Rosenweg 9: Produktion, Netz, Eigenverbrauch, Aufteilung Allgemein/Wohnungen (Summe), Boiler | `anlage` (Standard `r9`; andere → 404, Abschnitt 8.5) |
| `GET /api/energy/tariffs` | alle Tarife (mit `group_id`, `art`, Abschnitt 8.4) | – |
| `GET /api/energy/tariffs/current` | an einem Datum gültige Tarife | `date=YYYY-MM-DD` (Standard heute; ungültig → 400) |

Ebenfalls ohne Anmeldung, aber über die Haupt-API (nginx schickt sie wie alles
andere an `rw_api`): `GET /api/energy/tarif` (Strompreis je Haus) und
`GET /api/energy/anlagen` (Solaranlagen) – Abschnitt 8.

Gross-/Kleinschreibung und ein abschliessender `/` ändern nichts (nginx und Collector
normalisieren den Pfad).

### 2.1 `surplus` und `surplus-available`

```json
{
  "surplus_w": 1234,
  "grid_power_w": -1234,
  "production_w": 3500,
  "heizstab_w": 800,
  "timestamp": "2026-11-17T13:30:00.000Z",
  "group": "r9"
}
```

| Feld | Bedeutung |
|---|---|
| `surplus_w` | Überschuss in Watt, nie negativ. Bei `surplus-available` zusätzlich die Heizstab-Leistung. |
| `grid_power_w` | Netzleistung: negativ = Einspeisung, positiv = Bezug |
| `production_w` | Solarproduktion in Watt |
| `heizstab_w` | aktuelle Leistung des Heizstabs/Boilers |
| `timestamp` | Zeitpunkt des letzten Netzwerts |
| `group` | abgefragte Zählergruppe |

- **Kein `consumers` mehr.** Früher stand hier die Live-Leistung jeder Wohnung. Ein
  Gerät, das `consumers` auswertet, bekommt das Feld nicht mehr. `?field=consumers`
  liefert über den direkten Weg die normale JSON-Antwort (das Feld gibt es nicht),
  über die Haupt-API **404** „Feld nicht verfuegbar“.
- **Keine frische Netz-Quelle** (Hauptzähler und SmartFox beide älter als zwei
  Minuten): Die Route antwortet trotzdem mit 200 und rechnet mit `grid_w = 0`, also
  `surplus_w = 0`. Das ist die sichere Richtung: ohne bestätigten Überschuss wird
  nichts eingeschaltet.
- **Einzelwert als Text:** `?field=<Feldname>` liefert nur diesen Wert als
  `text/plain`; bei `surplus` zusätzlich `&format=` mit Platzhalter `{val}`.

```
GET /api/energy/surplus?field=surplus_w                 → 1234
GET /api/energy/surplus?field=grid_power_w&format={val} W → -1234 W
GET /api/energy/surplus-available?field=surplus_w        → 2034
```

### 2.2 `shelly`

```json
{
  "group": "r9", "variant": "surplus", "timestamp": "2026-11-17T13:30:00.000Z",
  "phase_a_label": "Ueberschuss ohne Boiler", "phase_a_w": 1234,
  "phase_b_label": "Ueberschuss mit Boiler",  "phase_b_w": 2034,
  "phase_c_label": "Heizstab",                "phase_c_w": 800,
  "surplus_without_boiler_w": 1234, "surplus_with_boiler_w": 2034,
  "production_w": 3500, "consumption_w": 0, "grid_w": -1234, "heizstab_w": 800,
  "battery_soc": null
}
```

`variant` bestimmt die Belegung der Phasen A/B/C:

| `variant` | A | B | C |
|---|---|---|---|
| `surplus` (Standard) | Überschuss ohne Boiler | Überschuss mit Boiler | Heizstab |
| `production` | Solarproduktion | Verbrauch | Netzbezug |
| `grid` | Einspeisung | Netzbezug | Netto-Bilanz |
| `ohne-boiler` | Überschuss ohne Boiler | 0 | 0 |
| `mit-boiler` | Überschuss mit Boiler | 0 | 0 |

Unbekannte Werte fallen auf `surplus` zurück. Auch hier immer HTTP 200; ohne frische
Netz-Quelle sind alle Überschusswerte 0. Anleitungen:
[Shelly-Skript (Variante A)](../wiki/shelly-virtual-pv-ueberschuss.md),
[Shelly-Emulator (Variante B)](../wiki/shelly-virtual-pv-emulator.md),
[Shelly 1PM/2PM schalten](../scripts/shelly-surplus-switch.md).

### 2.3 `lametric` – LaMetric „My Data DIY“

Liefert `{"frames":[{"text":"…","icon":"…"}]}`. Werte ab 1000 W erscheinen als
`1.5 kW`, darunter als `850 W`.

| Feld für `fields=` | Icon | Beschriftung |
|---|---|---|
| `surplus_w` | i67405 | Ueberschuss |
| `surplus_available_w` | i67405 | Verfuegbar |
| `production_w` | i37515 | Solar |
| `grid_power_w` | i64129 (Einspeisung) / i59257 (Bezug) | Netz |
| `heizstab_w` | i52509 | Heizstab |

Ohne `fields` erscheinen `surplus_w,production_w,grid_power_w,heizstab_w`. Unbekannte
Feldnamen werden ignoriert.

**Einrichten auf dem LaMetric:**

1. In der LaMetric-App im Store **My Data DIY** installieren.
2. In der App **My Data DIY → Settings** öffnen.
3. **Communication type:** `HTTP Poll`.
4. **URL:** `https://www.rosenweg4303.ch/api/energy/lametric` (Beispiele unten).
5. **Data format:** `Predefined`.
6. **Poll interval:** 30 Sekunden (kürzer bringt nichts, der Collector liest alle 5 s).
7. **Save**.

| Ziel | URL |
|---|---|
| alle vier Hauptwerte | `https://www.rosenweg4303.ch/api/energy/lametric` |
| Überschuss und Solar | `…/api/energy/lametric?fields=surplus_w,production_w` |
| nur Solar | `…/api/energy/lametric?fields=production_w` |
| verfügbarer Überschuss und Heizstab | `…/api/energy/lametric?fields=surplus_available_w,heizstab_w` |

Bleibt das Display leer: URL im Browser öffnen. Kommt dort JSON mit `frames`, liegt
es an der App-Einstellung (Data format muss `Predefined` sein).

### 2.4 Anzeigen und Webseiten

- `solar-live` nutzen die Solar-Seite der STWEG 3 (`stweg3/pages/solaranlage-live.html`),
  die Solar-PWA (`pwa/solar/`) und die Technik-PWA. Die Wohnungen erscheinen dort nur
  als Summe (`wohnungen`), nie einzeln.
- Für eigene Anzeigen (Home Assistant, Node-RED, ioBroker) reicht ein HTTP-Abruf
  einer offenen Route; ein Token ist nicht nötig. Beispiel Home Assistant:

```yaml
sensor:
  - platform: rest
    name: PV Ueberschuss
    resource: https://www.rosenweg4303.ch/api/energy/surplus?field=surplus_w
    unit_of_measurement: W
    scan_interval: 30
```

### 2.5 curl

```bash
curl -s https://www.rosenweg4303.ch/api/energy/surplus                 # JSON, ohne "consumers"
curl -s "https://www.rosenweg4303.ch/api/energy/surplus?field=surplus_w"
curl -s "https://www.rosenweg4303.ch/api/energy/surplus?field=surplus_w&format={val}%20W"
curl -s "https://www.rosenweg4303.ch/api/energy/shelly?variant=production"
curl -s https://www.rosenweg4303.ch/api/energy/lametric
curl -s https://www.rosenweg4303.ch/api/energy/meters                  # 401 – braucht Anmeldung
```

---

## 3. Routen mit Anmeldung (Haupt-API, `api/routes/energie-lesen.js`)

Alle Anfragen brauchen `Authorization: Bearer <Token>` – Sitzungstoken aus der
Anmeldung, Authentik-Token oder persönlicher Zugangstoken (PAT, Scope `energy:read`
bzw. ein Scope, der ihn einschliesst; siehe [`api.md`](api.md)). Die Pfade sind dieselben
wie früher; Webseiten müssen nur ihr Token mitschicken (`AuthentikAuth.apiFetch`).

**Wer sieht was:**

- **Voller Lesezugriff:** Technik, Präsident (Gruppen `technik`, `Präsident`) und alle
  mit dem Recht `energie-config:read` (Rechteverwaltung). Sie sehen alle Zähler mit
  Technikfeldern.
- **Alle anderen Angemeldeten:** nur „ihre“ Zähler – persönlich zugeordnet
  (`meter_users`, E-Mail der Sitzung) oder über eine ihrer Gruppen (`meter_groups`).
  Die Felder `host`, `port`, `unit_id`, `serial`, `shelly_type` werden entfernt.
- E-Mail und Gruppen kommen **immer aus der Sitzung**, nie aus der URL. Die Liste der
  eigenen Zähler wird 60 Sekunden zwischengespeichert.

| Route | Antwort |
|---|---|
| `GET /api/energy/meine-zaehler` | eigene Zähler ohne Technikfelder; nur persönlich zugeordnete, mit `?gemeinschaft=1` auch über Gruppen zugeordnete |
| `GET /api/energie/meine-zaehler` | gleicher Inhalt, eigene Route in `server.js` (genutzt von `profil.html`, `mqtt.html`, `pwa/mqtt`, `pwa/zaehler`); ebenfalls `?gemeinschaft=1` |
| `GET /api/energy/user/:email/meters` | **Altpfad.** Die E-Mail in der URL wird ignoriert, es zählt die Sitzung; mit `?groups=` (Wert egal) inklusive Gruppen-Zähler |
| `GET /api/energy/meters` | voll: alle Zähler mit Technikfeldern; sonst eigene Zähler ohne Technikfelder |
| `GET /api/energy/meters/by-location` | nach Ort gruppiert, ohne vollen Zugriff gefiltert |
| `GET /api/energy/meters/:id/users`, `…/:id/groups` | Zuordnungen (E-Mails, Gruppen) – nur voller Zugriff, sonst **403** |
| `GET /api/energy/live` | Live-Werte; ohne vollen Zugriff nur eigene Zähler |
| `GET /api/energy/{live,history,hourly,daily,today,rollup,consumption,projection,export}/:meterId` | nur zugeordnete Zähler, sonst **403** „Kein Zugriff auf diesen Zaehler“ |
| `GET /api/energy/compare?meters=a,b&days=7` | 1–10 Zähler-IDs, alle müssen erlaubt sein; `days` 1–800 |
| `GET /api/energy/dashboard` | Gruppenübersicht; ohne vollen Zugriff nur eigene Zähler, Gruppensumme aus den eigenen neu gerechnet (30 s Zwischenspeicher) |
| `GET /api/energy/alerts` | Warnungen (Zustand des Warndienstes, Abschnitt 8.6); ohne vollen Zugriff nur eigene Zähler (30 s Zwischenspeicher) |
| `GET /api/energy/{uebersicht,warnungen,reihe/:id,tarif,anlagen}` | für die App „Rosenweg Energie“, Abschnitt 8 |

**Parameter der Zähler-Routen** (werden an den Collector durchgereicht):
`history` `from`, `to`, `limit`; `hourly`/`consumption` `from`, `to`; `daily` `days`,
`to`; `today` `date`; `rollup` `from`, `to`, `bucket=hour|day`; `export` `from`, `to`
(Standard: letzte 30 Tage, CSV mit BOM für Excel, `Content-Disposition` bleibt
erhalten).

**Zähler-IDs** müssen `^[A-Za-z0-9._-]{1,64}$` entsprechen, sonst **400**.
Fremde Zähler ergeben bewusst **403** (nicht 404), damit sich vorhandene IDs nicht
durch Ausprobieren erkennen lassen. Jeder andere Pfad unter `/api/energy/` ergibt
**404** „Unbekannter Energie-Endpunkt“ – auch Schreibzugriffe (die gehen nur über
`/api/energie-admin`).

```bash
T="<Sitzungstoken oder rw_pat_…>"
curl -s -H "Authorization: Bearer $T" https://www.rosenweg4303.ch/api/energy/meine-zaehler
curl -s -H "Authorization: Bearer $T" "https://www.rosenweg4303.ch/api/energy/daily/r9-eg1?days=30"
curl -s -H "Authorization: Bearer $T" -o verbrauch.csv \
  "https://www.rosenweg4303.ch/api/energy/export/r9-eg1?from=2026-10-01&to=2026-10-31"
```

---

## 4. Konfiguration schreiben (`/api/energie-admin/*`)

Nur über die Haupt-API. Die Seite `energie-config.html` ruft diese Routen auf; die API
prüft die Anmeldung und das Recht `energie-config` (GET → `read`, sonst `write`;
Technik und Präsident haben es immer) und leitet mit dem Admin-Schlüssel an den
Collector weiter. Schreibende Aufrufe stehen im API-Log als
`[energie-admin] <email> <METHODE> <pfad> -> <status>`.

| Methode | Pfad unter `/api/energie-admin` | Zweck |
|---|---|---|
| POST | `/meters` | Zähler anlegen (Ziel wird im Collector geprüft) |
| PUT, DELETE | `/meters/:id` | Zähler ändern, löschen |
| POST | `/meters/:id/test` | Verbindung testen |
| POST | `/tariffs` | Tarif anlegen |
| PUT, DELETE | `/tariffs/:id` | Tarif ändern, löschen |
| GET | `/meters/:id/users` | Zuordnungsliste (E-Mails) |
| POST | `/meters/:id/users`, `/meters/:id/groups` | Person bzw. Gruppe zuordnen |
| DELETE | `/meters/:id/users/:email`, `/meters/:id/groups/:name` | Zuordnung entfernen |

Andere Pfade → **404** „Unbekannter Energie-Admin-Endpunkt“. Fehlt
`ENERGY_ADMIN_API_KEY` in `/opt/rosenweg-core/.env` → **503** „Energie-Admin nicht
konfiguriert“. Collector nicht erreichbar → **502**.

---

## 5. Technische Zählerübersicht (`/api/zaehler-technik`)

Für die Technik-PWA und das MCP-Werkzeug `zaehler_technik`.

- **Zugang:** Gruppe `technik`, `präsident`, `verwaltung` (STWEG 3) oder `r9-eigentuemer`
  (Rosenweg 9); sonst **403**. Regel: `api/lib/zaehler-technik.js`
  (`zaehlerTechnikZugang`); dieselbe liefert `/api/auth/me` als `energie.technik`.
- **Volle Sicht** (IP, Port, Unit-ID, Seriennummer, Live-Werte aller Zähler): wer
  `isAdmin` ist (Technik oder Präsident) oder `energie-config:read` hat.
- **Eingeschränkte Sicht** (Verwaltung, Eigentümer Rosenweg 9 ohne dieses Recht):
  Status aller Zähler (online, zuletzt gesehen, Gerätezeit), aber Technikfelder leer
  und Live-Werte nur für Netz, Produktion und die eigenen Zähler; bei den übrigen
  steht `live_verborgen: true`. Kann der Collector die eigenen Zähler nicht liefern,
  gibt es nur Netz und Produktion.
- Antwort: `{ meters: [...], voll: true|false, server_time }`. Ein Zähler gilt als
  offline, wenn sein letzter Wert älter als 30 Sekunden ist.

---

## 6. Fehlercodes

| Code | Wann |
|---|---|
| 200 | auch bei fehlender Netz-Quelle auf den offenen Routen (Werte dann 0) |
| 400 | ungültige Zähler-ID, `compare` ohne bzw. mit mehr als 10 IDs, ungültiges `date` bei `tariffs/current` |
| 401 | kein oder ungültiges Token an der Haupt-API; am Collector: Admin-Route ohne gültigen Schlüssel |
| 403 | fremder Zähler; Zuordnungen ohne vollen Zugriff; fehlendes Recht `energie-config`; `/api/zaehler-technik` ohne passende Gruppe; am Collector: Lese-Route von einer Quelle ausserhalb `INTERN_LESER` |
| 404 | unbekannter Pfad unter `/api/energy/` bzw. `/api/energie-admin/`; `?field=consumers` über die Haupt-API |
| 502 | Collector nicht erreichbar oder Collector-Fehler ≥ 500 (die Haupt-API gibt keine DB-Meldungen weiter) |
| 503 | `ENERGY_ADMIN_API_KEY` fehlt (API) bzw. `ADMIN_API_KEY` fehlt (Collector) |

---

## 7. Betrieb und Prüfung

Variablen (Werte nie ins Repo):

| Wo | Variable | Zweck |
|---|---|---|
| CT 128 `/opt/rosenweg-core/.env` | `ENERGY_ADMIN_API_KEY` | Schlüssel für Collector-Admin und Zuordnungen |
| CT 128 Compose | `ENERGY_COLLECTOR_URL=http://100.64.2.53:3001`, `ENERGY_DB_HOST=100.64.2.53` | Ziel des Proxys, Energie-DB |
| CT 129 `/opt/rosenweg-energy/.env` | `ENERGY_ADMIN_API_KEY` (gleicher Wert), `ENERGY_DB_PASSWORD`, `ENERGY_INTERN_LESER=100.64.2.52`, `MQTT_ENERGY_PASS` | Collector |
| CT 129 Compose | `METER_NETWORKS`, `MODBUS_ALLOWED_PORTS`, `FORBIDDEN_HOSTS` | Zielprüfung |

Nach einer Änderung an `.env` auf CT 129:
`cd /opt/rosenweg-energy && docker compose up -d energy-collector`.

Prüfen von aussen:

```bash
curl -s  https://www.rosenweg4303.ch/api/energy/surplus | grep -c consumers   # 0
curl -so /dev/null -w '%{http_code}\n' https://www.rosenweg4303.ch/api/energy/meters    # 401
curl -so /dev/null -w '%{http_code}\n' https://www.rosenweg4303.ch/api/energy/history/r9-haupt  # 401
```

Prüfen auf CT 129 (Collector direkt, ohne Schlüssel; die Quelle ist dort nicht die
Haupt-API, also muss eine personenbezogene Route 403 liefern):

```bash
curl -so /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/energy/meters  # 403
curl -so /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/energy/surplus # 200
```

Kommt bei `meters` 200, ist `INTERN_LESER` leer (siehe Abschnitt 1.1).

Rückbau: siehe [`sicherheit.md`](sicherheit.md) Abschnitt 8.3
(`/opt/rosenweg-energy/{.env,compose.yml}.vor-sicherheit-2026-11-17`).

---

## 8. App „Rosenweg Energie“ (seit 28.11.2026)

Die Flutter-App bündelt Energie-Monitor, Mein Zähler, Solaranlage live, Zähler-Technik
und Zählerverwaltung. Live-Werte kommen per MQTT (Rückfall: HTTP), Verlauf per HTTP.
Grundlage: Klärung vom 28.11.2026, Lücken L1–L11. Alle Routen unten liegen in
`api/routes/energie-lesen.js`; die Rechenregeln des Collectors stehen in
`energy-collector/energie-logik.js` (reine Funktionen, Tests in
`api/test/energie-app.test.js`).

### 8.1 `GET /api/energy/uebersicht` (Anmeldung) – Startschirm

Ein Aufruf statt `meine-zaehler` + `live` + `today` je Zähler.

```json
{
  "zaehler": [{
    "id": "r9-eg1", "name": "EG links", "kategorie": "consumer", "haus": "r9", "stweg": 3,
    "rolle": "eigen", "online": true,
    "live": { "power_w": 812, "ts": "2026-11-28T12:00:05.000Z" },
    "heute": { "kwh": 10.0, "solar_kwh": 4.0, "netz_kwh": 6.0, "kosten_chf": 2.42 },
    "mqtt": "energy/r9/eg1"
  }],
  "anlagen":   [ "…wie 8.5" ],
  "warnungen": [ "…wie 8.6" ],
  "tarife":    { "r9": { "…wie 8.4": "" } },
  "rechte":    { "stweg_sicht": [], "technik": null, "verwalten": null, "anlagen_eigen": ["r9"] }
}
```

| Feld | Bedeutung |
|---|---|
| `kategorie` | `consumer` \| `grid` \| `production` \| `general` (Spalte `category`) |
| `rolle` | `eigen` (persönlich, `meter_users`), `gemeinschaft` (über eine Gruppe, `meter_groups`), `stweg` (STWEG-Sicht: Ausschuss/Verwaltung mit `energie-monitor`), `alle` (voller Zugriff: Technik/Präsident/`energie-config:read`). Erste passende gewinnt. |
| `online` | letzter Wert jünger als 30 s (wie Zähler-Technik) |
| `live` | Leistung nach Kinder-Abzug (z. B. Allgemein ohne Heizstab), `null` ohne Wert |
| `heute.kwh` | Verbrauch seit Mitternacht (Bezug minus Kinder); Produktionszähler: erzeugte kWh |
| `heute.solar_kwh` / `netz_kwh` | nur Verbraucher (`consumer`/`general`) in einer Gruppe mit Netz- **und** Produktionszähler: Verbrauch × Solaranteil der Gruppe am Tag (Eigenverbrauch / (Eigenverbrauch + Netzbezug), wie Dashboard/Prognose). Die Netz-/Produktionszähler selbst werden dafür nicht herausgegeben (L8). Sonst `null`. |
| `heute.kosten_chf` | Netz × Bezugspreis + Solar × Solarpreis (fehlt der Solarpreis: Bezugspreis) mit dem Tarif des Hauses (8.4); ohne Preis oder bei Netz/Produktion `null` |
| `mqtt` | Thema, unter dem der Collector den Zähler publiziert (8.7) |

### 8.2 `GET /api/energy/reihe/:meterId` (Anmeldung, nur sichtbare Zähler) – Zeitreihe

Parameter: `von`, `bis` (ISO; Standard die letzten 24 h), `raster=auto|1m|5m|15m|1h|1d`
(Standard `auto`), `wert=leistung|verbrauch` (Standard `leistung`).

```json
{ "zaehler": "r9-eg1", "raster": "5m", "wert": "leistung", "einheit": "W",
  "von": "2026-11-21T12:00:00.000Z", "bis": "2026-11-28T12:00:00.000Z",
  "punkte": [ { "t": "2026-11-21T12:00:00.000Z", "v": 432.1 } ] }
```

- Quelle: Rohdaten (Raster unter 1 h, nur bis 30 Tage zurück), `readings_hourly`
  (`1h`) oder Tage aus `readings_hourly` (`1d`). Liegt `von` mehr als 30 Tage zurück,
  ist das Raster mindestens `1h`.
- Höchstens ~2000 Punkte (Grenze 2100, damit eine Woche in 5 min passt): sonst wird das
  Raster vergrössert, auch bei fest gewähltem Raster. Die Antwort nennt das
  tatsächliche `raster`. Zeitraum über 2100 Tage → **400**.
- `leistung` = Ø W je Raster (Einheit `W`); `verbrauch` = kWh je Raster (`kWh`),
  aus den Zählerständen (Differenz der Höchststände aufeinanderfolgender Raster);
  bei Produktionszählern die erzeugten kWh. Kinder werden abgezogen (nie unter 0).
- `v` kann `null` sein (keine Messung im Raster). Fehler: `raster`/`wert`/`von`/`bis`
  ungültig → **400**, fremder Zähler → **403**.

### 8.3 `GET /api/energy/warnungen` (Anmeldung)

```json
[{ "zaehler": "r9-eg1", "name": "EG links", "art": "hoch", "seit": "2026-11-28T10:00:00.000Z",
   "text": "Hoher Verbrauch: 4200 W (sonst Ø 900 W)", "eigen": true, "wert_w": 4200, "schnitt_w": 900 },
 { "zaehler": "r9-eg2", "name": "EG rechts", "art": "offline", "seit": "2026-11-28T09:00:00.000Z",
   "text": "Dein Zähler „EG rechts“ ist offline", "eigen": true, "wert_w": null, "schnitt_w": null }]
```

- Eigene Zähler (persönlich oder Gemeinschaft, `eigen: true`): `offline` und `hoch`.
- Voller Zugriff (Technik/Präsident/`energie-config:read`): zusätzlich `offline` aller
  übrigen Zähler (`eigen: false`, Text „Zähler „…“ ist offline“) – Entscheid E4 b.
- Die STWEG-Sicht allein meldet nichts (keine Hinweise auf fremde Wohnungen).
- Die App fragt im Hintergrund ab und zeigt selbst eine Benachrichtigung; es gibt
  keinen Push-Dienst (kein ntfy). Telegram-Wächter und Strom-Wächter bleiben unberührt.

### 8.4 `GET /api/energy/tarif?haus=<group_id>&datum=YYYY-MM-DD` (offen)

```json
{ "haus": "r9", "quelle": "zev", "chf_kwh": { "bezug": 0.27, "solar": 0.20, "ruecklieferung": 0.082 },
  "gueltig_ab": "2026-01-01", "hinweis": "Geschätzte Kosten, verbindlich ist die ZEV-Rechnung", "elcom": null }
```

Regel (`api/lib/energie-tarif.js`):

| Haus | `quelle` | Preise |
|---|---|---|
| ZEV-Haus mit gültigem Bezugstarif | `zev` | aus der Tariftabelle: zuerst Tarife mit `group_id` = Haus, sonst die globalen (`group_id` leer); je Art der jüngste gültige |
| kein ZEV | `elcom` | `bezug` = ElCom-Gesamtpreis (Kaiseraugst BFS 4252, Kategorie H4, Jahr aus `datum`), `solar`/`ruecklieferung` `null`; `elcom: {jahr, kategorie, gemeinde}` |
| kein Preis (ZEV ohne Bezugstarif, ElCom fehlt oder scheitert) | `null` | alle `null` – die App zeigt keine Kosten |

**ZEV-Haus** = Haus mit eigenem Tarif (`group_id`) **oder** mit aktivem
Produktionszähler. Heute ist das nur Haus 9. Ein ZEV ohne eigene Anlage lässt sich
mit einem Tarif mit `group_id` erklären; globale Tarife gelten nie für Häuser ohne ZEV.

- `haus` fehlt/ungültig oder `datum` nicht `YYYY-MM-DD` → **400**. Ohne `datum`: heute
  (Schweizer Kalendertag). 5 min zwischengespeichert.
- ElCom: die API ruft nur `elcomPreis(gemeinde, jahr, kategorie)` aus
  `api/lib/elcom.js` auf (vom ZEV-Teil gebaut). Fehlt das Modul, ist ElCom `null`.
- Tariftabelle (Collector, `tariffs`): neue Spalten `group_id TEXT NULL` (leer = alle
  ZEV-Häuser) und `art` (`bezug` \| `solar` \| `ruecklieferung`). Beim Start leitet der
  Collector die Art des Altbestands aus dem Namen ab (Netztarif → bezug, Solartarif →
  solar, Rückliefer…/Einspeis… → ruecklieferung). `POST/PUT /api/energie-admin/tariffs`
  nehmen `group_id` und `art` an (leer = aus dem Namen); `energie-config.html` hat
  beide Felder.
- Nutzer: `/today/:id` (zusätzlich `tarif`, `kosten_chf`, `solar_kwh`, `netz_kwh`,
  `solar_anteil`), `/projection/:id` (Kosten, `netz_price`, `solar_price` und `tarif`
  nach dem Haus des Zählers), `/uebersicht`, die Solar-Seiten (`pwa/solar`,
  `stweg3/pages/solaranlage-live.html`: `solar` und `ruecklieferung` von `haus=r9`,
  Rückfall 0.20 / 0.082 CHF, wenn der Abruf scheitert oder der Tarif fehlt).

### 8.5 `GET /api/energy/anlagen` (offen; mit Anmeldung zusätzlich `eigen`)

```json
[{ "id": "r9", "name": "Solaranlage Rosenweg 9", "haus": "r9", "stweg": 3,
   "hat_boiler": true, "hat_ueberschuss": true, "hat_wohnungen": true, "eigen": false,
   "mqtt": "energy/r9/solar", "live": "/api/energy/solar-live?anlage=r9" }]
```

- Quelle: Collector (`/api/energy/anlagen`, intern): jede Gruppe mit aktivem
  Produktionszähler oder SmartFox. Ist der Collector nicht erreichbar oder die Liste
  leer, kommt Haus 9 als Rückfall. 60 s zwischengespeichert.
- `eigen`: die Person hat in diesem Haus einen eigenen oder Gemeinschaftszähler
  (ohne/ungültiges Token: `false`, kein 401).
- Live rechnet der Collector heute nur für `r9` (Resolver geeicht-first mit
  SmartFox-Rückfall). Weitere Anlagen erscheinen mit `mqtt: null`, `live: null`, bis
  der Collector sie hausneutral rechnet; `solar-live?anlage=<andere>` → **404**.
  `hat_ueberschuss` ist nur bei `r9` wahr (nur dort abonniert der Collector
  `energy/r9/ueberschuss/+/total_w`).

### 8.6 Warndienst im Collector

- Jede Minute (`warnLauf`, erster Lauf 90 s nach dem Start), Zustand in der Tabelle
  `meter_alerts(meter_id, art, seit, aktiv, wert_w, schnitt_w, pruef_seit, geaendert)`.
- `offline`: kein Wert seit mehr als 10 min (alle aktiven Zähler); `seit` = letzter Wert.
  Ende sofort, wenn wieder Werte kommen.
- `hoch` (nur `consumer`): aktuelle Leistung > 3 × Ø der Stundenmittel der letzten 7 Tage
  (`readings_hourly`, 15 min zwischengespeichert). Beginnt erst nach 5 min
  durchgehend darüber, endet nach 10 min durchgehend darunter.
- Jede Änderung (an/aus) geht **retained** auf `energy/alerts/<meter_id>`:
  `{"art":"offline"|"hoch","aktiv":true|false,"seit":"ISO","wert_w":4200,"schnitt_w":900}`.
  Pro Zähler ein Thema: eine aktive Warnung gewinnt (offline vor hoch); sonst die zuletzt
  geänderte mit `aktiv: false`.
- `/api/energy/alerts` liest nur noch diesen Zustand (gleiche Felder wie früher plus
  `art`, `seit`, `wert_w`, `schnitt_w`).

### 8.7 MQTT-Themen (Broker `wss://mqtt.rosenweg4303.ch`)

Zugang: `POST /api/mqtt/token` → `{username, password, is_technik, prefix:"energy", expires_in}`.
Laufzeit 12 h, mit Karten-/Anlage-Anmeldung (Stufe `karte`: geteiltes Telefon,
Karte/QR/Handy) **30 min**. Abmelden: `DELETE /api/mqtt/token` (Anmeldung) mit
`{"token":"rwmqtt_…"}` im Body oder Header `X-MQTT-Token` widerruft nur diesen, ohne
Angabe alle Tokens der Person; Antwort `{ok:true, widerrufen:n}`. Eine bestehende
Verbindung bleibt bis zum nächsten Verbinden bzw. ACL-Check (go-auth puffert bis 60 s).

| Thema (retained) | Inhalt |
|---|---|
| `energy/<haus>/<bereich>` | Zähler `<haus>-<bereich>` (z. B. `r9-eg1` → `energy/r9/eg1`, `r9-keller-neziri` → `energy/r9/keller-neziri`, ID ohne `-` → `energy/<id>/<id>`). JSON `{name, location, category, ts, power_w, power_l1_w…l3_w, voltage_l1_v…l3_v, current_l1_a…l3_a, pf_l1…l3, tariff, energy_import_kwh, energy_export_kwh, energy_import_t1_kwh, energy_import_t2_kwh, energy_export_t1_kwh, energy_export_t2_kwh}` bei jedem Poll (5 s); Felder, die das Gerät nicht liefert (z. B. Spannung beim Shelly EM), fehlen oder sind `null`. |
| `energy/<haus>/<bereich>/<feld>` | jedes vorhandene Zahlenfeld einzeln als Text, z. B. `energy/r9/eg1/power_w` → `812.4` |
| `energy/r9/solar/grid_w` | Netz in W (>0 Bezug, <0 Einspeisung), ganzzahlig, alle 5 s |
| `energy/r9/solar/production_w` | Produktion in W |
| `energy/r9/solar/surplus_w` | Überschuss = max(0, −grid_w) |
| `energy/r9/solar/source` | `geeicht` \| `smartfox` \| `none` |
| `energy/r9/solar/ts` | Zeitpunkt in ms seit 1970 (Text) |
| `energy/r9/ueberschuss/<wohnung>/total_w` | PV-Überschuss-Verbraucher je Wohnung (anderer Erzeuger) |
| `energy/alerts/<meter_id>` | Warnung (8.6) |
| `energy/collector/status` | `online` \| `offline` |

> **Achtung:** Die MQTT-Werte sind **roh** – anders als `/live` und `/uebersicht`
> ziehen sie keine Kinder ab (`energy/r9/allgemein` enthält den Heizstab). Solarwerte
> gibt es per MQTT nur zusammengefasst; die Aufteilung (Wohnungen, Allgemein, Boiler,
> Überschuss) liefert `solar-live`.

**ACL** (`/api/mqtt/aclcheck` → `mqttEnergieErlaubt` in `routes/energie-lesen.js`, je
Konto 60 s zwischengespeichert; Menschen lesen nur, schreiben nie):

| Thema | Wer liest |
|---|---|
| `heartbeat`, `display/#` | alle Angemeldeten (unverändert) |
| `energy/collector/status` | alle Angemeldeten |
| `energy/<anlage>/solar[/…]` | alle Angemeldeten, für jede Anlage aus 8.5 (L2) |
| `energy/<haus>/<bereich>[/…]` | wer den Zähler `<haus>-<bereich>` per HTTP sieht: eigene, Gemeinschaft, STWEG-Sicht (Ausschuss/Verwaltung mit `energie-monitor`) (L1) |
| `energy/<haus>/ueberschuss/<wohnung>[/…]` | wer den Zähler `<haus>-<wohnung>` sieht (personenbezogen) |
| `energy/alerts/<meter_id>` | wer den Zähler sieht |
| alles unter `energy/` inkl. Wildcards | voller Zugriff (`energie-config:read`); Technik/Präsident sind ohnehin Superuser |

Wildcards (`+`, `#`) auf Zähler-Ebene sind ohne vollen Zugriff verboten (z. B.
`energy/r9/+`); `energy/r9/solar/#` ist erlaubt. Service-User (`mqtt_service_users`,
z. B. ein öffentlicher Lese-Benutzer) und Topic-Regeln (`mqtt_topic_rules`) prüft
aclcheck wie bisher vorher – ihre Filter stehen in der Datenbank, nicht im Code. Für
Besucher ohne Konto kommen die Solarwerte per HTTP (`solar-live`), nicht per MQTT.

### 8.8 Rechte in `GET /api/auth/me`

```json
"user": { "…": "…",
  "permissions": { "energie-monitor": "read", "energie-stweg": "read", "zaehler-technik": "read" },
  "energie": { "stweg_sicht": [3], "technik": "voll"|"eingeschraenkt"|null,
               "verwalten": "read"|"write"|null, "anlagen_eigen": ["r9"] } }
```

| Feld | Quelle (dieselbe Prüfung wie die Routen) |
|---|---|
| `stweg_sicht` | STWEGs, deren Zähler das Konto als Ausschuss/Verwaltung **mit vergebenem** `energie-monitor` sieht (`stwegSichtAktiv`). Das automatische `energie-monitor: read` für Zähler-Inhaber zählt nicht. Technik/Präsident: `[]` (sie sehen über `verwalten`/`technik` ohnehin alles). |
| `technik` | `requireZaehlerTechnik` würde durchlassen (`lib/zaehler-technik.js`) → `voll` mit vollem Zugriff (Technik/Präsident/`energie-config:read`), sonst `eingeschraenkt`; kein Zugang → `null` |
| `verwalten` | Recht `energie-config` (`write`/`read`), Technik/Präsident `write` |
| `anlagen_eigen` | Anlagen (8.5), in deren Haus das Konto einen eigenen oder Gemeinschaftszähler hat |

Zusätzliche Seitenschlüssel in `permissions` (nur wenn zutreffend, abgeleitet, nicht in
der Rechteverwaltung einstellbar): `energie-stweg: read` (STWEG-Sicht greift),
`zaehler-technik: read` (Zähler-Technik offen). Das automatische `energie-monitor: read`
bleibt.

### 8.9 Nicht übernommen

`zaehler.html`, das Recht `zähler` und `POST/GET /api/zähler/daten` (Tabelle
`zaehler_daten`) sind Alt-Reste ohne Funktion und kommen nicht in die App (E12).
