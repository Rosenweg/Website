# n8n Generic Email Workflow - Setup-Anleitung

Da der Workflow-Import manchmal Felder leer lässt, hier die manuelle Konfiguration:

## Workflow erstellen

### 1. Neuen Workflow erstellen
- Klicke auf **"+"** → **"New workflow"**
- Benenne ihn: **"Generic Email Sender"**

### 2. Webhook Node hinzufügen
1. Klicke auf **"+"** → Suche "Webhook"
2. Konfiguration:
   - **HTTP Method**: POST
   - **Path**: `send-email`
   - **Response Mode**: "Using 'Respond to Webhook' Node"

### 3. Send Email Node hinzufügen
1. Klicke auf **"+"** → Suche "Send Email"
2. Verbinde mit Webhook
3. Konfiguration:

#### Credentials
- Wähle oder erstelle SMTP-Credentials:
  - Host: `smtp.gmail.com` (oder dein SMTP-Server)
  - Port: `587`
  - User: Deine E-Mail
  - Password: App-Passwort
  - Secure Connection: TLS

#### From Email
```
={{ $('Webhook').item.json.body.fromEmail || 'noreply@rosenweg4303.ch' }}
```

#### To Email
```
={{ $('Webhook').item.json.body.recipients.join(',') }}
```

#### Subject
```
={{ $('Webhook').item.json.body.subject }}
```

#### Email Format
- Wähle: **HTML**

#### Message (HTML)
```
={{ $('Webhook').item.json.body.htmlContent }}
```

#### Options (aufklappen mit "Add option")

**CC Email**:
```
={{ $('Webhook').item.json.body.cc && $('Webhook').item.json.body.cc.length > 0 ? $('Webhook').item.json.body.cc.join(',') : '' }}
```

**BCC Email**:
```
={{ $('Webhook').item.json.body.bcc && $('Webhook').item.json.body.bcc.length > 0 ? $('Webhook').item.json.body.bcc.join(',') : '' }}
```

**Reply To**:
```
={{ $('Webhook').item.json.body.replyTo || '' }}
```

### 4. Respond to Webhook Node hinzufügen
1. Klicke auf **"+"** → Suche "Respond to Webhook"
2. Verbinde mit "Send Email"
3. Konfiguration:
   - **Respond With**: JSON
   - **Response Body**:
```
={{ { success: true, message: 'Email sent successfully', recipients: $('Webhook').item.json.body.recipients } }}
```

### 5. Workflow aktivieren
- Klicke oben rechts auf **"Active"**
- Notiere dir die Webhook-URL

### 6. Webhook-URL in kontakte.json eintragen

Die URL sollte sein: `https://n8n.juroct.net/webhook/send-email`

In `kontakte.json`:
```json
"webhooks": {
  "send_email": "https://n8n.juroct.net/webhook/send-email"
}
```

## Test

### Test-Request mit curl:
```bash
curl -X POST https://n8n.juroct.net/webhook/send-email \
  -H "Content-Type: application/json" \
  -d '{
    "recipients": ["deine-email@example.com"],
    "subject": "Test Email",
    "htmlContent": "<h1>Test</h1><p>Das ist ein Test</p>",
    "fromEmail": "noreply@rosenweg4303.ch"
  }'
```

### Erwartete Antwort:
```json
{
  "success": true,
  "message": "Email sent successfully",
  "recipients": ["deine-email@example.com"]
}
```

## Troubleshooting

### Fehler: "Cannot read property 'recipients' of undefined"
- Webhook empfängt Daten nicht korrekt
- Prüfe: Content-Type muss "application/json" sein

### Fehler: SMTP Connection failed
- SMTP-Credentials prüfen
- Port und Host prüfen
- App-Passwort statt normalem Passwort verwenden (Gmail)

### E-Mail kommt nicht an
- Spam-Ordner prüfen
- SMTP-Logs in n8n prüfen
- "From Email" muss mit SMTP-Account übereinstimmen

## Wichtige Hinweise

⚠️ **Expression-Syntax**: Alle Expressions müssen mit `={{` beginnen und mit `}}` enden

⚠️ **Node-Referenz**: `$('Webhook')` referenziert den Webhook-Node. Der Name muss exakt übereinstimmen.

⚠️ **JSON-Struktur**: Der Webhook erwartet `body.recipients`, nicht direkt `recipients`
