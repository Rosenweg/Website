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

Die LaMetric App **My Data DIY** zeigt beliebige Daten von einer URL auf dem LaMetric Time Display an. Unser `/api/energy/lametric` Endpoint liefert die Daten direkt im richtigen Format.

#### Beispiel 1: Solar-Ueberschuss auf dem LaMetric anzeigen

Zeigt den aktuellen Ueberschuss und die Solar-Produktion als abwechselnde Frames an.

**Schritt 1 — App installieren:**
1. LaMetric Time App auf dem Smartphone oeffnen
2. Im Store nach **My Data DIY** suchen und installieren
3. Die App erscheint in der App-Liste des LaMetric

**Schritt 2 — Datenquelle einrichten:**
1. In der LaMetric App auf **My Data DIY** tippen → **Settings**
2. Bei **URL** eingeben:
   ```
   https://rosenweg4303.ch/api/energy/lametric
   ```
3. **Poll frequency**: `30 seconds` (oder nach Wunsch)
4. **Save** tippen

**Ergebnis:** Das LaMetric wechselt zwischen zwei Anzeigen:
- Frame 1: `⚡ 1.5 kW` (Ueberschuss)
- Frame 2: `☀ 3.5 kW` (Solar-Produktion)

Werte unter 1000W werden als `850 W` angezeigt, darueber als `1.5 kW`.

#### Beispiel 2: Drei Werte anzeigen (Ueberschuss + Solar + Netz)

**URL:**
```
https://rosenweg4303.ch/api/energy/lametric?fields=surplus_w,production_w,grid_power_w
```

**Ergebnis:** Drei rotierende Frames:
- Frame 1: `⚡ 1.5 kW` (Ueberschuss — was ins Netz geht)
- Frame 2: `☀ 3.5 kW` (Solar-Produktion)
- Frame 3: `🔌 -1.5 kW` (Netz — negativ = Einspeisung, positiv = Bezug)

#### Beispiel 3: Nur Solar-Produktion

**URL:**
```
https://rosenweg4303.ch/api/energy/lametric?fields=production_w
```

**Ergebnis:** Ein einzelner Frame: `☀ 3.5 kW`

#### Beispiel 4: Verfuegbarer Ueberschuss (inkl. Heizstab)

Zeigt was verfuegbar waere, wenn der Heizstab abgeschaltet wuerde:

**URL:**
```
https://rosenweg4303.ch/api/energy/lametric?fields=surplus_available_w,heizstab_w
```

**Ergebnis:**
- Frame 1: `⚡ 2.3 kW` (Verfuegbarer Ueberschuss)
- Frame 2: `🔥 800 W` (Heizstab-Verbrauch)

#### Verfuegbare Felder

| Feld | Icon | Beschreibung |
|------|------|-------------|
| `surplus_w` | ⚡ | Netto-Ueberschuss (was ins Netz geht) |
| `surplus_available_w` | ⚡ | Verfuegbarer Ueberschuss (inkl. Heizstab) |
| `production_w` | ☀ | Solar-Produktion |
| `grid_power_w` | 🔌 | Netz-Leistung (negativ = Einspeisung) |
| `heizstab_w` | 🔥 | Heizstab-Verbrauch |

Mehrere Felder mit Komma trennen: `?fields=surplus_w,production_w`

#### API-Response Format

Der Endpoint liefert das Standard LaMetric `frames`-Format:

```json
{
  "frames": [
    { "text": "1.5 kW", "icon": "i23396" },
    { "text": "3.5 kW", "icon": "i3069" }
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
