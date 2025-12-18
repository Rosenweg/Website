# n8n Workflow: Zähler-Benutzer automatisch erstellen

## Übersicht

Dieser Workflow ermöglicht die automatische Registrierung neuer Benutzer für den Energie-Monitor. Wenn eine E-Mail-Adresse in den STWEG-Kontakten gefunden wird, aber noch nicht in der `zaehler-config.json` existiert, wird der Benutzer automatisch angelegt.

## Workflow-Schritte

### 1. Webhook (Trigger)
- **URL**: `https://n8n.juroct.net/webhook/zaehler-benutzer-erstellen`
- **Methode**: POST
- **Erwartete Daten**:
```json
{
  "email": "benutzer@example.com",
  "name": "Max Mustermann",
  "wohnung": "Rosenweg 9, Whg 3",
  "stweg": 3,
  "zugriff": "bewohner",
  "zaehler": [],
  "needs_meter_assignment": true,
  "created_at": "2024-12-18T10:30:00.000Z"
}
```

### 2. GitHub: zaehler-config.json lesen
- **Aktion**: GET Request
- **URL**: `https://api.github.com/repos/Rosenweg/Website/contents/zaehler-config.json`
- **Headers**:
  - `Authorization`: `Bearer YOUR_GITHUB_TOKEN`
  - `Accept`: `application/vnd.github.v3+json`
  - `User-Agent`: `n8n-workflow`

**Wichtig**: Die Response enthält:
- `content`: Base64-encodierte Datei
- `sha`: SHA-Hash für den Commit (wird für Update benötigt)

### 3. Config aktualisieren (Code Node)
```javascript
// Input: GitHub Response und Webhook-Daten
const githubData = $input.first().json;
const webhookData = $('Webhook').first().json.body;

// Config dekodieren
const configContent = Buffer.from(githubData.content, 'base64').toString('utf-8');
const config = JSON.parse(configContent);

// Prüfen, ob Benutzer bereits existiert
const existingUser = config.benutzer.find(b =>
  b.email.toLowerCase() === webhookData.email.toLowerCase()
);

if (existingUser) {
  return {
    json: {
      success: false,
      message: 'Benutzer existiert bereits',
      skip_update: true
    }
  };
}

// Neuen Benutzer hinzufügen
const newUser = {
  email: webhookData.email,
  name: webhookData.name,
  wohnung: webhookData.wohnung,
  stweg: webhookData.stweg,
  zugriff: webhookData.zugriff || 'bewohner',
  zaehler: webhookData.zaehler || [],
  needs_meter_assignment: true,
  created_at: webhookData.created_at || new Date().toISOString()
};

config.benutzer.push(newUser);

// Config wieder encodieren
const updatedContent = JSON.stringify(config, null, 2);
const base64Content = Buffer.from(updatedContent).toString('base64');

return {
  json: {
    content: base64Content,
    sha: githubData.sha,
    email: webhookData.email,
    success: true,
    skip_update: false
  }
};
```

### 4. GitHub: Config aktualisieren (IF-Node)
**Bedingung**: `{{$json.skip_update}}` = `false`

Wenn true (nicht skippen), dann:

### 5. GitHub: Config zurückschreiben
- **Aktion**: PUT Request
- **URL**: `https://api.github.com/repos/Rosenweg/Website/contents/zaehler-config.json`
- **Headers**:
  - `Authorization`: `Bearer YOUR_GITHUB_TOKEN`
  - `Accept`: `application/vnd.github.v3+json`
  - `User-Agent`: `n8n-workflow`
  - `Content-Type`: `application/json`

**Body**:
```json
{
  "message": "Neuer Benutzer automatisch angelegt: {{$json.email}}",
  "content": "{{$json.content}}",
  "sha": "{{$json.sha}}",
  "branch": "main"
}
```

### 6. Erfolg zurückgeben
**Response**:
```json
{
  "success": true,
  "message": "Benutzer erfolgreich angelegt",
  "email": "{{$json.email}}"
}
```

### 7. Fehler zurückgeben (IF false branch)
**Response**:
```json
{
  "success": false,
  "message": "{{$json.message}}"
}
```

## GitHub Token

Du benötigst ein GitHub Personal Access Token mit folgenden Permissions:
- `repo` (Full control of private repositories)
  - Oder nur `public_repo` wenn das Repository public ist
- `contents:write`

Token erstellen unter: https://github.com/settings/tokens

## Sicherheit

⚠️ **Wichtig**: Der Workflow sollte folgende Validierungen haben:

1. **E-Mail-Format prüfen**
2. **STWEG-Nummer validieren** (1-8)
3. **Rate Limiting** (max. 5 Anfragen pro E-Mail pro Stunde)
4. **Logging** aller Anfragen für Audit-Trail

## Testing

Teste den Workflow mit:
```bash
curl -X POST https://n8n.juroct.net/webhook/zaehler-benutzer-erstellen \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@rosenweg4303.ch",
    "name": "Test Benutzer",
    "wohnung": "Rosenweg 9, Test",
    "stweg": 3,
    "zugriff": "bewohner",
    "zaehler": [],
    "needs_meter_assignment": true
  }'
```

Erwartete Response bei Erfolg:
```json
{
  "success": true,
  "message": "Benutzer erfolgreich angelegt",
  "email": "test@rosenweg4303.ch"
}
```

## Troubleshooting

### Problem: GitHub API gibt 409 Conflict
**Ursache**: SHA-Hash stimmt nicht überein (jemand anderes hat die Datei zwischenzeitlich geändert)
**Lösung**: Workflow muss von vorne starten (neueste SHA holen)

### Problem: Benutzer wird nicht gefunden nach Erstellung
**Ursache**: Browser-Cache oder GitHub Pages Cache
**Lösung**:
- Frontend verwendet Cache-Bypass: `?t=${timestamp}`
- 2 Sekunden Wartezeit im Frontend eingebaut

### Problem: 401 Unauthorized
**Ursache**: GitHub Token ungültig oder abgelaufen
**Lösung**: Neuen Token erstellen und in n8n aktualisieren

## Frontend-Integration

Das Frontend (`energie-monitor.html`) macht Folgendes:

1. Prüft, ob E-Mail in `zaehler-config.json` existiert
2. Wenn nicht → Sucht in `stweg*/data/kontakte.json`
3. Wenn gefunden → Ruft Webhook auf
4. Wartet 2 Sekunden
5. Lädt Config neu mit Cache-Bypass
6. Prüft, ob Benutzer jetzt vorhanden ist
7. Sendet OTP-Code

## Wartung

- **Benutzer manuell löschen**: Direkt in `zaehler-config.json` editieren
- **Zähler zuordnen**: Vom Technik-Team manuell in Config hinzufügen
- **Workflow-Logs**: In n8n unter "Executions" prüfen
