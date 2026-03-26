# Energie API - Surplus Endpoints

Offene API-Endpoints (ohne Authentifizierung) zum Abrufen von Echtzeit-Energiedaten. Gedacht fuer IoT-Geraete (Shelly, LaMetric, etc.) und externe Integrationen.

---

## Endpoints

### GET `/api/energy/surplus`

Netto-Ueberschuss: Was aktuell ins Netz eingespeist wird.

### GET `/api/energy/surplus-available`

Verfuegbarer Ueberschuss: Netto + Heizstab-Verbrauch (was verfuegbar waere, wenn der Heizstab aus waere).

---

## Parameter

| Parameter | Beschreibung | Beispiel |
|-----------|-------------|----------|
| `group` | STWEG-Gruppe (Standard: `r9`) | `?group=r9` |
| `field` | Einzelnen Wert als Plaintext zurueckgeben | `?field=surplus_w` |
| `format` | Formatierung mit `{val}` Platzhalter (nur mit `field`) | `?field=surplus_w&format={val} W` |

---

## Response (JSON)

Ohne `field` Parameter:

```json
{
  "surplus_w": 1234,
  "grid_power_w": -1234,
  "production_w": 3500,
  "heizstab_w": 800,
  "consumers": [
    { "id": "r9-wohnung1", "name": "Wohnung 1", "power_w": 320 },
    { "id": "r9-wohnung2", "name": "Wohnung 2", "power_w": 180 }
  ],
  "timestamp": "2026-03-25T14:30:00.000Z",
  "group": "r9"
}
```

| Feld | Beschreibung |
|------|-------------|
| `surplus_w` | Ueberschuss in Watt (>= 0) |
| `grid_power_w` | Netz-Leistung (negativ = Einspeisung, positiv = Bezug) |
| `production_w` | Solar-Produktion in Watt |
| `heizstab_w` | Heizstab-Verbrauch in Watt |
| `consumers` | Einzelne Verbraucher mit ID, Name und aktueller Leistung |
| `timestamp` | Zeitstempel der letzten Messung |

Bei `/api/energy/surplus-available` wird `surplus_w` zusaetzlich um den Heizstab-Verbrauch erhoeht.

---

## Einzelwert abrufen

```
GET /api/energy/surplus?field=surplus_w
→ 1234

GET /api/energy/surplus?field=grid_power_w&format={val} W
→ -1234 W

GET /api/energy/surplus?field=production_w&format={val} W
→ 3500 W
```

---

## LaMetric My Data DIY

Die LaMetric App **My Data DIY** zeigt beliebige Daten von einer URL auf dem LaMetric Display an. Unser `/api/energy/lametric` Endpoint liefert die Daten direkt im richtigen Format (Predefined JSON).

### Einrichtung

**Schritt 1 — App installieren:**
1. LaMetric App auf dem Smartphone oeffnen
2. Im Store nach **My Data DIY** suchen und installieren
3. Die App erscheint in der App-Liste des LaMetric

**Schritt 2 — Datenquelle einrichten:**
1. In der LaMetric App auf **My Data DIY** tippen → **Settings**
2. **Communication type**: `HTTP Poll`
3. Bei **URL** eingeben:
   ```
   https://rosenweg4303.ch/api/energy/lametric
   ```
4. **Data format**: `Predefined`
5. **Poll interval**: `30 seconds` (oder nach Wunsch)
6. **Save** tippen

### Beispiel 1: Alle Werte (Standard)

Ohne Parameter werden alle 4 Hauptwerte angezeigt.

**URL:**
```
https://rosenweg4303.ch/api/energy/lametric
```

**Ergebnis:** Vier rotierende Frames:
- Frame 1: `Ueberschuss 1.5 kW`
- Frame 2: `Solar 3.5 kW`
- Frame 3: `Netz -1.5 kW` (negativ = Einspeisung, positiv = Bezug)
- Frame 4: `Heizstab 800 W`

Werte unter 1000W werden als `850 W` angezeigt, darueber als `1.5 kW`.

### Beispiel 2: Nur Ueberschuss und Solar

**URL:**
```
https://rosenweg4303.ch/api/energy/lametric?fields=surplus_w,production_w
```

**Ergebnis:** Zwei rotierende Frames:
- Frame 1: `Ueberschuss 1.5 kW`
- Frame 2: `Solar 3.5 kW`

### Beispiel 3: Nur Solar-Produktion

**URL:**
```
https://rosenweg4303.ch/api/energy/lametric?fields=production_w
```

**Ergebnis:** Ein einzelner Frame: `Solar 3.5 kW`

### Beispiel 4: Verfuegbarer Ueberschuss (inkl. Heizstab)

Zeigt was verfuegbar waere, wenn der Heizstab abgeschaltet wuerde:

**URL:**
```
https://rosenweg4303.ch/api/energy/lametric?fields=surplus_available_w,heizstab_w
```

**Ergebnis:**
- Frame 1: `Verfuegbar 2.3 kW`
- Frame 2: `Heizstab 800 W`

### Verfuegbare Felder

| Feld | Icon-ID | Label | Beschreibung |
|------|---------|-------|-------------|
| `surplus_w` | i67405 | Ueberschuss | Netto-Ueberschuss (was ins Netz geht) |
| `surplus_available_w` | i67405 | Verfuegbar | Verfuegbarer Ueberschuss (inkl. Heizstab) |
| `production_w` | i37515 | Solar | Solar-Produktion |
| `grid_power_w` | i64129 / i59257 | Netz | Netz-Leistung (Icon wechselt: Export/Import) |
| `heizstab_w` | i52509 | Heizstab | Heizstab-Verbrauch |

Mehrere Felder mit Komma trennen: `?fields=surplus_w,production_w`

### API-Response Format

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

### Plaintext fuer andere Displays

Falls nur ein einzelner Wert als Text benoetigt wird (z.B. fuer andere IoT-Geraete):
```
/api/energy/surplus?field=surplus_w              → 1500
/api/energy/surplus?field=surplus_w&format={val} W   → 1500 W
/api/energy/surplus?field=production_w&format={val} W → 3500 W
```

---

## Shelly Ueberschuss-Steuerung

Ein fertiges Shelly-Script fuer den 1PM/2PM liegt unter `scripts/shelly-surplus-switch.js`.

Schaltet Ausgaenge bei >= 1000W Ueberschuss ein und bei < 10W Verbrauch am Ausgang wieder aus. Details unter `scripts/shelly-surplus-switch.md`.

---

## curl

```bash
# Alles als JSON
curl https://rosenweg4303.ch/api/energy/surplus

# Nur Ueberschuss als Zahl
curl https://rosenweg4303.ch/api/energy/surplus?field=surplus_w

# Formatiert
curl "https://rosenweg4303.ch/api/energy/surplus?field=surplus_w&format={val} W"

# LaMetric-Format
curl https://rosenweg4303.ch/api/energy/lametric
```
