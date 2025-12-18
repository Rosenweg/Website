# Energie-Monitor System

Dynamisches Energie-Monitoring-System für die STWEG-Kooperation Rosenweg mit Live-Verbrauchsdaten, Tarifaufschlüsselung und Solarintegration.

## 🚀 Features

- **Live-Verbrauch**: Echtzeit-Daten von ioBroker via Modbus
- **Historische Auswertungen**: Tag, Woche, Monat
- **Tarifaufschlüsselung**: Hoch-/Niedertarif mit Zeitsteuerung
- **Solar-Integration**: Eigenverbrauch, Einspeisung, Autarkie
- **OTP-Authentifizierung**: Sicherer Login via E-Mail
- **Auto-Benutzer-Erstellung**: Automatisches Anlegen von Benutzern aus STWEG-Kontaktlisten
- **Multi-Zähler**: Haupt-, Solar- und Unterzähler (Shellys)
- **Shelly-Support**: Alle STWEGs können Shelly-Geräte überwachen
- **Dynamische Konfiguration**: Vollständig via JSON konfigurierbar

## 📁 Dateistruktur

```
Website/
├── energie-monitor.html          # Haupt-Dashboard
├── zaehler.html                  # Zähler-Übersichtsseite (Root)
├── zaehler-config.json           # Hauptkonfiguration
├── zaehler-daten/                # Historische Zählerdaten
│   ├── 2024-12-18_main_stweg3_whg1.json
│   └── 2024-12-18_main_stweg3_whg5.json
└── stweg3/
    └── pages/
        └── zaehler.html          # STWEG3-spezifische Zählerseite
```

## ⚙️ Konfiguration

### zaehler-config.json

Zentrale Konfigurationsdatei mit:

#### 1. **Tarife**
```json
{
  "tarife": {
    "hochtarif": {
      "preis_pro_kwh": 0.2516,
      "zeiten": [
        {"wochentage": [1,2,3,4,5], "von": "07:00", "bis": "20:00"},
        {"wochentage": [6], "von": "07:00", "bis": "13:00"}
      ]
    },
    "niedertarif": {
      "preis_pro_kwh": 0.1789
    },
    "solar": {
      "preis_pro_kwh": 0.10
    }
  }
}
```

**Wochentage**: 1 = Montag, 6 = Samstag, 7 = Sonntag

#### 2. **ioBroker Integration**
```json
{
  "iobroker": {
    "base_url": "http://iobroker.local:8087",
    "update_intervall_sekunden": 5
  }
}
```

#### 3. **Benutzer & Zähler**
```json
{
  "benutzer": [
    {
      "email": "beispiel@rosenweg4303.ch",
      "name": "Max Mustermann",
      "wohnung": "Rosenweg 9, Whg 1",
      "stweg": 3,
      "zaehler": [
        {
          "id": "main_stweg3_whg1",
          "typ": "hauptzaehler",
          "iobroker_id": "modbus.0.meter_stweg3_whg1",
          "hat_solar": false
        }
      ]
    }
  ]
}
```

#### Zählertypen:
- **hauptzaehler**: Hauptstromzähler der Wohnung
- **solarzaehler**: PV-Anlage (Erzeugung)
- **unterzaehler**: Shelly-Geräte, etc.

#### Zähler-Beziehungen:
```json
{
  "id": "solar_stweg3_whg5",
  "typ": "solarzaehler",
  "parent_zaehler": "main_stweg3_whg5"
}
```

## 📊 Datenformat

### Historische Daten (Tag)

Dateiname: `YYYY-MM-DD_zaehler-id.json`

```json
{
  "zaehler_id": "main_stweg3_whg1",
  "datum": "2024-12-18",
  "verbrauch_gesamt": 8.3,
  "verbrauch_nach_tarif": {
    "hochtarif_kwh": 5.2,
    "hochtarif_kosten": 1.31,
    "niedertarif_kwh": 3.1,
    "niedertarif_kosten": 0.55,
    "gesamt_kosten": 1.86
  },
  "stundenwerte": [
    {
      "timestamp": "2024-12-18T12:00:00Z",
      "zaehlerstand": 15239.2,
      "verbrauch_kwh": 0.8,
      "leistung_w": 1200,
      "tarif": "hochtarif"
    }
  ]
}
```

### Solar-Daten

```json
{
  "solar_erzeugung_gesamt": 12.4,
  "solar_eigenverbrauch": 8.2,
  "solar_einspeisung": 4.2,
  "netz_bezug": 1.4,
  "verbrauch_nach_tarif": {
    "solar_kwh": 8.2,
    "solar_kosten": 0.82,
    "hochtarif_kwh": 0.9,
    "hochtarif_kosten": 0.23,
    "einsparung_durch_solar": 1.45
  },
  "statistik": {
    "autarkie_prozent": 85.4,
    "eigenverbrauch_quote_prozent": 66.1
  }
}
```

**Berechnung Eigenverbrauch**: `Solar-Erzeugung - Einspeisung = Eigenverbrauch`

## 🔌 ioBroker Integration

### Modbus-Zähler Setup

1. **ioBroker Modbus-Adapter** installieren
2. Zähler konfigurieren mit eindeutigen IDs
3. IDs in `zaehler-config.json` eintragen

### Live-Daten Abruf

Das Dashboard ruft alle 5 Sekunden Daten ab:

```javascript
// Beispiel ioBroker State
modbus.0.meter_stweg3_whg1.power     // Aktuelle Leistung (W)
modbus.0.meter_stweg3_whg1.energy    // Zählerstand (kWh)
```

### n8n Workflow für Datenspeicherung

Der ioBroker kann Zählerdaten via Webhook an n8n senden:

```bash
POST https://n8n.juroct.net/webhook/zaehler-daten-speichern
{
  "zaehler_id": "main_stweg3_whg1",
  "timestamp": "2024-12-18T15:30:00Z",
  "zaehlerstand": 15240.5,
  "leistung_w": 850
}
```

n8n Workflow:
1. Daten empfangen
2. Tarif berechnen (Hoch/Niedertarif basierend auf Zeitstempel)
3. In Tages-JSON aggregieren
4. Auf GitHub speichern

## 🔐 Authentifizierung

### OTP-System (Nutzt generischen Email-Webhook!)

1. Benutzer gibt E-Mail ein
2. **Automatische Benutzer-Erstellung**:
   - Wenn E-Mail nicht in `zaehler-config.json` vorhanden
   - System durchsucht alle STWEG `kontakte.json` Dateien
   - Bei Fund: Automatische Erstellung via n8n Webhook
   - Benutzer wird mit leerem Zähler-Array angelegt
   - Flag `needs_meter_assignment: true` gesetzt
   - Zählerzuordnung erfolgt durch Technik-Team
3. System generiert 6-stelligen Code (client-side)
4. Code wird via **generischen Email-Webhook** versendet
5. Code wird im LocalStorage gespeichert (10 Min gültig)
6. Benutzer gibt Code ein
7. System prüft Code aus LocalStorage
8. Session für 1 Stunde gültig

**Vorteil**: Nutzt den bereits existierenden generischen Email-Webhook, kein separater OTP-Workflow nötig!

### Auto-Benutzer-Erstellung

Wenn eine E-Mail nicht in `zaehler-config.json` vorhanden ist:
1. System sucht in allen STWEG `kontakte.json` Dateien (STWEG 1-8)
2. Durchsucht:
   - `verteilerlisten` (alle, bewohner, eigentuemer)
   - `wohnungen` (eigentümer und mieter)
3. Bei Fund: n8n Webhook erstellt Benutzer-Eintrag
4. Zählerzuordnung muss durch Technik-Team erfolgen
5. Benutzer erhält sofort OTP-Code und kann sich anmelden

### Email-Versand

Das System nutzt den **generischen Email-Webhook** (`/webhook/send-email`):

```javascript
fetch('https://n8n.juroct.net/webhook/send-email', {
  method: 'POST',
  body: JSON.stringify({
    recipients: ['user@example.com'],
    subject: 'Ihr Login-Code für den Energie-Monitor',
    htmlContent: '<html>...</html>',
    fromEmail: 'noreply@rosenweg4303.ch'
  })
})
```

## 📈 Dashboard Features

### Live-Bereich
- Aktuelle Leistung (W)
- Aktueller Tarif
- Heute Verbrauch & Kosten
- Solar Live-Daten (wenn vorhanden)

### Charts
- **Verbrauchsverlauf**: Linienchart mit kWh pro Stunde
- **Tarifaufteilung**: Donut-Chart (Hoch/Niedrig/Solar)

### Statistik-Tabelle
- Verbrauch pro Tarif
- Kosten pro Tarif
- Gesamtkosten

### Solar-Spezial (bei PV-Anlagen)
- Erzeugung
- Eigenverbrauch
- Einspeisung
- Autarkiegrad
- Eigenverbrauchsquote

## 🛠️ Entwicklung

### Neue Wohnung hinzufügen

1. In `zaehler-config.json` unter `benutzer` eintragen:
```json
{
  "email": "neue-wohnung@rosenweg4303.ch",
  "name": "Familie Neu",
  "wohnung": "Rosenweg 9, Whg 7",
  "stweg": 3,
  "zaehler": [
    {
      "id": "main_stweg3_whg7",
      "typ": "hauptzaehler",
      "iobroker_id": "modbus.0.meter_stweg3_whg7",
      "hat_solar": false,
      "aktiv": true
    }
  ]
}
```

2. ioBroker Modbus-Zähler mit ID `modbus.0.meter_stweg3_whg7` einrichten

3. Fertig! Dashboard zeigt automatisch die richtigen Daten an.

### Solar-Anlage hinzufügen

```json
{
  "zaehler": [
    {
      "id": "main_stweg3_whg7",
      "typ": "hauptzaehler",
      "hat_solar": true,
      "solar_zaehler_id": "solar_stweg3_whg7"
    },
    {
      "id": "solar_stweg3_whg7",
      "typ": "solarzaehler",
      "iobroker_id": "modbus.0.solar_stweg3_whg7",
      "parent_zaehler": "main_stweg3_whg7",
      "leistung_kwp": 8.5
    }
  ]
}
```

### Shelly-Unterzähler hinzufügen

```json
{
  "id": "sub_stweg3_whg7_wasch",
  "typ": "unterzaehler",
  "name": "Waschmaschine",
  "iobroker_id": "shelly.0.SHELLY123456",
  "parent_zaehler": "main_stweg3_whg7",
  "geraetetyp": "shelly"
}
```

## 🎨 Anpassungen

### Tarifpreise ändern

In `zaehler-config.json`:
```json
"hochtarif": {
  "preis_pro_kwh": 0.2516  // CHF pro kWh
}
```

### Tarifzeiten ändern

```json
"zeiten": [
  {
    "wochentage": [1,2,3,4,5],  // Mo-Fr
    "von": "07:00",
    "bis": "20:00"
  }
]
```

### Update-Intervall ändern

```json
"iobroker": {
  "update_intervall_sekunden": 10  // Statt 5 Sekunden
}
```

## 🔍 Troubleshooting

### Keine Daten werden angezeigt
1. Prüfe `zaehler-daten/` Verzeichnis - existiert eine Datei für heute?
2. Prüfe ioBroker - sind die Zähler-IDs korrekt?
3. Browser-Konsole öffnen (F12) - Fehlermeldungen?

### OTP kommt nicht an
1. E-Mail in `zaehler-config.json` vorhanden?
2. n8n Webhook erreichbar?
3. Spam-Ordner prüfen

### Solar-Daten falsch
1. `eigenverbrauch = erzeugung - einspeisung` korrekt berechnet?
2. Beide Zähler (Solar + Netz) richtig verknüpft?
3. `parent_zaehler` korrekt gesetzt?

## 📝 TODO / Roadmap

- [ ] Wochenansicht implementieren
- [ ] Monatsansicht implementieren
- [ ] Export als CSV/PDF
- [ ] Push-Benachrichtigungen bei hohem Verbrauch
- [ ] Vergleich mit Vorperiode
- [ ] Prognose für Monatsende
- [ ] Admin-Ansicht (alle Wohnungen)
- [ ] API für externe Systeme

## 📄 Lizenz

© 2024 STWEG-Kooperation Rosenweg

Internes System für die Bewohner der STWEGs am Rosenweg, Kaiseraugst.
