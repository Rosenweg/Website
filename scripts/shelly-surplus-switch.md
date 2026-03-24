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
  "heizstab_w": 3000,
  "timestamp": "2026-03-24T14:30:00Z",
  "group": "r9"
}
```

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
  url: "http://rosenweg.net/api/energy/surplus",
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
- Shelly muss `rosenweg.net` erreichen können (DNS + Internet oder lokales Netz)

## Typische Anwendungsfälle

- **Poolpumpe**: Einschalten bei Solarüberschuss
- **Lüftung/Entfeuchtung**: Betrieb bei kostenlosem Strom
- **Zusätzlicher Verbraucher**: Warmwasser-Booster, Ladegerät etc.
