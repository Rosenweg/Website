# Shelly Virtual-Components: PV-Überschuss Rosenweg 9

Anleitung um die zwei PV-Überschuss-Datenpunkte (mit Boiler / ohne Boiler) der
Rosenweg-9-Solaranlage auf einem Shelly Plus oder Pro als Virtual-Number-Components
verfügbar zu machen. Andere Shellys, die Shelly Smart Control App und Home Assistant
können dann ganz normal darauf reagieren.

## Datenquelle

```
GET https://energy.rosenweg4303.ch/api/energy/shelly
```

Liefert (auszugsweise):

```json
{
  "group": "r9",
  "timestamp": "2026-06-09T08:23:14.000Z",
  "surplus_without_boiler_w": 2150,
  "surplus_with_boiler_w": 4300,
  "production_w": 5400,
  "grid_w": -2150,
  "heizstab_w": 2150
}
```

- `surplus_without_boiler_w` — der reale Netz-Überschuss (was aktuell ins Netz fliesst)
- `surplus_with_boiler_w` — der theoretische Überschuss wenn der Boiler-Heizstab aus wäre

## Voraussetzungen

- Ein Shelly mit Script-Support: **Plus 1, Plus 1PM, Plus 2PM, Plus i4, Pro 1, Pro 2, Pro 3, Pro 4PM**, etc.
- Firmware ≥ **1.4.0** (für Virtual-Components)
- Shelly hat Internetzugang zur API

## Schritt 1 — Virtual Components anlegen

In der Shelly Web-UI: **Settings → Device Configuration → Components → Add component**.

Lege zwei `Number` Components an:

| Field | Component 1 | Component 2 |
|---|---|---|
| **Type** | Number | Number |
| **ID** | `200` | `201` |
| **Name** | `PV Überschuss ohne Boiler` | `PV Überschuss mit Boiler` |
| **Min** | `0` | `0` |
| **Max** | `15000` | `15000` |
| **Default** | `0` | `0` |
| **Unit** | `W` | `W` |
| **Meta** ui.view | `field` | `field` |

(Die IDs `200` und `201` sind frei wählbar, müssen aber im mJS-Skript übereinstimmen.)

## Schritt 2 — mJS-Skript installieren

**Settings → Scripts → Add script** — Name `pv-ueberschuss-poll`, Inhalt:

```javascript
// PV-Ueberschuss Poll-Script fuer Rosenweg 9
// Holt alle 30s die zwei Ueberschuss-Werte vom Backend und updated
// die Virtual-Number-Components 200 und 201.

let URL = "https://energy.rosenweg4303.ch/api/energy/shelly";
let INTERVAL_MS = 30 * 1000;
let COMP_OHNE_BOILER = "number:200";
let COMP_MIT_BOILER  = "number:201";

function poll() {
  Shelly.call("HTTP.GET", { url: URL, timeout: 10 }, function(result, err_code, err_msg) {
    if (err_code !== 0 || !result || result.code !== 200) {
      console.log("PV-Poll Fehler:", err_msg || ("HTTP " + (result && result.code)));
      return;
    }
    try {
      let data = JSON.parse(result.body);
      Shelly.call("Number.Set", { id: 200, value: data.surplus_without_boiler_w }, null);
      Shelly.call("Number.Set", { id: 201, value: data.surplus_with_boiler_w }, null);
      console.log("PV Update:", data.surplus_without_boiler_w, "W /", data.surplus_with_boiler_w, "W");
    } catch (e) {
      console.log("PV-Parse Fehler:", e);
    }
  });
}

Timer.set(INTERVAL_MS, true, poll);
poll();
```

**Speichern → Start → Auto-Start aktivieren** (damit das Script auch nach Neustart wieder läuft).

## Schritt 3 — Verifikation

1. Im **Components-View** der Shelly Web-UI sollten die beiden Number-Werte nach ~30s aktuelle Watt-Zahlen anzeigen.
2. Im **Console-Tab des Scripts** sieht man die `PV Update:` Log-Zeilen alle 30s.
3. In der **Shelly Smart Control App** erscheinen die zwei Components als Karten — können in Scenes referenziert werden.

## Schritt 4 — Beispiel-Automation

Klassischer Use-Case in Smart Control:

- **Wenn** `PV Überschuss ohne Boiler > 1500 W` für mindestens 5 Minuten
- **Dann** Wallbox-Schalter EIN

Oder:

- **Wenn** `PV Überschuss mit Boiler < 500 W`
- **Dann** Pool-Pumpe AUS

## Troubleshooting

| Problem | Ursache | Lösung |
|---|---|---|
| Script läuft nicht | Kein Internet, oder Cert-Fehler | `Settings → System → Time & Region` prüfen, NTP muss sync sein für TLS |
| Werte aktualisieren nicht | Component-ID stimmt nicht | im Component-View die echte ID lesen + im Skript anpassen |
| `Shelly.call HTTP.GET error` | Falsche URL oder DNS | im Browser direkt aufrufen ob Endpoint antwortet |
| Werte = 0 obwohl Solar läuft | Energy-Collector liefert noch keine Daten | `/api/energy/shelly` direkt testen |

## Sicherheit

Der API-Endpoint ist read-only und liefert nur die aggregierten Überschuss-Werte —
keine Einzel-Daten, keine Personenbezug. Kein Auth-Token nötig.

## Variante B (Standalone-Emulator)

Wer den PV-Überschuss als eigenständiges virtuelles Shelly-Gerät im Netz haben will
(z.B. um es in der Shelly-App ohne Host-Device zu sehen, oder als zentrale Datenquelle
für mehrere Tools), sieht in [shelly-virtual-pv-emulator.md](shelly-virtual-pv-emulator.md).
