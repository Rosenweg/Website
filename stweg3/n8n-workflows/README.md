# STWEG 3 n8n Workflows

Dieser Ordner enthält **STWEG 3-spezifische n8n Workflows**.

## Workflows

### 1. n8n-save-workflow.json
**Beschreibung**: Speichert kontakte.json auf dem Server

**Webhook-URL**: `https://n8n.juroct.net/webhook/stweg3-save`

**Funktion**:
- Empfängt neue kontakte.json Daten
- Speichert auf Server
- Benachrichtigt bei Erfolg/Fehler

**Verwendet von**: [admin.html](../admin.html)

---

### 2. n8n-otp-workflow.json
**Beschreibung**: OTP-Verifikation für Admin-Login

**Webhook-URLs**:
- Request: `https://n8n.juroct.net/webhook/stweg3-otp-request`
- Verify: `https://n8n.juroct.net/webhook/stweg3-otp-verify`

**Funktion**:
- Generiert 6-stelligen OTP-Code
- Versendet per E-Mail
- Verifiziert Code

**Verwendet von**: [admin.html](../admin.html)

---

### 3. n8n-verteiler-workflow.json
**Beschreibung**: E-Mail-Verteilerlisten-Management (veraltet)

**Status**: ⚠️ Veraltet - wurde durch generischen Email-Workflow ersetzt

**Hinweis**: Für neue Implementierungen den generischen Workflow verwenden:
`/n8n-workflows/generic-email.json`

---

### 4. n8n-email-verteiler-imap.json
**Beschreibung**: IMAP-basierter E-Mail-Verteiler

**Funktion**:
- Überwacht IMAP-Postfach
- Leitet E-Mails an Verteilerlisten weiter

**Verwendet für**: Email-Weiterleitung an Gruppen

---

### 5. n8n-reservations-workflow.json
**Beschreibung**: Waschküchen-Reservierungssystem

**Webhook-URLs**:
- Create: `https://n8n.juroct.net/webhook/stweg3-reservation-create`
- Delete: `https://n8n.juroct.net/webhook/stweg3-reservation-delete`
- List: `https://n8n.juroct.net/webhook/stweg3-reservation-list`

**Funktion**:
- Erstellt/Löscht Reservierungen
- Speichert in reservations.json
- Sendet Bestätigungs-E-Mails

**Verwendet von**:
- [waschkueche.html](../waschkueche.html)
- [waschkueche-admin.html](../waschkueche-admin.html)

## Installation

1. n8n öffnen
2. Workflow importieren: **Import from File**
3. Credentials konfigurieren (falls nötig)
4. Webhook-URLs prüfen
5. Workflow aktivieren

## Abhängigkeiten

### Generische Workflows
Einige STWEG3-Workflows nutzen generische Workflows:
- **E-Mail-Versand**: `/n8n-workflows/generic-email.json`

### Daten-Dateien
- [kontakte.json](../kontakte.json)
- [verteiler.json](../verteiler.json)
- [reservations.json](../reservations.json)

## Migration von veralteten Workflows

### Von n8n-verteiler-workflow.json zu generic-email.json

**Alt**:
```json
{
  "oldEmail": "...",
  "newEmail": "...",
  "type": "Eigentümer",
  ...
}
```

**Neu**:
```json
{
  "recipients": ["..."],
  "subject": "STWEG 3: Kontaktdaten aktualisiert",
  "htmlContent": "<html>...</html>"
}
```

## Siehe auch

- [Generische Workflows](/n8n-workflows/README.md)
- [Admin Tool Features](../ADMIN-TOOL-FEATURES.md)
- [Waschküche Setup](../WASCHKUECHE-README.md)
