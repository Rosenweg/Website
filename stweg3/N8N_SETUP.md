# n8n Setup für STWEG3 OTP E-Mail-Versand

## Übersicht

Die geschützte Kontaktliste von STWEG 3 verwendet jetzt einen n8n Workflow anstelle von EmailJS, um OTP-Codes (One-Time-Password) per E-Mail zu versenden.

## Vorteile gegenüber EmailJS

- Vollständige Kontrolle über den E-Mail-Versand
- Keine externen Abhängigkeiten oder Quota-Limits von Drittanbietern
- Bessere Fehlerbehandlung und Logging
- Kostenlos (selbst gehostet)
- Flexibel erweiterbar

## Installation

### 1. n8n Workflow importieren

1. Öffne deine n8n-Instanz: `https://n8n.juroct.net`
2. Gehe zu **Workflows** → **Import from File**
3. Wähle die Datei `n8n-otp-workflow.json` aus diesem Verzeichnis
4. Der Workflow wird mit dem Namen **"STWEG3 OTP Email Sender"** importiert

### 2. SMTP-Credentials konfigurieren

Der Workflow benötigt SMTP-Zugangsdaten für den E-Mail-Versand:

1. Gehe in n8n zu **Credentials** → **New**
2. Wähle **SMTP**
3. Füge deine SMTP-Daten ein:
   - **Host**: z.B. `smtp.gmail.com` (für Gmail)
   - **Port**: `587` (TLS) oder `465` (SSL)
   - **User**: Deine E-Mail-Adresse
   - **Password**: Dein App-Passwort
   - **From Email**: `noreply@juroct.net` (oder deine gewünschte Absenderadresse)

**Beispiel für Gmail:**
- Host: `smtp.gmail.com`
- Port: `587`
- User: `deine-email@gmail.com`
- Password: App-Passwort (erstelle dies in deinen Google-Kontoeinstellungen unter "App-Passwörter")

**Hinweis für Gmail-Nutzer:**
Du musst ein App-Passwort erstellen, da normale Passwörter nicht funktionieren:
1. Gehe zu https://myaccount.google.com/apppasswords
2. Erstelle ein neues App-Passwort
3. Verwende dieses Passwort in n8n

### 3. Workflow aktivieren

1. Öffne den importierten Workflow
2. Überprüfe, dass alle Nodes korrekt konfiguriert sind
3. Klicke auf den **Activate** Toggle oben rechts
4. Der Webhook ist jetzt unter dieser URL erreichbar:
   ```
   https://n8n.juroct.net/webhook/stweg3-otp
   ```

## Workflow-Struktur

Der Workflow besteht aus folgenden Komponenten:

### 1. Webhook (Trigger)
- **Path**: `/stweg3-otp`
- **Method**: POST
- **Erwartet**: JSON mit `email` und `otp_code`

### 2. Validate Input (Validation)
- Prüft, ob `email` und `otp_code` vorhanden sind
- **Filtert `.invalid` E-Mails aus** (Platzhalter-Adressen)
- Bei Fehler: 400 Bad Request Response

### 3. Send Email (E-Mail-Versand)
- Sendet HTML-E-Mail mit OTP-Code
- Verwendet SMTP-Credentials
- Schönes, professionelles E-Mail-Template

### 4. Success Response
- Gibt JSON-Response zurück: `{"success": true, "message": "OTP wurde erfolgreich gesendet"}`

### 5. Error Responses
- **Validation Error**: 400 Bad Request
- **Email Error**: 500 Internal Server Error

## API-Nutzung

### Request

```bash
POST https://n8n.juroct.net/webhook/stweg3-otp
Content-Type: application/json

{
  "email": "benutzer@beispiel.ch",
  "otp_code": "123456"
}
```

### Success Response (200 OK)

```json
{
  "success": true,
  "message": "OTP wurde erfolgreich gesendet"
}
```

### Error Response (400 Bad Request)

```json
{
  "success": false,
  "error": "Ungültige Anfrage. Email und OTP-Code sind erforderlich, oder E-Mail-Adresse ist ein Platzhalter (.invalid)."
}
```

### Error Response (500 Internal Server Error)

```json
{
  "success": false,
  "error": "Fehler beim E-Mail-Versand. Bitte versuchen Sie es später erneut."
}
```

## HTML-Integration

Die Datei `stweg3-kontakte.html` wurde aktualisiert:

**Alte Konfiguration (EmailJS):**
```javascript
const EMAILJS_SERVICE_ID = 'service_qevit9e';
const EMAILJS_TEMPLATE_ID = 'template_uc5u3gi';
const EMAILJS_PUBLIC_KEY = 'DnHPrkTT61uco4ro4';
```

**Neue Konfiguration (n8n):**
```javascript
const N8N_WEBHOOK_URL = 'https://n8n.juroct.net/webhook/stweg3-otp';
```

## Testing

### Manueller Test via curl

```bash
curl -X POST https://n8n.juroct.net/webhook/stweg3-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"deine@email.ch","otp_code":"123456"}'
```

### Test über die Website

1. Öffne `stweg3-kontakte.html` im Browser
2. Gib eine berechtigte E-Mail-Adresse ein
3. Klicke auf "Zugangscode per E-Mail senden"
4. Überprüfe dein E-Mail-Postfach (auch Spam-Ordner)

## Troubleshooting

### E-Mails kommen nicht an

1. **Überprüfe SMTP-Credentials**:
   - Gehe in n8n zu Credentials
   - Teste die SMTP-Verbindung

2. **Überprüfe n8n Workflow-Logs**:
   - Öffne den Workflow
   - Klicke auf "Executions"
   - Schaue dir die letzten Ausführungen an

3. **Überprüfe Spam-Ordner**:
   - Die E-Mails könnten im Spam landen

4. **Überprüfe Firewall/Ports**:
   - Stelle sicher, dass Port 587 oder 465 nicht blockiert ist

### Webhook antwortet nicht

1. **Workflow aktiv?**:
   - Stelle sicher, dass der Workflow aktiviert ist

2. **URL korrekt?**:
   - Überprüfe, ob die URL `https://n8n.juroct.net/webhook/stweg3-otp` erreichbar ist

3. **CORS-Probleme?**:
   - Der Webhook ist für alle Origins (`*`) konfiguriert
   - Überprüfe Browser-Console auf CORS-Fehler

## Sicherheit

- Der Webhook ist öffentlich zugänglich (POST-Requests)
- Die Sicherheit basiert auf:
  1. E-Mail-Validierung im Frontend (nur berechtigte E-Mails)
  2. **Backend-Filter**: `.invalid` E-Mail-Adressen werden automatisch abgewiesen
  3. OTP-Codes sind nur 10 Minuten gültig
  4. OTP-Codes werden im Frontend generiert und validiert

### Platzhalter-E-Mails

Alle Platzhalter-E-Mails in `kontakte.json` verwenden die Domain `.invalid`:
- `eigentuemer5@beispiel.invalid`
- `mieter2@beispiel.invalid`
- `mieter6@beispiel.invalid`
- `eigentuemer-hobby@beispiel.invalid`

Diese E-Mails werden vom n8n Workflow automatisch abgelehnt und es werden keine OTP-Codes an sie versendet.

**Warum `.invalid`?**
- `.invalid` ist eine reservierte Top-Level-Domain (RFC 2606)
- Garantiert nicht routbar und kann nie als echte Domain existieren
- Verhindert versehentlichen E-Mail-Versand an Platzhalter

### Empfohlene Verbesserungen (optional)

1. **Rate Limiting**: Implementiere ein Rate Limit im Workflow
2. **E-Mail-Whitelist**: Validiere E-Mails auch im n8n Workflow gegen die berechtigten E-Mails
3. **Logging**: Logge alle Anfragen für Audit-Zwecke

## Support

Bei Problemen wende dich an:

**Technischer Dienst Rosenweg**
- Stefan Müller
- E-Mail: stefan+rosenweg@juroct.ch
- Telefon: +41 76 519 99 70
