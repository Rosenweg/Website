# STWEG 3 - Rosenweg 9

Webseite und Verwaltungstools für STWEG 3 (Rosenweg 9, 4303 Kaiseraugst)

## 📁 Ordnerstruktur

```
stweg3/
├── index.html              # Hauptseite (Einstiegspunkt)
├── pages/                  # Alle Webseiten
│   ├── admin.html         # Admin-Panel für Kontaktverwaltung
│   ├── stweg3-kontakte.html # Geschützte Kontaktliste
│   ├── waschkueche.html   # Waschküchen-Reservierung
│   └── ...                # Weitere Seiten
├── data/                   # JSON-Daten
│   ├── kontakte.json      # Kontaktdaten (Eigentümer, Mieter, Ausschuss)
│   ├── verteiler.json     # E-Mail-Verteilerlisten-Konfiguration
│   ├── reservations.json  # Waschküchen-Reservierungen
│   └── reservierungen.json # Alternative Reservierungsdaten
├── docs/                   # Dokumentation
│   ├── ADMIN-TOOL-FEATURES.md
│   ├── N8N_WORKFLOW_ANLEITUNG.md
│   └── ...
├── scripts/                # Python-Scripts
│   ├── create_n8n_workflow.py
│   ├── update_n8n_workflow.py
│   └── ...
├── tools/                  # Interne Tools
│   └── generate-verteilerlisten.html
├── email-templates/        # E-Mail-Templates (nicht direkt zugänglich)
│   ├── EMAIL_ALTE_ADRESSE.html
│   └── EMAIL_NEUE_ADRESSE.html
├── n8n-workflows/          # STWEG3-spezifische n8n Workflows
│   ├── n8n-save-workflow.json
│   ├── n8n-otp-workflow.json
│   └── ...
├── waschkueche-data/       # Waschküchen-Daten
├── waschkueche-smart/      # Smart-Home Integration
└── waschkueche-api.js      # Waschküchen-API

## 🌐 Öffentliche URLs

- **Hauptseite**: `https://rosenweg4303.ch/stweg3/`
- **Kontaktliste**: `https://rosenweg4303.ch/stweg3/pages/stweg3-kontakte.html`
- **Admin**: `https://rosenweg4303.ch/stweg3/pages/admin.html`
- **Waschküche**: `https://rosenweg4303.ch/stweg3/pages/waschkueche.html`

## 🔧 Hauptfunktionen

### 1. Kontaktverwaltung
- **Admin-Panel** (pages/admin.html): OTP-gesicherte Verwaltung der Kontaktdaten
- **Kontaktliste** (pages/stweg3-kontakte.html): Passwortgeschützte Ansicht aller Kontakte
- **Automatische Verteilerlisten**: Dynamisch generiert aus Kontaktdaten

### 2. Waschküchen-Reservierung
- Online-Buchungssystem für Waschmaschine
- Kalenderansicht
- E-Mail-Benachrichtigungen
- Admin-Verwaltung

### 3. E-Mail-Benachrichtigungen
- Automatische Benachrichtigungen bei Kontaktänderungen
- Verteilerlisten-Updates
- n8n-Integration

### 4. Solaranlage
- Live-Daten der Solaranlage (pages/solaranlage-live.html)

## 🔐 Authentifizierung

### Admin-Panel
- **OTP-basiert**: 6-stelliger Code per E-Mail
- Nur Ausschussmitglieder haben vollen Zugriff
- Eigentümer können nur eigene Daten ändern

### Kontaktliste
- **Passwort-geschützt**: Zugriff nur für berechtigte Eigentümer und Mieter
- Passwort wird bei Bedarf vom Ausschuss vergeben

## 📊 Datenstruktur

### kontakte.json
- **STWEG-Info**: Allgemeine Daten zur Stockwerkeigentümergemeinschaft
- **Wohnungen**: Eigentümer und Mieter pro Wohnung (3 Stockwerke)
- **Ausschuss**: Vertreter mit Funktionen und Berechtigungen
- **Verteilerlisten**: Automatisch generierte E-Mail-Listen
- **Metadaten**: Version, Änderungsdatum, etc.

## 🔄 n8n Workflows

### STWEG3-spezifische Workflows
- **save**: Speichert kontakte.json auf Server
- **otp**: OTP-Authentifizierung
- **reservations**: Waschküchen-Reservierungen
- **email-verteiler**: E-Mail-Weiterleitung (IMAP)

### Generische Workflows (siehe /n8n-workflows/)
- **generic-email**: Universeller E-Mail-Versand

## 🛠️ Entwicklung

### Pfad-Konventionen
- Alle HTML-Seiten in `pages/` referenzieren Daten mit `../data/`
- index.html (Root) verlinkt Seiten mit `pages/`
- E-Mail-Templates werden inline im Admin generiert

### Neue Seite hinzufügen
1. HTML-Datei in `pages/` erstellen
2. JSON-Pfade mit `../data/` referenzieren
3. Link in `index.html` hinzufügen

## 📝 Weitere Informationen

- [Admin Tool Features](docs/ADMIN-TOOL-FEATURES.md)
- [n8n Workflow Anleitung](docs/N8N_WORKFLOW_ANLEITUNG.md)
- [Waschküche Setup](docs/WASCHKUECHE-README.md)
- [E-Mail Verteiler Setup](docs/EMAIL-VERTEILER-SETUP.md)

## 📧 Kontakt

Bei Fragen: stweg3@rosenweg4303.ch
