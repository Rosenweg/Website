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
  "consumers": [
    { "id": "r9-wohnung1", "name": "Wohnung 1", "power_w": 320 }
  ],
  "timestamp": "2026-03-25T14:30:00Z",
  "group": "r9"
}
```

| Feld | Beschreibung |
|------|-------------|
| `surplus_w` | Überschuss in Watt (>= 0) |
| `grid_power_w` | Netz-Leistung (negativ = Einspeisung, positiv = Bezug) |
| `production_w` | Solar-Produktion in Watt |
| `heizstab_w` | Heizstab-Verbrauch in Watt |
| `consumers` | Einzelne Verbraucher mit ID, Name und aktueller Leistung |

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

Fuer die LaMetric App **My Data DIY** gibt es einen dedizierten Endpoint der das richtige JSON-Format (`frames`) direkt liefert:

```
GET /api/energy/lametric
```

**Einrichtung in der LaMetric App:**

1. LaMetric App oeffnen → **My Data DIY** installieren
2. Datenquelle konfigurieren:

| Einstellung | Wert |
|------------|------|
| **URL** | `https://rosenweg4303.ch/api/energy/lametric` |
| **Methode** | GET |
| **Poll-Intervall** | 30 Sekunden |

Standardmaessig werden **Ueberschuss** und **Solar-Produktion** angezeigt (mit automatischer kW/W Formatierung).

**Angezeigte Werte anpassen** mit dem `fields` Parameter:

| URL | Anzeige |
|-----|---------|
| `/api/energy/lametric` | Ueberschuss + Solar (Standard) |
| `/api/energy/lametric?fields=surplus_w` | Nur Ueberschuss |
| `/api/energy/lametric?fields=surplus_w,production_w,grid_power_w` | Ueberschuss + Solar + Netz |
| `/api/energy/lametric?fields=production_w,heizstab_w` | Solar + Heizstab |
| `/api/energy/lametric?fields=surplus_available_w,production_w` | Verfuegbarer Ueberschuss + Solar |

Verfuegbare Felder: `surplus_w`, `surplus_available_w`, `production_w`, `grid_power_w`, `heizstab_w`

**Beispiel-Response:**
```json
{
  "frames": [
    { "text": "1.5 kW", "icon": "i23396" },
    { "text": "3.5 kW", "icon": "i3069" }
  ]
}
```

**Alternative: Plaintext fuer einfache Anzeige**

Falls nur ein einzelner Wert benoetigt wird:
- Ueberschuss: `?field=surplus_w&format={val} W`
- Solar: `?field=production_w&format={val} W`
- Netz: `?field=grid_power_w&format={val} W`

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
  url: "http://rosenweg4303.ch/api/energy/surplus",
  check_interval: 15,   // Sekunden zwischen Checks
  on_threshold: 1000,   // Watt Überschuss zum Einschalten
  off_power: 10,        // Watt unter dem abgeschaltet wird
  outputs: [0]           // [0] für 1PM, [0, 1] für 2PM
};
```

| Parameter | Standard | Beschreibung |
|---|---|---|
| `url` | `.../surplus` | API-Endpoint; `.../surplus-available` nutzen wenn Heizstab-Verbrauch berücksichtigt werden soll |
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
- Bei Fehlermeldungen `API error, skip` die URL und Netzwerkverbindung prüfen

## Voraussetzungen

- Shelly Gen2 Gerät (1PM, 2PM, Plus 1PM, etc.)
- Firmware >= 1.0.0
- Shelly muss `rosenweg4303.ch` erreichen können (DNS + Internet oder lokales Netz)

## Typische Anwendungsfälle

- **Poolpumpe**: Einschalten bei Solarüberschuss
- **Lüftung/Entfeuchtung**: Betrieb bei kostenlosem Strom
- **Zusätzlicher Verbraucher**: Warmwasser-Booster, Ladegerät etc.
