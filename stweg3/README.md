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
Die Hauptseite von STWEG 3 ist im Root-Verzeichnis:
- `../stweg3.html`

### Geschützte Kontaktliste
Die geschützte Kontaktliste ist nur nach E-Mail-Verifizierung zugänglich:
- `stweg3-kontakte.html`

## Struktur

```
stweg3/
├── README.md                    # Diese Datei
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

## Technische Details

### OTP-System
- 6-stelliger Code
- Gültig für 10 Minuten
- Versand via n8n Webhook
- Frontend-Validierung

### n8n Webhook
- URL: `https://n8n.juroct.net/webhook/stweg3-otp`
- Method: POST
- Body: `{"email": "...", "otp_code": "..."}`

## Support

Bei Problemen wende dich an:

**Technischer Dienst Rosenweg**
- Stefan Müller
- E-Mail: stefan+rosenweg@juroct.ch
- Telefon: +41 76 519 99 70
