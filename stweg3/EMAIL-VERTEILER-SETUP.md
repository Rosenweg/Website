# E-Mail Verteiler System - Setup Anleitung

## Übersicht

Das E-Mail Verteiler System ermöglicht es berechtigten Personen, E-Mails an vordefinierte Verteiler zu senden:

- **📋 Alle Eigentümer** (`eigentuemer@rosenweg9.ch`)
- **⭐ Ausschuss** (`ausschuss@rosenweg9.ch`)
- **👥 Alle Bewohner** (`alle@rosenweg9.ch`) - Eigentümer + berechtigte Mieter

## System-Komponenten

### 1. n8n Workflow: `n8n-email-verteiler-workflow.json`

**Webhook-URL**: `https://n8n.juroct.net/webhook/stweg3-email-verteiler`

**Funktion**:
1. Empfängt POST-Request mit E-Mail-Daten
2. Lädt `verteiler.json` und `kontakte.json`
3. Ermittelt alle Mitglieder des gewählten Verteilers
4. Sendet E-Mail an alle Mitglieder

**Request Format**:
```json
{
  "verteiler": "eigentuemer",
  "subject": "Betreff der E-Mail",
  "message": "Nachrichtentext",
  "sender_email": "absender@example.com",
  "sender_name": "Max Mustermann"
}
```

**Response (Erfolg)**:
```json
{
  "success": true,
  "message": "E-Mail wurde an Eigentümer-Verteiler versendet",
  "recipients_count": 9,
  "verteiler": "eigentuemer"
}
```

**Response (Fehler)**:
```json
{
  "success": false,
  "error": "Fehlerbeschreibung"
}
```

### 2. Webseite: `email-verteiler.html`

**URL**: `https://www.rosenweg4303.ch/stweg3/email-verteiler.html`

**Features**:
- 🔐 **OTP-Authentifizierung** - Nur berechtigte Personen können E-Mails senden
- 📋 **Verteiler-Auswahl** - Wahl zwischen Eigentümer, Ausschuss oder Alle
- ✉️ **Formular** - Betreff, Nachricht und optionaler Absendername
- ✅ **Bestätigung** - Erfolgsmeldung mit Anzahl der Empfänger

**Berechtigte Personen**:
- Ausschussmitglieder
- Eigentümer
- Berechtigte Mieter

### 3. Datenquellen

**verteiler.json**:
```json
{
  "verteiler": [
    {
      "id": "eigentuemer",
      "email": "eigentuemer@rosenweg9.ch",
      "name": "Eigentümer-Verteiler",
      "typ": "automatisch"
    }
  ]
}
```

**kontakte.json**:
- Enthält alle Wohnungen mit Eigentümern und Mietern
- Enthält Ausschuss-Mitglieder
- Wird automatisch ausgewertet

## n8n Workflow Setup

### Schritt 1: Workflow importieren

1. Öffne n8n: `https://n8n.juroct.net`
2. Klicke auf **"Import from File"**
3. Wähle `n8n-email-verteiler-workflow.json`
4. Klicke auf **"Import"**

### Schritt 2: E-Mail-Konfiguration anpassen

Im Node **"Send Email"** (Node 6):

```javascript
"fromEmail": "noreply@juroct.net"  // ← Deine Absender-E-Mail
```

**Wichtig**: Die E-Mail muss in n8n als SMTP-Konto konfiguriert sein!

### Schritt 3: Workflow aktivieren

1. Klicke auf den **Toggle** oben rechts
2. Status sollte **"Active"** sein (grün)
3. Notiere die Webhook-URL: `https://n8n.juroct.net/webhook/stweg3-email-verteiler`

### Schritt 4: Webhook testen

```bash
curl -X POST https://n8n.juroct.net/webhook/stweg3-email-verteiler \
  -H "Content-Type: application/json" \
  -d '{
    "verteiler": "eigentuemer",
    "subject": "Test E-Mail",
    "message": "Dies ist eine Test-Nachricht",
    "sender_email": "test@example.com",
    "sender_name": "Test User"
  }'
```

**Erwartete Antwort**:
```json
{
  "success": true,
  "message": "E-Mail wurde an Eigentümer-Verteiler versendet",
  "recipients_count": 9,
  "verteiler": "eigentuemer"
}
```

## Workflow-Ablauf im Detail

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Webhook empfängt POST Request                               │
│     Input: verteiler, subject, message, sender_email            │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. Validate Input                                              │
│     Prüft ob alle erforderlichen Felder vorhanden sind          │
│     ✓ verteiler exists                                          │
│     ✓ subject exists                                            │
│     ✓ message exists                                            │
│     ✓ sender_email exists                                       │
└─────────────────────────┬───────────────────────────────────────┘
                          │
         ┌────────────────┴────────────────┐
         │                                  │
         ▼                                  ▼
┌─────────────────────┐          ┌─────────────────────┐
│  3a. Fetch          │          │  3b. Fetch          │
│  verteiler.json     │          │  kontakte.json      │
│  (GitHub Pages)     │          │  (GitHub Pages)     │
└──────────┬──────────┘          └──────────┬──────────┘
           │                                  │
           └────────────────┬─────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. Process Verteiler (Code Node)                               │
│     • Validiert Verteiler-ID (eigentuemer/ausschuss/alle)       │
│     • Sammelt E-Mail-Adressen basierend auf Verteiler:          │
│       - eigentuemer: Alle Eigentümer aus kontakte.json          │
│       - ausschuss: Alle Ausschussmitglieder                     │
│       - alle: Eigentümer + berechtigte Mieter                   │
│     • Entfernt Duplikate                                        │
│     • Erstellt einen Output pro Empfänger                       │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. Send Email (Loop über alle Empfänger)                       │
│     Für jeden Empfänger:                                        │
│     • Personalisierte E-Mail mit HTML-Template                  │
│     • Absenderinfo wird eingefügt                               │
│     • Verteiler-Name wird angezeigt                             │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  6. Success Response                                            │
│     Gibt zurück:                                                │
│     • success: true                                             │
│     • recipients_count: Anzahl der Empfänger                    │
│     • verteiler: Name des Verteilers                            │
└─────────────────────────────────────────────────────────────────┘
```

## E-Mail Template

Die E-Mails werden mit folgendem HTML-Template versendet:

**Features**:
- 🎨 Responsive Design
- 📱 Mobile-optimiert
- 🏢 STWEG 3 Branding (orange Gradient)
- 👤 Absenderinfo sichtbar
- 📋 Verteiler-Name angezeigt

**Beispiel**:
```
┌─────────────────────────────────────────┐
│  📧 Eigentümer-Verteiler                │
│  STWEG 3 - Rosenweg 9                   │
├─────────────────────────────────────────┤
│  Hallo Max Mustermann,                  │
│                                         │
│  📨 Nachricht über: Eigentümer-Verteiler│
│                                         │
│  ┌───────────────────────────────────┐ │
│  │ Ihre Nachricht hier...            │ │
│  └───────────────────────────────────┘ │
│                                         │
│  Gesendet von: Stefan Meier            │
│  E-Mail: stefan@example.com            │
└─────────────────────────────────────────┘
```

## Webseite Integration

### Link zur E-Mail-Verteiler Seite hinzufügen

In `index.html` oder anderen Seiten:

```html
<a href="email-verteiler.html"
   class="bg-orange-600 text-white px-6 py-3 rounded-lg hover:bg-orange-700">
    📧 E-Mail an Verteiler senden
</a>
```

### Direktlink mit vorausgewähltem Verteiler

```html
<!-- Link für Eigentümer-Verteiler -->
<a href="email-verteiler.html?verteiler=eigentuemer">
    📋 E-Mail an alle Eigentümer
</a>

<!-- Link für Ausschuss -->
<a href="email-verteiler.html?verteiler=ausschuss">
    ⭐ E-Mail an Ausschuss
</a>
```

## Sicherheit

### Authentifizierung
- ✅ OTP-basierte Authentifizierung (6-stelliger Code)
- ✅ Nur berechtigte E-Mails können sich anmelden
- ✅ Code gültig für 10 Minuten

### Berechtigungsprüfung
- ✅ Clientseitig: Nur berechtigte E-Mails bekommen OTP
- ⚠️ **Wichtig**: Serverseitige Prüfung im n8n Workflow fehlt noch!

### Empfohlene Erweiterung (optional)

Füge im n8n Workflow nach "Validate Input" eine Berechtigungsprüfung hinzu:

```javascript
// In Code Node nach Validate Input
const senderEmail = $json.body.sender_email.toLowerCase();
const kontakteData = await fetch('https://rosenweg.github.io/Website/stweg3/kontakte.json');

// Prüfe ob Absender berechtigt ist
const isBerechtig = checkIfAuthorized(senderEmail, kontakteData);

if (!isBerechtig) {
  throw new Error('Absender ist nicht berechtigt');
}
```

## Fehlerbehebung

### Problem: "Webhook not found"
**Lösung**: Prüfe ob der Workflow aktiviert ist

### Problem: "No recipients found"
**Lösung**:
- Prüfe ob `kontakte.json` korrekt strukturiert ist
- Prüfe ob E-Mail-Adressen in den Wohnungen eingetragen sind

### Problem: E-Mails kommen nicht an
**Lösung**:
- Prüfe SMTP-Konfiguration in n8n
- Prüfe Spam-Ordner der Empfänger
- Prüfe `fromEmail` im Send Email Node

### Problem: "Invalid verteiler"
**Lösung**: Nur diese Verteiler sind erlaubt:
- `eigentuemer`
- `ausschuss`
- `alle`

## Kosten & Performance

**n8n Workflow**:
- 1 Webhook-Call pro E-Mail-Versand
- 2 HTTP-Requests (verteiler.json + kontakte.json)
- N E-Mail-Versendungen (N = Anzahl Empfänger)

**Beispiel**: E-Mail an alle 9 Eigentümer:
- 1 Webhook + 2 HTTP + 9 E-Mails = **12 n8n Operations**

**Optimierung**:
- verteiler.json und kontakte.json könnten gecached werden
- E-Mails könnten als BCC versendet werden (aber weniger personalisiert)

## Zukünftige Erweiterungen

- [ ] Dateianhänge unterstützen
- [ ] E-Mail-Vorlagen speichern
- [ ] Versandhistorie anzeigen
- [ ] Geplanter Versand (z.B. morgen um 10:00)
- [ ] E-Mail-Vorschau vor dem Senden
- [ ] CC/BCC Optionen
- [ ] Antwort-auf-E-Mail setzen
- [ ] Push-Benachrichtigung bei neuer E-Mail
