# Wetterstation: Topics, Ersatzwerte von MeteoSchweiz

Die Wetterstation Rosenweg 9 (Station `r9`) liefert ihre Werte über ioBroker auf den Broker.
Fällt sie aus, liefert die API **Ersatzwerte aus den Open Data von MeteoSchweiz**
(Bodenstationen SwissMetNet, 10-Minuten-Werte, Sammlung `ch.meteoschweiz.ogd-smn`).
Quelle: MeteoSchweiz (Namensnennung nach den OGD-Nutzungsbedingungen).

## Topics (alle retained)

| Topic | Inhalt | Wer schreibt |
|-------|--------|--------------|
| `wetter/r9/<feld>` | Rohwerte der **eigenen** Station (Zahl oder Text). **Unverändert**, bei Ausfall bleiben hier die letzten bzw. eingefrorenen Werte stehen. | ioBroker |
| `rosenweg/wetter/<feld>` | **Gültige** Werte: eigene Station, bei Ausfall MeteoSchweiz. Gleiche Feldnamen und Einheiten wie `wetter/r9/<feld>`. Leerer Inhalt = Wert gibt es gerade nicht. | API |
| `rosenweg/wetter/quelle` | JSON `{"art":"eigen"\|"meteoschweiz","station":"r9"\|"BAS","stand":"2026-11-28T13:10:00.000Z","zustand":"eigen"\|"ersatz",…}`; bei Ersatz zusätzlich `name`, `abstand_km`, `hinweis` | API |
| `rosenweg/wetter/zustand` | `eigen`, `ersatz` oder `ausgefallen` (weder eigene Station noch Ersatz) | API |

Felder: `outdoortemp` (°C), `outdoorhumidity` (%), `windspeed` (km/h), `windgustspeed` (km/h),
`winddir` (°), `pressureabs` (hPa), `pressurerel` (hPa), `solarradiation` (**Lux**, wie die eigene
Station; W/m² = Lux / 126.7), `uvi`, `rain` (mm/h).

**Für Regelungen (Heizung, Beschattung …):** `rosenweg/wetter/#` abonnieren, nicht `wetter/r9/#`.
`zustand` und `quelle.stand` zeigen, ob und wie frisch die Werte sind. Bei `ersatz` sind es
Messwerte einer Station in rund 10 km Entfernung (Wind, Strahlung und Regen können deutlich abweichen).
Bei `ausgefallen` bleiben die letzten Werte stehen, `quelle.stand` wird nicht mehr nachgeführt.

Veröffentlicht wird so:
- eigene Station gesund: bei jedem Ingest (jede Minute), aber nur bei Änderung, spätestens alle 10 Minuten;
  der Wechsel zurück auf die eigene Station kommt sofort mit dem nächsten Ingest.
- Ersatz: alle 10 Minuten (MeteoSchweiz aktualisiert ebenfalls alle 10 Minuten).

Der API-Benutzer `collector` braucht Schreibrecht auf `rosenweg/wetter/#` (Broker-ACL), lesen dürfen die
Regelsysteme (mqtt_topic_rules bzw. Service-Benutzer).

## HTTP

| Pfad | Zweck |
|------|-------|
| `GET /api/wetter/r9/aktuell` (öffentlich) | `{station, zustand, ts, werte, quelle, ausfall}`. `quelle` ist `{art:"eigen",station,stand}` oder `{art:"meteoschweiz",station,name,abstand_km,stand,hinweis}`. `werte` in den Feldern oben, bei Ersatz zusätzlich `sonnenschein_min`. |
| `GET /api/wetter/r9/history?h=24` (öffentlich) | wie bisher; Ersatzpunkte stehen mit `ersatz:true` und `ersatz_station` im selben `points`-Array, eigene Punkte im Ersatzzeitraum entfallen. Zusätzlich `ersatz:{von,bis}` oder `null`. |
| `GET /api/isp/noc/public/wetter` (Token) bzw. `/api/isp/noc/wetter` | Zustand für die NOC-Kachel (`ampel`: gruen/gelb/rot, `text`) |

## Umschalten

Auf Ersatz wird umgeschaltet, wenn die eigene Station
- seit mehr als `WETTER_AUSFALL_MIN` (20) Minuten nichts geliefert hat (kein Ingest), oder
- keine Temperatur liefert oder unplausible Werte (Temperatur ausserhalb −40…+50 °C, Feuchte ausserhalb 0…100 %, Wind < 0 oder > 300 km/h, Druck ausserhalb 500…1100 hPa), oder
- `WETTER_EINGEFROREN_MIN` (60) Minuten lang weder Temperatur noch Feuchte verändert hat.

Zurück auf die eigenen Werte: sobald keine dieser Bedingungen mehr zutrifft (eine einzige Änderung
der Temperatur oder Feuchte genügt gegen „eingefroren“).

## Zuordnung MeteoSchweiz -> unsere Felder

| MeteoSchweiz | Feld |
|--------------|------|
| `tre200s0` Temperatur 2 m | `outdoortemp` |
| `ure200s0` relative Feuchte | `outdoorhumidity` |
| `fu3010z0` Wind, 10-min-Mittel (km/h) | `windspeed` |
| `fu3010z1` Böenspitze, 1 s (km/h) | `windgustspeed` |
| `dkl010z0` Windrichtung | `winddir` |
| `prestas0` Luftdruck QFE (Stationsdruck, nicht auf Kaiseraugst umgerechnet) | `pressureabs` |
| `pp0qffs0` Luftdruck QFF (Meereshöhe) | `pressurerel` |
| `gre000z0` Globalstrahlung (W/m²) × 126.7 | `solarradiation` (Lux) |
| `rre150z0` Niederschlag 10 min (mm) × 6 | `rain` (mm/h) |
| `sre000z0` Sonnenscheindauer 10 min (min) | `sonnenschein_min` (nur API) |
| – | `uvi` (wird nicht gemessen, leer) |

Zeitstempel der OGD-Dateien sind UTC.

## Stationen und Abruf

Abruf von `https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/<abk>/ogd-smn_<abk>_t_now.csv`
(offizieller, schlüsselloser Endpunkt; Stationsliste in `ogd-smn_meta_stations.csv`).
Höchstens alle 10 Minuten je Station, Zeitlimit 8 s, Antwort im Speicher zwischengehalten;
die API-Antworten warten nie auf einen neuen Abruf (ausser ganz am Anfang ohne Zwischenspeicher).

Nächste Stationen zu Kaiseraugst (47.54 N, 7.72 E) mit allen Messgrössen:
**BAS** Basel / Binningen (10.3 km, Hauptstation), **MOE** Möhlin (12.4 km, Ausweichstation).
St. Chrischona (STC, 4.3 km) misst nur Strahlung und Sonnenschein, Rünenberg (RUE) kein
Wind/QFF – deshalb nicht gewählt. Es gilt die erste Station, deren neuester Wert höchstens 60 Minuten alt ist.

Verlauf: Ersatzwerte stehen in `wetter_history` unter `station = 'meteoschweiz-bas'` (bzw. `-moe`),
nie unter `r9`.

## Umgebungsvariablen (API)

| Variable | Standard |
|----------|----------|
| `WETTER_ERSATZ` | an; `0` schaltet alles ab |
| `WETTER_STATION` | `r9` |
| `WETTER_AUSFALL_MIN` | 20 |
| `WETTER_EINGEFROREN_MIN` | 60 |
| `WETTER_ERSATZ_STATION` / `WETTER_ERSATZ_STATION2` | `BAS` / `MOE` |
| `WETTER_ERSATZ_ABSTAND_MIN` | 10 (kleinster Abstand zwischen Abrufen) |
| `WETTER_ERSATZ_MAXALTER_MIN` | 60 |
| `WETTER_ERSATZ_TIMEOUT_MS` | 8000 |
| `WETTER_MQTT_PREFIX` | `rosenweg/wetter` |
| `WETTER_OGD_URL` | `https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn` |
