# Generische n8n Workflows

Dieser Ordner enthält **wiederverwendbare n8n Workflows**, die für alle STWEG-Projekte (STWEG 3, 4, 9) verwendet werden können.

## Workflows

### 1. generic-email.json
**Beschreibung**: Universeller E-Mail-Versand-Webhook

**Funktion**:
- Empfängt E-Mail-Daten per Webhook
- Versendet E-Mails mit beliebigem HTML-Content
- Unterstützt To, CC, BCC, Reply-To

**Webhook-URL**: `https://n8n.juroct.net/webhook/send-email`

**Verwendung**:
```json
{
  "recipients": ["email@example.com"],
  "subject": "Betreff",
  "htmlContent": "<html>...</html>",
  "cc": [],
  "bcc": [],
  "replyTo": "noreply@rosenweg4303.ch"
}
```

**Verwendet von**:
- STWEG 3: Kontaktdaten-Änderungen, Verteilerlisten-Updates
- STWEG 4: (geplant)
- STWEG 9: (geplant)

## Installation

1. n8n öffnen
2. Workflow importieren: **Import from File**
3. SMTP-Credentials konfigurieren
4. Workflow aktivieren

## SMTP-Konfiguration

Für alle Workflows wird ein SMTP-Account benötigt:
- **Host**: z.B. `smtp.gmail.com`
- **Port**: `587` (TLS)
- **User**: E-Mail-Adresse
- **Password**: App-Passwort
- **Secure**: TLS

## Vorteile generischer Workflows

✅ Einmal erstellen, überall nutzen
✅ Zentrale Wartung
✅ Konsistentes Verhalten
✅ Einfache Updates
