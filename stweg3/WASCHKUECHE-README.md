# Smart Waschküchen-System für STWEG 3

## 📋 Übersicht

Das Smart Waschküchen-System ist eine **vollständig statische Lösung** für die STWEG 3 in Rosenweg 9, Kaiseraugst. Es verwendet:

- ✅ **JSON-Dateien** für Datenspeicherung (keine Datenbank erforderlich)
- ✅ **N8N-Webhook** für OTP-E-Mail-Versand (`https://n8n.juroct.net/webhook/stweg3-otp`)
- ✅ **GitHub Actions** für Daten-Updates (optional)
- ✅ **Shelly Pro 1 PM** für Energiemessung
- ✅ **Rollen-basierter Zugriff** (Bewohner & Ausschuss)

## 📁 Dateistruktur

```
stweg3/
├── waschkueche.html              # Hauptseite mit OTP-Auth
├── waschkueche-api.js            # API-Client für JSON-Dateien + N8N
├── waschkueche-management.html   # Terminal-Interface (USB-Auth)
├── waschkueche-management-info.html  # Dokumentation
└── waschkueche-data/             # JSON-Datenbank
    ├── users.json                # Benutzer & Guthaben
    ├── devices.json              # Shelly-Geräte
    ├── sessions.json             # Nutzungs-Sessions
    └── transactions.json         # Transaktionen

.github/workflows/
└── waschkueche-update.yml        # Daten-Updates (Balance, Sessions)
```

## 🚀 Setup & Installation

### 1. N8N-Webhook (OTP-Versand)

Der OTP-Versand erfolgt über einen **bereits konfigurierten N8N-Webhook**:

```javascript
N8N_WEBHOOK_URL: 'https://n8n.juroct.net/webhook/stweg3-otp'
```

**Request Format:**
```json
{
  "email": "user@example.com",
  "otp": "123456",
  "timestamp": "2025-01-20T10:30:00Z"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP sent to user@example.com"
}
```

✅ **Keine weitere Konfiguration erforderlich** - der Webhook ist bereits aktiv und wird von anderen STWEG3-Seiten (Kontaktliste, Admin) genutzt!

### 2. Shelly Pro 1 PM Geräte konfigurieren

1. **Geräte im WLAN verbinden**
   ```
   Waschmaschine 1: 192.168.1.100
   Trockner 1:      192.168.1.101
   Waschmaschine 2: 192.168.1.102
   Trockner 2:      192.168.1.103
   ```

2. **IPs in `devices.json` anpassen**:
   ```json
   {
     "devices": [
       {
         "id": 1,
         "device_id": "shellypro1pm-waschmaschine1",
         "device_name": "Waschmaschine 1",
         "shelly_ip": "192.168.1.100",
         ...
       }
     ]
   }
   ```

3. **Shelly Geräte-IDs ermitteln**:
   ```bash
   curl http://192.168.1.100/rpc/Shelly.GetDeviceInfo
   ```

### 3. Benutzer-E-Mails konfigurieren

Bearbeite `waschkueche-api.js`:

```javascript
// Bewohner (nur eigene Daten sehen)
USER_EMAILS: [
    'max.mustermann@example.com',
    'anna.schmidt@example.com',
    ...
],

// Ausschuss (Admin-Zugriff)
ADMIN_EMAILS: [
    'stefan+rosenweg@juroct.ch',
    'fersztand.basil@teleport.ch',
    'hello@langpartners.ch'
]
```

Aktualisiere auch `users.json` mit den echten E-Mail-Adressen:

```json
{
  "users": [
    {
      "id": 1,
      "wohnung": "EG.1",
      "name": "Max Mustermann",
      "email": "max.mustermann@example.com",
      "balance": 50.00,
      ...
    }
  ]
}
```

## 🔐 Authentifizierung & Zugriff

### OTP-Ablauf (mit N8N)

1. **Benutzer gibt E-Mail ein** → Frontend validiert gegen Whitelist
2. **OTP wird generiert** (6-stellig) und an N8N-Webhook gesendet
3. **N8N sendet E-Mail** mit OTP-Code
4. **Benutzer gibt OTP ein** → Frontend validiert (10 Min. Gültigkeit)
5. **Session wird erstellt** → Dashboard wird geladen

### Berechtigungsstufen

#### 📊 Bewohner (USER_EMAILS)
- Eigenes Guthaben anzeigen
- Eigene Sessions anzeigen
- Eigene Transaktionen anzeigen
- Eigene Statistiken

#### 🔧 Ausschuss (ADMIN_EMAILS)
- **Alle** Benutzer verwalten
- **Alle** Sessions anzeigen
- Guthaben aufladen
- Geräte-Einstellungen
- CSV-Export für Abrechnung
- System-Konfiguration

## 💾 Daten-Management

### JSON-Dateien manuell bearbeiten

Die einfachste Methode für Daten-Updates:

```bash
# Guthaben aufladen
vim stweg3/waschkueche-data/users.json
# balance von User 1 ändern: 50.00 → 100.00

# Transaction hinzufügen
vim stweg3/waschkueche-data/transactions.json
# Neuen Eintrag hinzufügen

# Committen
git add stweg3/waschkueche-data/*.json
git commit -m "💰 Guthaben aufgeladen für User 1"
git push
```

### GitHub Actions für automatische Updates (optional)

Falls automatische Daten-Updates gewünscht:

```bash
# GitHub UI: Actions > Waschküche Data Update > Run workflow
# Inputs:
# - action: add_balance
# - user_id: 1
# - amount: 50.00
```

## 🔌 Shelly API Integration

### Live-Status abrufen

```javascript
const API = WaschkuecheAPI;
const status = await API.getShellyStatus('192.168.1.100');

console.log(status);
// {
//   apower: 1250,        // Aktuelle Leistung in Watt
//   voltage: 230.5,      // Spannung in Volt
//   current: 5.43,       // Strom in Ampere
//   output: true,        // Gerät läuft
//   aenergy: {
//     total: 1250        // Gesamtenergie in Wh
//   }
// }
```

### Gerät ein/ausschalten

```javascript
// Einschalten
await API.setShellySwitch('192.168.1.100', true);

// Ausschalten
await API.setShellySwitch('192.168.1.100', false);
```

### Energiemessung

```javascript
const energy = await API.getShellyEnergy('192.168.1.100');

console.log(energy);
// {
//   power: 1250,           // W
//   voltage: 230.5,        // V
//   current: 5.43,         // A
//   totalEnergy: 1.25,     // kWh
//   isOn: true
// }
```

## 📊 Typischer Ablauf: Wäsche waschen

### 1. Benutzer startet Session (via Terminal)

- USB-Stick einstecken
- Gerät auswählen
- Session wird in `sessions.json` erstellt
- Shelly-Gerät wird eingeschaltet

### 2. Wäsche läuft

- Shelly misst Energieverbrauch
- Frontend zeigt Live-Daten (optional)

### 3. Benutzer beendet Session

- Session wird geschlossen
- Energieverbrauch wird abgelesen (z.B. 1.25 kWh)
- Kosten werden berechnet (1.25 × CHF 0.30 = CHF 0.38)
- Guthaben wird reduziert
- Transaktion wird gespeichert
- Shelly-Gerät wird ausgeschaltet

## 🧪 Lokaler Test

1. **Static File Server starten**:
   ```bash
   cd /path/to/Website/stweg3
   python3 -m http.server 8000
   ```

2. **Browser öffnen**:
   ```
   http://localhost:8000/waschkueche.html
   ```

3. **E-Mail eingeben und OTP anfordern**
   - OTP wird an deine echte E-Mail gesendet
   - Code eingeben und Dashboard testen

### Shelly-Geräte testen

```bash
# Status abrufen
curl http://192.168.1.100/rpc/Switch.GetStatus?id=0

# Einschalten
curl "http://192.168.1.100/rpc/Switch.Set?id=0&on=true"

# Ausschalten
curl "http://192.168.1.100/rpc/Switch.Set?id=0&on=false"

# Energie-Counter zurücksetzen
curl "http://192.168.1.100/rpc/Switch.ResetCounters?id=0"
```

## 📈 Abrechnungen & Reports

### CSV-Export

**Admin-Dashboard** > **Tab: Alle Sessions** > **📥 CSV Export**

Exportiert alle Sessions mit:
- Datum & Zeit
- Benutzer (Name, Wohnung)
- Gerät
- Energie (kWh)
- Kosten (CHF)

### Monatliche Abrechnung

1. **Sessions für Monat filtern** (im JSON oder via Export)
2. **Pro Benutzer summieren**
3. **Abrechnung erstellen** (wird automatisch vom Guthaben abgezogen)

## 🔐 Sicherheit

### Aktuelle Implementation

✅ **OTP via N8N**:
- 6-stellige Codes
- 10 Minuten Gültigkeit
- Einmalverwendung

✅ **E-Mail-Whitelist**:
- Nur bekannte E-Mails erlaubt
- Getrennte Listen (User / Admin)

✅ **Shelly API**:
- Nur im lokalen Netzwerk erreichbar
- Keine Cloud-Verbindung erforderlich

## 🐛 Troubleshooting

### Problem: OTP-E-Mail kommt nicht an

**Lösung**:
1. Prüfe Spam-Ordner
2. Prüfe N8N-Webhook-Status (frage Admin)
3. Teste Webhook manuell:
   ```bash
   curl -X POST https://n8n.juroct.net/webhook/stweg3-otp \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","otp":"123456","timestamp":"2025-01-20T10:00:00Z"}'
   ```

### Problem: Shelly-Gerät nicht erreichbar

**Lösung**:
1. Prüfe IP-Adresse:
   ```bash
   ping 192.168.1.100
   ```
2. Prüfe Shelly-App (ist Gerät online?)
3. Prüfe WLAN-Verbindung
4. Firewall-Regeln prüfen

### Problem: JSON-Daten nicht sichtbar

**Lösung**:
- Browser-Cache leeren (Strg+Shift+R)
- Datei-Pfad prüfen (`waschkueche-data/users.json`)
- CORS-Fehler in Browser-Console prüfen

## 📞 Support

Bei Fragen:
- **Ausschuss STWEG 3**: stefan+rosenweg@juroct.ch
- **Hausverwaltung**: hello@langpartners.ch
- **Technischer Support N8N**: stefan@juroct.net

## 📝 Changelog

### v2.0.0 (2025-01-20) - **Aktuell**
- ✅ **N8N-Webhook Integration** statt GitHub Actions für OTP
- ✅ JSON-basierte Datenspeicherung
- ✅ Shelly Pro 1 PM Integration
- ✅ Rollen-basierter Zugriff
- ✅ Adaptive Dashboards

### Geplant (v2.1.0)
- 🔄 Automatische Session-Timeouts
- 🔄 Push-Benachrichtigungen
- 🔄 Mobile App (PWA)
- 🔄 Energieverbrauch-Charts

---

**STWEG 3 - Rosenweg 9, Kaiseraugst** | Smart Waschküchen-System | © 2025
