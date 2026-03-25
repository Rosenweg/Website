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

## Beispiele

### Einzelwert abrufen

```
GET /api/energy/surplus?field=surplus_w
→ 1234

GET /api/energy/surplus?field=grid_power_w&format={val} W
→ -1234 W

GET /api/energy/surplus?field=production_w&format={val} W
→ 3500 W
```

### LaMetric My Data

In der LaMetric App unter **My Data** eine neue Datenquelle erstellen:

| Einstellung | Wert |
|------------|------|
| **URL** | `https://rosenweg4303.ch/api/energy/surplus?field=surplus_w&format={val} W` |
| **Methode** | GET |
| **Poll-Intervall** | 30 Sekunden |

Weitere Ideen:
- Solar-Produktion: `?field=production_w&format={val} W`
- Netz (Bezug/Einspeisung): `?field=grid_power_w&format={val} W`
- Heizstab: `?field=heizstab_w&format={val} W`

### Shelly Ueberschuss-Steuerung

Ein fertiges Shelly-Script fuer den 1PM/2PM liegt unter `scripts/shelly-surplus-switch.js`.

Schaltet Ausgaenge bei >= 1000W Ueberschuss ein und bei < 10W Verbrauch am Ausgang wieder aus. Details im Script-Header.

### curl

```bash
# Alles als JSON
curl https://rosenweg4303.ch/api/energy/surplus

# Nur Ueberschuss als Zahl
curl https://rosenweg4303.ch/api/energy/surplus?field=surplus_w

# Formatiert
curl "https://rosenweg4303.ch/api/energy/surplus?field=surplus_w&format={val} W"
```
