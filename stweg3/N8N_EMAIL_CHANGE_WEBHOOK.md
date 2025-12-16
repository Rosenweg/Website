# N8N Webhook für E-Mail-Änderungsbenachrichtigungen

## Webhook URL
`https://n8n.juroct.net/webhook/stweg3-email-change-notification`

## Zweck
Sendet automatische Benachrichtigungen an die alte E-Mail-Adresse, wenn Kontaktdaten im STWEG 3 Admin-Bereich geändert wurden.

## Request Format

### HTTP Method
`POST`

### Content-Type
`application/json`

### Request Body
```json
{
  "oldEmail": "alte@email.ch",
  "newEmail": "neue@email.ch",
  "type": "Eigentümer" | "Mieter",
  "name": "Max Mustermann",
  "wohnung": "Wohnung 1.1",
  "changeList": [
    "Name: \"Max Müller\" → \"Max Mustermann\"",
    "E-Mail: \"alte@email.ch\" → \"neue@email.ch\"",
    "Telefon: \"079 123 45 67\" → \"079 987 65 43\""
  ],
  "changedBy": "admin@stweg3.ch",
  "timestamp": "2025-12-16T10:30:00.000Z"
}
```

## N8N Workflow Struktur

### 1. Webhook Node
- **Method**: POST
- **Path**: `/webhook/stweg3-email-change-notification`
- **Authentication**: None (kann später hinzugefügt werden)

### 2. Email Node (Send Email)
**Konfiguration:**
- **To**: `{{ $json.oldEmail }}`
- **Subject**: `📧 Ihre Kontaktdaten wurden aktualisiert - STWEG 3`
- **Email Type**: HTML

**HTML Template:**
```html
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #ea580c 0%, #c2410c 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .content { background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; }
        .changes { background: white; padding: 15px; margin: 20px 0; border-left: 4px solid #ea580c; border-radius: 4px; }
        .footer { background: #1f2937; color: #9ca3af; padding: 20px; text-align: center; font-size: 12px; border-radius: 0 0 8px 8px; }
        .warning { background: #fef3c7; border: 1px solid #fbbf24; padding: 15px; border-radius: 4px; margin: 20px 0; }
        ul { list-style: none; padding: 0; }
        li { padding: 8px 0; border-bottom: 1px solid #e5e7eb; }
        li:last-child { border-bottom: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin: 0;">🏢 STWEG 3 Rosenweg</h1>
            <p style="margin: 5px 0 0 0; opacity: 0.9;">Kontaktdaten-Änderung</p>
        </div>

        <div class="content">
            <h2>Ihre Kontaktdaten wurden aktualisiert</h2>

            <p>Hallo,</p>

            <p>Ihre Kontaktdaten für <strong>{{ $json.wohnung }}</strong> ({{ $json.type }}) wurden soeben im STWEG 3 Admin-Bereich geändert.</p>

            <div class="changes">
                <h3 style="margin-top: 0;">📝 Folgende Änderungen wurden vorgenommen:</h3>
                <ul>
                    {{#each $json.changeList}}
                    <li>{{ this }}</li>
                    {{/each}}
                </ul>
            </div>

            <div class="warning">
                <strong>⚠️ Wichtig:</strong> Falls Sie diese Änderung nicht selbst vorgenommen haben oder nicht damit einverstanden sind,
                wenden Sie sich bitte umgehend an den Ausschuss oder an <strong>{{ $json.changedBy }}</strong>,
                der diese Änderung durchgeführt hat.
            </div>

            <p><strong>Details zur Änderung:</strong></p>
            <ul style="background: white; padding: 15px; border-radius: 4px;">
                <li><strong>Zeitpunkt:</strong> {{ $json.timestamp }}</li>
                <li><strong>Geändert von:</strong> {{ $json.changedBy }}</li>
                <li><strong>Wohnung:</strong> {{ $json.wohnung }}</li>
                <li><strong>Art:</strong> {{ $json.type }}</li>
            </ul>

            <p>Diese E-Mail wurde automatisch an Ihre alte E-Mail-Adresse (<strong>{{ $json.oldEmail }}</strong>) gesendet,
            um Sie über die Änderung zu informieren.</p>

            <p>Zukünftige Benachrichtigungen erhalten Sie an: <strong>{{ $json.newEmail }}</strong></p>
        </div>

        <div class="footer">
            <p>© 2025 STWEG 3 - Teil der STWEG-Kooperation Rosenweg<br>
            Rosenweg 43, 4303 Kaiseraugst</p>
            <p style="margin-top: 15px; font-size: 11px; color: #6b7280;">
                Diese E-Mail wurde automatisch generiert. Bitte antworten Sie nicht direkt auf diese E-Mail.
            </p>
        </div>
    </div>
</body>
</html>
```

### 3. (Optional) CC Email Node
Sendet eine Kopie an den Admin, der die Änderung vorgenommen hat:
- **To**: `{{ $json.changedBy }}`
- **Subject**: `✓ Bestätigung: Kontaktdaten geändert für {{ $json.name }}`

### 4. Response Node
```json
{
  "success": true,
  "message": "Notification sent successfully",
  "timestamp": "{{ $now }}"
}
```

## Sicherheit

### Empfohlene Verbesserungen:
1. **API Key Authentication**: Fügen Sie einen API-Key in den Headers hinzu
2. **Rate Limiting**: Begrenzen Sie die Anzahl der Requests pro Minute
3. **IP Whitelist**: Erlauben Sie nur Requests von bekannten IPs
4. **Logging**: Protokollieren Sie alle Änderungen für Audit-Zwecke

## Testing

### Test Request (curl)
```bash
curl -X POST https://n8n.juroct.net/webhook/stweg3-email-change-notification \
  -H "Content-Type: application/json" \
  -d '{
    "oldEmail": "test@example.com",
    "newEmail": "new@example.com",
    "type": "Eigentümer",
    "name": "Test User",
    "wohnung": "Wohnung 1.1",
    "changeList": [
      "E-Mail: \"test@example.com\" → \"new@example.com\""
    ],
    "changedBy": "admin@stweg3.ch",
    "timestamp": "2025-12-16T10:30:00.000Z"
  }'
```

## Fehlerbehandlung

Der Workflow sollte folgende Fehler behandeln:
- **Ungültige E-Mail-Adresse**: Validierung im Webhook Node
- **E-Mail-Versand fehlgeschlagen**: Fehler loggen und Response mit Error-Status zurückgeben
- **Fehlende Parameter**: Validierung der Required Fields

## Monitoring

Überwachen Sie:
- Anzahl der gesendeten Benachrichtigungen pro Tag
- Fehlgeschlagene E-Mail-Zustellungen
- Ungewöhnliche Aktivitätsmuster (viele Änderungen in kurzer Zeit)
