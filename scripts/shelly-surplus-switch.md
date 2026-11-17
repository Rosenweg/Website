# Shelly Überschuss-Steuerung

Schaltet einen Shelly 1PM oder 2PM (Gen2) basierend auf dem solaren Überschuss der Anlage.

## Funktionsweise

- Alle 15 Sekunden wird der aktuelle Überschuss von der Rosenweg-API abgefragt
- **Einschalten**: Wenn der Überschuss >= 1000W beträgt
- **Ausschalten**: Wenn der Verbrauch am Shelly-Ausgang unter 10W fällt
- Durch die unterschiedlichen Schwellwerte wird häufiges Ein-/Ausschalten vermieden

## Verfügbare API-Endpoints

| Endpoint | Beschreibung |
|---|---|
| `/api/energy/surplus` | Netto-Überschuss — was tatsächlich ins Netz eingespeist wird |
| `/api/energy/surplus-available` | Verfügbarer Überschuss — inkl. dem was der Heizstab gerade verbraucht |

Beide Endpoints geben JSON zurück:
```json
{
  "surplus_w": 1500,
  "grid_power_w": -1500,
  "production_w": 3500,
  "heizstab_w": 800,
  "timestamp": "2026-11-17T13:30:00Z",
  "group": "r9"
}
```

| Feld | Beschreibung |
|------|-------------|
| `surplus_w` | Überschuss in Watt (>= 0) |
| `grid_power_w` | Netz-Leistung (negativ = Einspeisung, positiv = Bezug) |
| `production_w` | Solar-Produktion in Watt |
| `heizstab_w` | Heizstab-Verbrauch in Watt |
| `timestamp` | Zeitpunkt des letzten Netzwerts |
| `group` | Zählergruppe (Standard `r9`, über `?group=` wählbar) |

Diese Abfragen sind **ohne Anmeldung** erreichbar, damit der Shelly sie direkt lesen
kann. Seit dem 17.11.2026 fehlt in der Antwort das frühere Feld `consumers` (Leistung
je Wohnung) – es verriet, wer zu Hause ist. Für die Steuerung wird es nicht gebraucht;
das Skript liest nur `surplus_w`. Liefern Hauptzähler und SmartFox seit zwei Minuten
keinen Wert, antwortet die API trotzdem mit `surplus_w: 0` – der Shelly schaltet dann
nicht ein. Alle Parameter und weitere offene Abfragen: [`docs/energie-api.md`](../docs/energie-api.md).

### Einzelwerte abrufen

Mit dem `field` Parameter kann ein einzelner Wert als Plaintext abgerufen werden. Mit `format` lässt sich die Ausgabe formatieren:

```
GET /api/energy/surplus?field=surplus_w
→ 1500

GET /api/energy/surplus?field=grid_power_w&format={val} W
→ -1500 W

GET /api/energy/surplus?field=production_w&format={val} W
→ 3500 W
```

### LaMetric My Data DIY

Die LaMetric App **My Data DIY** zeigt beliebige Daten von einer URL auf dem LaMetric Display an. Unser `/api/energy/lametric` Endpoint liefert die Daten direkt im richtigen Format (Predefined JSON).

#### Einrichtung

**Schritt 1 — App installieren:**
1. LaMetric App auf dem Smartphone oeffnen
2. Im Store nach **My Data DIY** suchen und installieren
3. Die App erscheint in der App-Liste des LaMetric

**Schritt 2 — Datenquelle einrichten:**
1. In der LaMetric App auf **My Data DIY** tippen → **Settings**
2. **Communication type**: `HTTP Poll`
3. Bei **URL** eingeben:
   ```
   https://www.rosenweg4303.ch/api/energy/lametric
   ```
4. **Data format**: `Predefined`
5. **Poll interval**: `30 seconds` (oder nach Wunsch)
6. **Save** tippen

#### Beispiel 1: Alle Werte (Standard)

Ohne Parameter werden alle 4 Hauptwerte angezeigt.

**URL:**
```
https://www.rosenweg4303.ch/api/energy/lametric
```

**Ergebnis:** Vier rotierende Frames:
- Frame 1: `Ueberschuss 1.5 kW`
- Frame 2: `Solar 3.5 kW`
- Frame 3: `Netz -1.5 kW` (negativ = Einspeisung, positiv = Bezug)
- Frame 4: `Heizstab 800 W`

Werte unter 1000W werden als `850 W` angezeigt, darueber als `1.5 kW`.

#### Beispiel 2: Nur Ueberschuss und Solar

**URL:**
```
https://www.rosenweg4303.ch/api/energy/lametric?fields=surplus_w,production_w
```

**Ergebnis:** Zwei rotierende Frames:
- Frame 1: `Ueberschuss 1.5 kW`
- Frame 2: `Solar 3.5 kW`

#### Beispiel 3: Nur Solar-Produktion

**URL:**
```
https://www.rosenweg4303.ch/api/energy/lametric?fields=production_w
```

**Ergebnis:** Ein einzelner Frame: `Solar 3.5 kW`

#### Beispiel 4: Verfuegbarer Ueberschuss (inkl. Heizstab)

Zeigt was verfuegbar waere, wenn der Heizstab abgeschaltet wuerde:

**URL:**
```
https://www.rosenweg4303.ch/api/energy/lametric?fields=surplus_available_w,heizstab_w
```

**Ergebnis:**
- Frame 1: `Verfuegbar 2.3 kW`
- Frame 2: `Heizstab 800 W`

#### Verfuegbare Felder

| Feld | Icon-ID | Label | Beschreibung |
|------|---------|-------|-------------|
| `surplus_w` | i67405 | Ueberschuss | Netto-Ueberschuss (was ins Netz geht) |
| `surplus_available_w` | i67405 | Verfuegbar | Verfuegbarer Ueberschuss (inkl. Heizstab) |
| `production_w` | i37515 | Solar | Solar-Produktion |
| `grid_power_w` | i64129 / i59257 | Netz | Netz-Leistung (Icon wechselt: Export/Import) |
| `heizstab_w` | i52509 | Heizstab | Heizstab-Verbrauch |

Mehrere Felder mit Komma trennen: `?fields=surplus_w,production_w`

#### API-Response Format

Der Endpoint liefert das Standard LaMetric `frames`-Format:

```json
{
  "frames": [
    { "text": "Ueberschuss 1.5 kW", "icon": "i67405" },
    { "text": "Solar 3.5 kW", "icon": "i37515" },
    { "text": "Netz -1.5 kW", "icon": "i64129" },
    { "text": "Heizstab 800 W", "icon": "i52509" }
  ]
}
```

#### Alternative: Plaintext fuer andere Displays

Falls nur ein einzelner Wert als Text benoetigt wird (z.B. fuer andere IoT-Geraete):
```
/api/energy/surplus?field=surplus_w              → 1500
/api/energy/surplus?field=surplus_w&format={val} W   → 1500 W
/api/energy/surplus?field=production_w&format={val} W → 3500 W
```

---

## Installation

### 1. Script auf den Shelly laden

1. Shelly Web UI öffnen (IP-Adresse des Shelly im Browser)
2. **Scripts** → **Add Script**
3. Inhalt von `shelly-surplus-switch.js` einfügen
4. Script-Name vergeben, z.B. "Überschuss"
5. **Save** klicken

### 2. Konfiguration anpassen

Im Script die `CONFIG`-Werte anpassen:

```javascript
let CONFIG = {
  url: "https://www.rosenweg4303.ch/api/energy/surplus",
  check_interval: 15,   // Sekunden zwischen Checks
  on_threshold: 1000,   // Watt Überschuss zum Einschalten
  off_power: 10,        // Watt unter dem abgeschaltet wird
  outputs: [0]           // [0] für 1PM, [0, 1] für 2PM
};
```

| Parameter | Standard | Beschreibung |
|---|---|---|
| `url` | `.../surplus` | API-Endpoint; `.../surplus-available` nutzen wenn Heizstab-Verbrauch berücksichtigt werden soll. Die Datei `shelly-surplus-switch.js` im Repo enthält noch `http://rosenweg4303.ch/...`; `http` wird vom Edge-Proxy auf `https` umgeleitet. Darum beim Einfügen direkt die `https://www.`-Adresse eintragen. |
| `check_interval` | 15 | Abfrageintervall in Sekunden (min. 10 empfohlen) |
| `on_threshold` | 1000 | Mindest-Überschuss in Watt zum Einschalten |
| `off_power` | 10 | Verbrauch am Ausgang in Watt unter dem abgeschaltet wird |
| `outputs` | `[0]` | Ausgänge: `[0]` für Shelly 1PM, `[0, 1]` für beide Kanäle beim 2PM |

### 3. Autostart aktivieren

1. Neben dem Script auf **Enable** / **Start on boot** klicken
2. Mit **Start** einmal manuell starten zum Testen

### 4. Testen

- Im Shelly unter **Scripts** → **Console** die Log-Ausgaben prüfen:
  ```
  Überschuss-Steuerung gestartet
  Surplus: 2300W
  CH0 EIN (Überschuss: 2300W)
  ```
- Bei Fehlermeldungen `API error, skip` die URL und Netzwerkverbindung prüfen. Die URL im Browser öffnen: es muss JSON mit `surplus_w` kommen. Kommt `401`, ist eine Route eingetragen, die eine Anmeldung braucht (z. B. `/api/energy/live`) – für den Shelly nur `/surplus` oder `/surplus-available` verwenden.

## Voraussetzungen

- Shelly Gen2 Gerät (1PM, 2PM, Plus 1PM, etc.)
- Firmware >= 1.0.0
- Shelly muss `www.rosenweg4303.ch` über HTTPS erreichen können (DNS + Internet)

## Typische Anwendungsfälle

- **Poolpumpe**: Einschalten bei Solarüberschuss
- **Lüftung/Entfeuchtung**: Betrieb bei kostenlosem Strom
- **Zusätzlicher Verbraucher**: Warmwasser-Booster, Ladegerät etc.
