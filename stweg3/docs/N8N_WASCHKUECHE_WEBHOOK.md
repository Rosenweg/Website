# N8N Webhook für Waschküchen-Geräte-Verwaltung

## 🎯 Zweck

Automatisches Hinzufügen/Bearbeiten von Geräten in `waschkueche-data/devices.json` via N8N-Webhook.

## 📡 Webhook-Endpunkt

Analog zum OTP-Webhook sollte der Endpunkt sein:
```
https://n8n.juroct.net/webhook/stweg3-waschkueche-device
```

## 📥 Request Format

### Gerät hinzufügen

```json
POST https://n8n.juroct.net/webhook/stweg3-waschkueche-device

{
  "action": "add",
  "device_name": "Waschmaschine 3",
  "device_type": "washer",
  "location": "Waschküche 2",
  "shelly_ip": "192.168.1.104",
  "cost_per_kwh": 0.30,
  "requester_email": "stefan+rosenweg@juroct.ch"
}
```

### Gerät bearbeiten

```json
POST https://n8n.juroct.net/webhook/stweg3-waschkueche-device

{
  "action": "update",
  "device_id": 1,
  "updates": {
    "shelly_ip": "192.168.1.105",
    "cost_per_kwh": 0.35
  },
  "requester_email": "stefan+rosenweg@juroct.ch"
}
```

### Gerät löschen

```json
POST https://n8n.juroct.net/webhook/stweg3-waschkueche-device

{
  "action": "delete",
  "device_id": 3,
  "requester_email": "stefan+rosenweg@juroct.ch"
}
```

## 📤 Response Format

```json
{
  "success": true,
  "message": "Gerät 'Waschmaschine 3' erfolgreich hinzugefügt",
  "device": {
    "id": 5,
    "device_name": "Waschmaschine 3",
    "device_id": "shellypro1pm-waschmaschine3",
    "shelly_ip": "192.168.1.104"
  }
}
```

## 🔧 N8N Workflow-Logik

### 1. Webhook Trigger
- Empfängt POST-Request mit JSON-Body
- Validiert `requester_email` gegen Admin-Liste

### 2. Action-Switch (basierend auf `action`)

#### Bei `action: "add"`:
1. **Clone GitHub Repository**
   ```bash
   git clone https://github.com/Rosenweg/Website.git
   cd Website
   ```

2. **Lade devices.json**
   ```bash
   cat stweg3/waschkueche-data/devices.json
   ```

3. **Generiere neue Device ID**
   ```javascript
   const devices = JSON.parse(devicesJson);
   const newId = Math.max(...devices.devices.map(d => d.id)) + 1;
   ```

4. **Erstelle neues Gerät**
   ```javascript
   const newDevice = {
     id: newId,
     device_id: `shellypro1pm-${device_name.toLowerCase().replace(/\s/g, '')}`,
     device_name: device_name,
     device_type: device_type,
     location: location,
     shelly_ip: shelly_ip,
     cost_per_kwh: cost_per_kwh,
     is_available: true
   };

   devices.devices.push(newDevice);
   ```

5. **Schreibe devices.json**
   ```bash
   echo '$JSON' > stweg3/waschkueche-data/devices.json
   ```

6. **Commit & Push**
   ```bash
   git config user.name "N8N Automation"
   git config user.email "automation@stweg3.ch"
   git add stweg3/waschkueche-data/devices.json
   git commit -m "🔧 Gerät hinzugefügt: ${device_name}"
   git push origin main
   ```

#### Bei `action: "update"`:
1. Clone Repository
2. Lade devices.json
3. Finde Gerät mit `device_id`
4. Update Felder aus `updates` Object
5. Schreibe zurück
6. Commit & Push

#### Bei `action: "delete"`:
1. Clone Repository
2. Lade devices.json
3. Filtere Gerät mit `device_id` raus
4. Schreibe zurück
5. Commit & Push

### 3. Response senden
```json
{
  "success": true,
  "message": "...",
  "device": { ... }
}
```

## 🔐 Sicherheit

### Berechtigungsprüfung

```javascript
const ADMIN_EMAILS = [
  'stefan+rosenweg@juroct.ch',
  'fersztand.basil@teleport.ch',
  'hello@langpartners.ch'
];

if (!ADMIN_EMAILS.includes(requester_email)) {
  return {
    success: false,
    error: "Keine Berechtigung. Nur Ausschuss-Mitglieder können Geräte verwalten."
  };
}
```

### Validierung

```javascript
// Für "add"
if (!device_name || !device_type || !location || !shelly_ip) {
  return { success: false, error: "Pflichtfelder fehlen" };
}

// IP-Format prüfen
if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(shelly_ip)) {
  return { success: false, error: "Ungültige IP-Adresse" };
}

// Device Type prüfen
if (!['washer', 'dryer'].includes(device_type)) {
  return { success: false, error: "device_type muss 'washer' oder 'dryer' sein" };
}
```

## 🧪 Test-Requests

### cURL Test (Gerät hinzufügen)

```bash
curl -X POST https://n8n.juroct.net/webhook/stweg3-waschkueche-device \
  -H "Content-Type: application/json" \
  -d '{
    "action": "add",
    "device_name": "Test Waschmaschine",
    "device_type": "washer",
    "location": "Waschküche Test",
    "shelly_ip": "192.168.1.200",
    "cost_per_kwh": 0.30,
    "requester_email": "stefan+rosenweg@juroct.ch"
  }'
```

### JavaScript Test (aus Frontend)

```javascript
const response = await fetch('https://n8n.juroct.net/webhook/stweg3-waschkueche-device', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'add',
    device_name: 'Waschmaschine 3',
    device_type: 'washer',
    location: 'Waschküche 2',
    shelly_ip: '192.168.1.104',
    cost_per_kwh: 0.30,
    requester_email: currentUser.email
  })
});

const result = await response.json();
console.log(result);
```

## 📊 Workflow-Diagramm

```
Frontend (waschkueche.html)
    ↓ POST request
N8N Webhook
    ↓
Berechtigung prüfen
    ↓
GitHub Repository clonen
    ↓
devices.json laden & bearbeiten
    ↓
Git Commit & Push
    ↓
Response an Frontend
    ↓
Frontend aktualisiert Anzeige
```

## 🚀 Deployment

1. **N8N Workflow erstellen** auf https://n8n.juroct.net
2. **GitHub Token** hinterlegen (mit Write-Zugriff)
3. **Webhook URL** testen mit cURL
4. **Frontend** anpassen (siehe Frontend-Integration)

## 💻 Frontend-Integration

Die Funktion `addDevice()` in `waschkueche.html` sollte dann so aussehen:

```javascript
async function addDevice() {
  // Sammle Daten
  const deviceData = {
    action: 'add',
    device_name: prompt('Gerätename:'),
    device_type: prompt('Typ (washer/dryer):'),
    location: prompt('Standort:'),
    shelly_ip: prompt('Shelly IP:'),
    cost_per_kwh: 0.30,
    requester_email: currentUser.email
  };

  // Validierung
  if (!deviceData.device_name) return;

  // Sende an N8N
  try {
    const response = await fetch('https://n8n.juroct.net/webhook/stweg3-waschkueche-device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(deviceData)
    });

    const result = await response.json();

    if (result.success) {
      alert('✅ ' + result.message);
      await loadAdminDevices(); // Refresh
    } else {
      alert('❌ ' + result.error);
    }
  } catch (error) {
    alert('❌ Fehler: ' + error.message);
  }
}
```

## 📝 Alternative: GitHub Actions

Falls N8N nicht verfügbar ist, kann auch ein GitHub Actions Workflow verwendet werden:

```yaml
# .github/workflows/waschkueche-device-management.yml
name: Waschküche Device Management

on:
  workflow_dispatch:
    inputs:
      action:
        type: choice
        options: [add, update, delete]
      device_name:
        type: string
      device_type:
        type: choice
        options: [washer, dryer]
      location:
        type: string
      shelly_ip:
        type: string
      device_id:
        type: string
      updates_json:
        type: string

jobs:
  manage-device:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - name: Add Device
        if: inputs.action == 'add'
        run: |
          # ... siehe N8N Logik ...

      - name: Commit
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git add stweg3/waschkueche-data/devices.json
          git commit -m "🔧 Device ${inputs.action}: ${inputs.device_name}"
          git push
```

## 🤝 Kontakt

Bei Fragen zum N8N-Webhook:
- **Stefan Müller**: stefan+rosenweg@juroct.ch (Technischer Dienst)
- **N8N Admin**: stefan@juroct.net

---

**Erstellt**: 2025-01-20
**Version**: 1.0
**Status**: ⏳ Wartet auf N8N-Implementierung
