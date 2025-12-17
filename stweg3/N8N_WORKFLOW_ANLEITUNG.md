# n8n Generic Email Workflow - Anleitung

## Übersicht

Der generische E-Mail-Workflow ermöglicht es, E-Mails mit beliebigem Inhalt über einen einzigen Webhook zu versenden. Alle E-Mail-Templates werden direkt im Admin-Code generiert.

## Workflow importieren

1. Öffne n8n
2. Klicke auf **"Import from File"** oder **"+"** → **"Import from file"**
3. Wähle die Datei `/n8n-workflows/generic-email.json`
4. Der Workflow wird importiert

## Workflow konfigurieren

### 1. SMTP-Credentials einrichten

Im **Send Email** Node:
- Klicke auf **"Credential to connect with"**
- Wähle deine SMTP-Credentials oder erstelle neue:
  - **Host**: z.B. `smtp.gmail.com`, `smtp.office365.com`, etc.
  - **Port**: `587` (TLS) oder `465` (SSL)
  - **User**: Deine E-Mail-Adresse
  - **Password**: Dein E-Mail-Passwort oder App-Passwort
  - **Secure Connection**: `TLS` (empfohlen)

### 2. Webhook aktivieren

- Der Webhook-Pfad ist: `/webhook/send-email`
- Die vollständige URL ist bereits in `kontakte.json` konfiguriert:
  ```json
  "webhooks": {
    "send_email": "https://n8n.juroct.net/webhook/send-email"
  }
  ```

### 3. Workflow aktivieren

- Klicke oben rechts auf **"Active"**, um den Workflow zu aktivieren
- Der Workflow ist jetzt bereit, E-Mails zu empfangen

## Wie der Workflow funktioniert

### Eingehende Daten (Webhook empfängt):

```json
{
  "recipients": ["email1@example.com", "email2@example.com"],
  "subject": "Betreff der E-Mail",
  "htmlContent": "<html>...</html>",
  "cc": ["optional@example.com"],
  "bcc": ["optional@example.com"],
  "replyTo": "optional@example.com"
}
```

### Workflow-Schritte:

1. **Webhook** empfängt die E-Mail-Daten
2. **Send Email** versendet die E-Mail an alle Empfänger
   - `recipients`: Wird zu `To` konvertiert (durch Komma getrennt)
   - `subject`: Betreff
   - `htmlContent`: HTML-Inhalt der E-Mail
   - `cc`, `bcc`, `replyTo`: Optional
3. **Respond to Webhook** sendet Erfolgsbestätigung zurück

### Ausgabe (Response):

```json
{
  "success": true,
  "message": "Email sent successfully",
  "recipients": ["email1@example.com", "email2@example.com"]
}
```

## Verwendung im Admin

Der Admin-Code verwendet automatisch diesen Workflow für:

### 1. E-Mail-Adressänderungen

```javascript
await sendEmail(
    change.oldEmail,
    'STWEG 3: Ihre Kontaktdaten wurden aktualisiert',
    generateEmailChangeHTML(data)
);
```

### 2. Verteilerlisten-Änderungen

```javascript
await sendEmail(
    ausschussEmails,
    'STWEG 3: Verteilerlisten aktualisiert',
    generateVerteilerChangeHTML(data)
);
```

## E-Mail-Templates

Die E-Mail-Templates werden im `admin.html` als JavaScript-Funktionen definiert:

- `generateEmailChangeHTML(data)` - Für Kontaktdatenänderungen
- `generateVerteilerChangeHTML(data)` - Für Verteilerlisten-Änderungen

### Neues Template hinzufügen:

```javascript
function generateMyCustomHTML(data) {
    return `<!DOCTYPE html>
<html>
<head>
    <style>
        /* Dein CSS hier */
    </style>
</head>
<body>
    <div class="container">
        <h1>${data.title}</h1>
        <p>${data.content}</p>
    </div>
</body>
</html>`;
}

// Verwenden:
await sendEmail(
    recipients,
    'Mein Betreff',
    generateMyCustomHTML({ title: 'Test', content: 'Hallo!' })
);
```

## Testen

### Test mit curl:

```bash
curl -X POST https://n8n.juroct.net/webhook/send-email \
  -H "Content-Type: application/json" \
  -d '{
    "recipients": ["deine-email@example.com"],
    "subject": "Test E-Mail",
    "htmlContent": "<h1>Test</h1><p>Das ist eine Test-E-Mail</p>"
  }'
```

### Test im Admin:

1. Öffne `admin.html`
2. Ändere eine Kontaktadresse
3. Speichere die Änderung
4. Prüfe dein E-Mail-Postfach (alte E-Mail-Adresse)

## Vorteile gegenüber spezifischen Webhooks

✅ **Ein Workflow für alles** - Nur ein Workflow statt mehrere
✅ **Flexibler** - Kann für jeden E-Mail-Typ verwendet werden
✅ **Einfacher zu warten** - Änderungen an einem Ort
✅ **Templates im Code** - Volle Kontrolle über E-Mail-Design
✅ **Wiederverwendbar** - Für STWEG 3, 4 und 9 nutzbar

## Troubleshooting

### E-Mail wird nicht gesendet:

1. **Prüfe Webhook-URL** in `kontakte.json`
2. **Prüfe SMTP-Credentials** in n8n
3. **Prüfe Workflow-Status** (muss "Active" sein)
4. **Prüfe Console-Logs** im Admin (F12 → Console)
5. **Prüfe n8n Execution Log** für Fehler

### Fehlerhafte HTML-E-Mails:

1. **Validiere HTML** in Template-Funktion
2. **Teste mit einfachem HTML** zuerst
3. **Prüfe Escape-Zeichen** in Template Literals (` `` `)

## Erweiterungen

### BCC an Ausschuss:

```javascript
await sendEmail(
    recipients,
    'Betreff',
    htmlContent,
    { bcc: kontakteData.ausschuss.map(m => m.email) }
);
```

### CC an Hausverwaltung:

```javascript
await sendEmail(
    recipients,
    'Betreff',
    htmlContent,
    { cc: [kontakteData.hausverwaltung.email] }
);
```

### Reply-To setzen:

```javascript
await sendEmail(
    recipients,
    'Betreff',
    htmlContent,
    { replyTo: 'noreply@rosenweg4303.ch' }
);
```
