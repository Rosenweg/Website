# n8n OTP-Setup

Setup-Anleitung für den n8n Workflow, der OTP-Codes per E-Mail versendet.

## Übersicht

Die geschützte Kontaktliste von STWEG 3 verwendet einen n8n Workflow für den E-Mail-Versand von OTP-Codes (One-Time-Password).

**Vorteile gegenüber EmailJS:**
- ✅ Vollständige Kontrolle über den E-Mail-Versand
- ✅ Keine externen Abhängigkeiten oder Quota-Limits
- ✅ Bessere Fehlerbehandlung und Logging
- ✅ Kostenlos (selbst gehostet)
- ✅ Flexibel erweiterbar

## Installation

### 1. Workflow importieren

1. Öffne deine n8n-Instanz: `https://n8n.juroct.net`
2. Gehe zu **Workflows** → **Import from File**
3. Wähle die Datei `stweg3/n8n-otp-workflow.json`
4. Der Workflow wird mit dem Namen **"STWEG3 OTP Email Sender"** importiert

### 2. SMTP-Credentials konfigurieren

Der Workflow benötigt SMTP-Zugangsdaten für den E-Mail-Versand.

#### In n8n

1. Gehe zu **Credentials** → **New**
2. Wähle **SMTP**
3. Füge deine SMTP-Daten ein:

| Feld | Wert | Beispiel |
|------|------|----------|
| **Host** | SMTP-Server | `smtp.gmail.com` |
| **Port** | TLS: 587, SSL: 465 | `587` |
| **User** | E-Mail-Adresse | `deine-email@gmail.com` |
| **Password** | App-Passwort | `xxxx xxxx xxxx xxxx` |
| **From Email** | Absenderadresse | `noreply@juroct.net` |

#### Gmail App-Passwort erstellen

Für Gmail benötigst du ein App-Passwort:

1. Gehe zu https://myaccount.google.com/apppasswords
2. Erstelle ein neues App-Passwort für "n8n"
3. Kopiere das generierte Passwort (16 Zeichen)
4. Verwende dieses Passwort in n8n

⚠️ **Wichtig**: Normale Gmail-Passwörter funktionieren nicht!

### 3. Workflow aktivieren

1. Öffne den importierten Workflow in n8n
2. Überprüfe alle Nodes auf korrekte Konfiguration
3. Klicke auf **Activate** Toggle oben rechts ✅
4. Der Webhook ist nun erreichbar unter:
   ```
   https://n8n.juroct.net/webhook/stweg3-otp
   ```

## Workflow-Struktur

```
┌─────────────────┐
│  1. Webhook     │  POST /stweg3-otp
│  (Trigger)      │  Body: {email, otp_code}
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. Validate     │  • Email vorhanden?
│    Input        │  • OTP vorhanden?
│                 │  • Nicht .invalid?
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌─────┐   ┌──────────┐
│Error│   │3. Send   │  HTML-E-Mail mit OTP
│ 400 │   │   Email  │  via SMTP
└─────┘   └────┬─────┘
               │
               ▼
         ┌──────────┐
         │4. Success│  {success: true}
         │ Response │
         └──────────┘
```

### Node-Details

#### 1. Webhook (Trigger)
- **Path**: `/stweg3-otp`
- **Method**: POST
- **CORS**: Alle Origins erlaubt (`*`)
- **Erwartet**:
  ```json
  {
    "email": "user@example.ch",
    "otp_code": "123456"
  }
  ```

#### 2. Validate Input
Prüft drei Bedingungen:
1. `email` ist nicht leer ✅
2. `otp_code` ist nicht leer ✅
3. `email` enthält nicht `.invalid` ✅ (filtert Platzhalter)

**Bei Fehler**: → Error Response (400)

#### 3. Send Email
- Sendet HTML-E-Mail via SMTP
- **Betreff**: 🔒 Ihr Zugangscode für STWEG 3 Kontaktliste
- **Template**: Professionelle HTML-E-Mail mit:
  - 6-stelliger OTP-Code (groß angezeigt)
  - 10-Minuten Gültigkeitshinweis
  - Sicherheitshinweise
  - STWEG 3 Branding

#### 4. Success Response
```json
{
  "success": true,
  "message": "OTP wurde erfolgreich gesendet"
}
```

#### 5. Error Responses

**Validation Error (400)**:
```json
{
  "success": false,
  "error": "Ungültige Anfrage. Email und OTP-Code sind erforderlich. Platzhalter-E-Mails (.invalid) werden nicht akzeptiert."
}
```

**Email Error (500)**:
```json
{
  "success": false,
  "error": "Fehler beim E-Mail-Versand. Bitte versuchen Sie es später erneut."
}
```

## API-Nutzung

### Request

```bash
curl -X POST https://n8n.juroct.net/webhook/stweg3-otp \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.ch",
    "otp_code": "123456"
  }'
```

### JavaScript (Frontend)

```javascript
const response = await fetch('https://n8n.juroct.net/webhook/stweg3-otp', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({
        email: email,
        otp_code: otpCode
    })
});

const result = await response.json();

if (result.success) {
    console.log('OTP gesendet!');
} else {
    console.error('Fehler:', result.error);
}
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
4. Überprüfe dein E-Mail-Postfach (auch Spam!)

### n8n Test-Execution

1. Öffne den Workflow in n8n
2. Klicke auf **Execute Workflow**
3. Gib Test-Daten ein
4. Prüfe die Ausgabe jeder Node

## Troubleshooting

### ❌ E-Mails kommen nicht an

**Überprüfe SMTP-Credentials:**
1. Gehe in n8n zu **Credentials**
2. Bearbeite die SMTP-Credentials
3. Teste die Verbindung mit "Test" Button

**Überprüfe Workflow-Logs:**
1. Öffne den Workflow
2. Klicke auf **Executions** (oben rechts)
3. Schaue dir die letzten Ausführungen an
4. Prüfe auf Fehler in der "Send Email" Node

**Überprüfe Spam-Ordner:**
- E-Mails könnten im Spam landen
- Markiere E-Mails als "Kein Spam"

**Überprüfe Firewall/Ports:**
- Stelle sicher, dass Port 587 (TLS) oder 465 (SSL) nicht blockiert ist

### ❌ Webhook antwortet nicht

**Workflow aktiv?**
- Stelle sicher, dass der Toggle auf "Active" steht ✅

**URL korrekt?**
- Teste: `curl https://n8n.juroct.net/webhook/stweg3-otp`
- Sollte JSON-Antwort zurückgeben

**CORS-Probleme?**
- Der Webhook ist für alle Origins konfiguriert (`*`)
- Prüfe Browser-Console auf CORS-Fehler (F12)

### ❌ `.invalid` E-Mails werden nicht gefiltert

**Prüfe Validation Node:**
1. Öffne "Validate Input" Node
2. Stelle sicher, dass die Bedingung existiert:
   ```
   {{ $json.body.email.includes('.invalid') ? false : true }}
   ```

## Sicherheit

### Öffentlicher Webhook

Der Webhook ist öffentlich zugänglich, aber geschützt durch:

1. **Frontend-Validierung**: Nur berechtigte E-Mails
2. **Backend-Filter**: `.invalid` E-Mails werden abgelehnt
3. **Dynamische Hausverwaltung**: Domain wird aus `kontakte.json` extrahiert
4. **OTP-Gültigkeit**: Codes sind nur 10 Minuten gültig
5. **Frontend-Validierung**: Codes werden im Frontend validiert

### Hausverwaltungs-Domain (Dynamisch)

Die Hausverwaltungs-Domain wird automatisch aus `kontakte.json` extrahiert:

- **Quelle**: `kontakte.json` → `hausverwaltung.email`
- **Beispiel**: `hello@langpartners.ch` → Domain `langpartners.ch`
- **Zugang**: Alle E-Mails von @langpartners.ch erhalten automatisch Zugang
- **Vorteil**: Bei Wechsel der Hausverwaltung nur JSON ändern, kein Code-Update!

### Platzhalter-E-Mails

Alle Platzhalter in `kontakte.json` verwenden `.invalid`:

```
eigentuemer5@beispiel.invalid
mieter2@beispiel.invalid
eigentuemer-hobby@beispiel.invalid
```

**Warum `.invalid`?**
- RFC 2606: Reservierte Top-Level-Domain
- Garantiert nicht routbar
- Verhindert versehentlichen E-Mail-Versand

Diese werden vom Workflow automatisch abgelehnt.

### Empfohlene Verbesserungen (optional)

1. **Rate Limiting**: Begrenze Anfragen pro IP/E-Mail
2. **E-Mail-Whitelist**: Validiere E-Mails auch im Backend
3. **Logging**: Logge alle Anfragen für Audit-Zwecke
4. **Monitoring**: Richte Alerts für fehlgeschlagene E-Mails ein

## Weiterführende Links

- **[Admin-Bereich Setup](n8n-Save-Setup)** - JSON speichern via GitHub
- **[Architektur](Architektur)** - Gesamtübersicht
- **[FAQ](FAQ)** - Häufige Fragen

## Support

Bei Problemen:

**Technischer Dienst Rosenweg**
- Stefan Müller
- E-Mail: stefan+rosenweg@juroct.ch
- Telefon: +41 76 519 99 70
