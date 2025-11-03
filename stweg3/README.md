# STWEG 3 - Rosenweg 9

Dieser Ordner enthält alle Dateien für die STWEG 3 (Stockwerkeigentümergemeinschaft 3) am Rosenweg 9 in Kaiseraugst.

## Dateien

### HTML & Daten
- **stweg3-kontakte.html** - Geschützte Kontaktliste mit OTP-Authentifizierung
- **kontakte.json** - JSON-Datenbank mit allen Bewohnern, Kontakten und berechtigten E-Mails

### n8n Integration
- **n8n-otp-workflow.json** - n8n Workflow für den E-Mail-Versand von OTP-Codes
- **N8N_SETUP.md** - Detaillierte Anleitung zur Einrichtung des n8n Workflows

## Zugriff

### Öffentliche Seite
Die Hauptseite von STWEG 3:
- `index.html` (in diesem Ordner)

### Geschützte Kontaktliste
Die geschützte Kontaktliste ist nur nach E-Mail-Verifizierung zugänglich:
- `stweg3-kontakte.html`

## Struktur

```
stweg3/
├── README.md                    # Diese Datei
├── index.html                  # Hauptseite STWEG 3
├── stweg3-kontakte.html        # Geschützte Kontaktseite
├── kontakte.json               # Kontaktdaten (berechtigte Nutzer)
├── n8n-otp-workflow.json       # n8n Workflow
└── N8N_SETUP.md                # Setup-Anleitung
```

## Berechtigungen

Zugriff auf die Kontaktliste haben:
- Alle Eigentümer (automatisch)
- Mieter mit expliziter Berechtigung (`"berechtigt": true` in kontakte.json)
- Ausschussvertreter (automatisch)
- Hausverwaltung: Alle E-Mails der Domain aus `hausverwaltung.email` (wird dynamisch extrahiert - z.B. @langpartners.ch)

## Technische Details

### OTP-System
- 6-stelliger Code
- Gültig für 10 Minuten
- Versand via n8n Webhook
- Frontend-Validierung
- **Backend-Filter**: `.invalid` E-Mails werden automatisch abgelehnt
- **Dynamische Hausverwaltungs-Berechtigung**: E-Mail-Domain wird automatisch aus `kontakte.json` extrahiert

### n8n Webhook
- URL: `https://n8n.juroct.net/webhook/stweg3-otp`
- Method: POST
- Body: `{"email": "...", "otp_code": "..."}`
- Filtert Platzhalter-E-Mails (`.invalid`) automatisch aus

### Platzhalter-E-Mails
Alle Platzhalter in `kontakte.json` verwenden `.invalid`:
- `eigentuemer5@beispiel.invalid`
- `mieter2@beispiel.invalid`
- `mieter6@beispiel.invalid`
- `eigentuemer-hobby@beispiel.invalid`

## Support

Bei Problemen wende dich an:

**Technischer Dienst Rosenweg**
- Stefan Müller
- E-Mail: stefan+rosenweg@juroct.ch
- Telefon: +41 76 519 99 70
