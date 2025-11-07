# Smart Waschküchen-System für STWEG 3

## 📋 Übersicht

Das Smart Waschküchen-System ist eine **vollständig statische Lösung** für die STWEG 3 in Rosenweg 9, Kaiseraugst. Es verwendet:

- ✅ **JSON-Dateien** für Datenspeicherung (keine Datenbank)
- ✅ **GitHub Actions** für Backend-Operationen (kein Node.js-Server)
- ✅ **Shelly Pro 1 PM** für Energiemessung
- ✅ **OTP-Authentifizierung** per E-Mail
- ✅ **Rollen-basierter Zugriff** (Bewohner & Ausschuss)

## 📁 Dateistruktur

```
stweg3/
├── waschkueche.html              # Hauptseite mit OTP-Auth
├── waschkueche-api.js            # API-Client für JSON-Dateien
├── waschkueche-management.html   # Terminal-Interface (USB-Auth)
├── waschkueche-management-info.html  # Dokumentation
└── waschkueche-data/             # JSON-Datenbank
    ├── users.json                # Benutzer & Guthaben
    ├── devices.json              # Shelly-Geräte
    ├── sessions.json             # Nutzungs-Sessions
    ├── transactions.json         # Transaktionen
    └── otp.json                  # OTP-Codes (temporär)

.github/workflows/
├── waschkueche-otp.yml           # OTP-E-Mail-Versand
└── waschkueche-update.yml        # Daten-Updates (Balance, Sessions)
```

## 🚀 Setup & Installation

### 1. GitHub Secrets konfigurieren

Füge folgende Secrets in deinem GitHub Repository hinzu (`Settings > Secrets and variables > Actions`):

```
SMTP_SERVER=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=your-email@gmail.com
SMTP_PASSWORD=your-app-password
SMTP_FROM=noreply@stweg3.ch
```

**Für Gmail:**
1. Aktiviere 2-Faktor-Authentifizierung
2. Erstelle ein App-Passwort: https://myaccount.google.com/apppasswords
3. Verwende dieses als `SMTP_PASSWORD`

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
    'bewohner1@example.com',
    'bewohner2@example.com',
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

### OTP-Authentifizierung

1. **Benutzer gibt E-Mail ein**
2. **System prüft Berechtigung** (USER_EMAILS oder ADMIN_EMAILS)
3. **GitHub Action sendet OTP** (6-stelliger Code per E-Mail)
4. **Benutzer gibt OTP ein**
5. **System validiert** und zeigt entsprechendes Dashboard

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

### GitHub Actions Workflows

#### 1. OTP-E-Mail senden

**Manueller Trigger** (für Tests):

```bash
# GitHub UI: Actions > Waschküche OTP Email > Run workflow
# Inputs:
# - email: max.mustermann@example.com
# - otp_code: 123456
```

**Automatisch** (vom Frontend):

```javascript
// GitHub API
POST https://api.github.com/repos/{owner}/{repo}/actions/workflows/waschkueche-otp.yml/dispatches
Headers:
  Authorization: Bearer <GITHUB_TOKEN>
  Accept: application/vnd.github+json
Body:
  {
    "ref": "main",
    "inputs": {
      "email": "user@example.com",
      "otp_code": "123456"
    }
  }
```

#### 2. Guthaben aufladen

```bash
# GitHub UI: Actions > Waschküche Data Update > Run workflow
# Inputs:
# - action: add_balance
# - user_id: 1
# - amount: 50.00
```

Aktualisiert automatisch:
- `users.json` (balance += amount)
- `transactions.json` (neuer Eintrag)

#### 3. Session starten

```bash
# Inputs:
# - action: start_session
# - user_id: 1
# - device_id: 1
```

Aktualisiert:
- `sessions.json` (neue Session)
- `devices.json` (is_available = false)

#### 4. Session beenden

```bash
# Inputs:
# - action: end_session
# - session_id: 5
# - energy_consumed: 1.25
```

Aktualisiert:
- `sessions.json` (ended_at, energy_consumed, cost)
- `users.json` (balance -= cost)
- `transactions.json` (neuer Eintrag)
- `devices.json` (is_available = true)

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

### 1. Benutzer startet Session (via Terminal oder App)

```javascript
// Frontend ruft GitHub Action auf
triggerWorkflow({
  action: 'start_session',
  user_id: 1,
  device_id: 1
});
```

GitHub Action:
- Erstellt neue Session in `sessions.json`
- Setzt Device auf `is_available: false`
- Returned `session_id`

### 2. Shelly-Gerät einschalten

```javascript
// Frontend schaltet Gerät ein
await API.setShellySwitch('192.168.1.100', true);

// Optional: Energiezähler zurücksetzen
await fetch('http://192.168.1.100/rpc/Switch.ResetCounters?id=0');
```

### 3. Benutzer beendet Session

```javascript
// Energieverbrauch abfragen
const energy = await API.getShellyEnergy('192.168.1.100');

// Session beenden
triggerWorkflow({
  action: 'end_session',
  session_id: session_id,
  energy_consumed: energy.totalEnergy
});
```

GitHub Action:
- Berechnet Kosten: `cost = energy * 0.30 CHF/kWh`
- Aktualisiert Session (ended_at, energy, cost)
- Zieht Kosten von Guthaben ab
- Erstellt Transaktion
- Setzt Device auf `is_available: true`

### 4. Gerät ausschalten

```javascript
await API.setShellySwitch('192.168.1.100', false);
```

## 🧪 Demo-Modus

Das System läuft im **Demo-Modus** wenn:
- Keine GitHub Token konfiguriert ist
- Kein SMTP-Server eingerichtet ist
- Man lokal entwickelt

### Demo-Features:

1. **OTP im localStorage** statt E-Mail
   ```javascript
   localStorage.getItem('demo_otp_' + email)
   ```

2. **Alert statt E-Mail**
   ```javascript
   alert(`Ihr OTP-Code: ${otpCode}`);
   ```

3. **Keine echten Workflow-Triggers**
   - Daten werden nur im Browser geladen
   - Änderungen werden nicht gespeichert

### Produktions-Modus aktivieren:

1. GitHub Token als Secret hinzufügen:
   ```
   WASCHKUECHE_GITHUB_TOKEN=ghp_xxxxxxxxxxxxx
   ```

2. Token im Frontend verwenden:
   ```javascript
   const GITHUB_TOKEN = '<%= ENV.WASCHKUECHE_GITHUB_TOKEN %>';
   ```

3. Workflow-Dispatch aktivieren im Frontend

## 📱 Zugriffswege

### 1. Web-Dashboard (waschkueche.html)
- **URL**: `https://yoursite.ch/stweg3/waschkueche.html`
- **Auth**: OTP per E-Mail
- **Für**: Bewohner & Ausschuss
- **Features**: Verbrauchsanzeige, Statistiken, Admin-Panel

### 2. Terminal-Interface (waschkueche-management.html)
- **URL**: `https://yoursite.ch/stweg3/waschkueche-management.html`
- **Auth**: USB-Stick / Yubikey
- **Für**: Vor-Ort-Nutzung
- **Features**: Session start/stop, Live-Monitoring

### 3. Dokumentation (waschkueche-management-info.html)
- **URL**: `https://yoursite.ch/stweg3/waschkueche-management-info.html`
- **Auth**: Keine
- **Für**: Alle
- **Features**: Hilfe, FAQ, Anleitungen

## 🔧 Entwicklung & Testing

### Lokaler Test

1. **Static File Server starten**:
   ```bash
   cd /path/to/Website/stweg3
   python3 -m http.server 8000
   ```

2. **Browser öffnen**:
   ```
   http://localhost:8000/waschkueche.html
   ```

3. **OTP-Code aus Alert kopieren**

4. **Daten testen**:
   - Bearbeite JSON-Dateien manuell
   - Lade Seite neu (F5)

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

1. **Sessions für Monat exportieren**
2. **Pro Benutzer summieren**:
   ```
   Max Mustermann (EG.1):
   - 5 Sessions
   - 6.25 kWh
   - CHF 1.88
   ```

3. **Von Guthaben abziehen** (automatisch bei Session-Ende)

## 🔐 Sicherheit

### Best Practices

✅ **OTP-Codes**:
- 6-stellig (100.000 Kombinationen)
- 10 Minuten Gültigkeit
- Einmalverwendung

✅ **E-Mail-Whitelist**:
- Nur bekannte E-Mails erlaubt
- Getrennte Listen (User / Admin)

✅ **GitHub Secrets**:
- SMTP-Credentials sicher gespeichert
- Nur GitHub Actions hat Zugriff

✅ **CORS**:
- Shelly-API nur im lokalen Netzwerk erreichbar
- Alternativ: Shelly Cloud API nutzen

### Noch zu implementieren

⚠️ **Session-Timeout**:
```javascript
// Nach 24h abmelden
if (sessionAge > 24 * 60 * 60 * 1000) {
  API.logout();
}
```

⚠️ **Rate-Limiting**:
```javascript
// Max 3 OTP-Anfragen pro Stunde
const attempts = getOTPAttempts(email);
if (attempts >= 3) {
  throw new Error('Zu viele Anfragen');
}
```

⚠️ **Audit-Log**:
```json
{
  "logs": [
    {
      "timestamp": "2025-01-20T10:30:00Z",
      "action": "login",
      "user": "max.mustermann@example.com",
      "ip": "192.168.1.50"
    }
  ]
}
```

## 🐛 Troubleshooting

### Problem: OTP-E-Mail kommt nicht an

**Lösung**:
1. Prüfe Spam-Ordner
2. Prüfe SMTP-Settings in GitHub Secrets
3. Teste SMTP-Verbindung:
   ```bash
   telnet smtp.gmail.com 587
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

### Problem: Daten werden nicht gespeichert

**Lösung**:
- **Lokal**: Normal - Demo-Modus speichert nicht
- **Produktion**: Prüfe GitHub Actions Status
  - `Actions` Tab im Repository
  - Workflow-Logs ansehen
  - Permissions prüfen

### Problem: "Permission denied" bei Workflow

**Lösung**:
```yaml
# In .github/workflows/*.yml
jobs:
  update-data:
    permissions:
      contents: write  # <-- Dies hinzufügen
```

## 📞 Support

Bei Fragen:
- **Ausschuss STWEG 3**: stefan+rosenweg@juroct.ch
- **Hausverwaltung**: hello@langpartners.ch
- **Technischer Support**: [GitHub Issues](https://github.com/your-repo/issues)

## 📝 Changelog

### v1.0.0 (2025-01-20)
- ✅ JSON-basierte Datenspeicherung
- ✅ GitHub Actions für Backend
- ✅ OTP-Authentifizierung
- ✅ Shelly Pro 1 PM Integration
- ✅ Rollen-basierter Zugriff
- ✅ Demo-Modus für lokale Entwicklung

### Geplant (v1.1.0)
- 🔄 GitHub API Integration (Workflow Dispatch vom Frontend)
- 🔄 Automatische Session-Timeouts
- 🔄 Push-Benachrichtigungen
- 🔄 Mobile App (PWA)

---

**STWEG 3 - Rosenweg 9, Kaiseraugst** | Smart Waschküchen-System | © 2025
