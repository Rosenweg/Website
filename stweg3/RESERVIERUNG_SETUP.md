# Waschküchen-Reservierungssystem Setup

## Übersicht

Das Waschküchen-Reservierungssystem für STWEG 3 ermöglicht es Bewohnern, online Zeitslots für die beiden Waschküchen zu reservieren. Das System ist mit OTP-Authentifizierung gesichert.

## Komponenten

### 1. Frontend
- **Datei**: `waschkueche-reservierung.html`
- **Features**:
  - OTP-Login mit E-Mail-Verifizierung
  - Wochenkalender zur Datumsauswahl
  - Zeitslot-Auswahl für beide Waschküchen
  - Übersicht eigener Reservierungen
  - Stornierungsfunktion

### 2. Backend (n8n)
- **Workflow**: `n8n-reservations-workflow.json`
- **Endpoints**:
  - `POST /stweg3-reservations?action=create` - Neue Reservierung erstellen
  - `POST /stweg3-reservations?action=list` - Reservierungen abrufen
  - `POST /stweg3-reservations?action=delete` - Reservierung löschen

### 3. Datenstruktur
- **Datei**: `reservations.json`
- Speichert alle Reservierungen, Waschküchen-Infos und Zeitslots

## Installation

### Schritt 1: n8n Workflows importieren

1. Importieren Sie beide Workflows in n8n:
   - `n8n-otp-workflow.json` (bereits vorhanden)
   - `n8n-reservations-workflow.json` (neu)

2. Konfigurieren Sie die SMTP-Credentials für E-Mail-Versand

3. Stellen Sie sicher, dass die Webhooks aktiv sind:
   - OTP: `https://n8n.juroct.net/webhook/stweg3-otp`
   - Reservierungen: `https://n8n.juroct.net/webhook/stweg3-reservations`

### Schritt 2: Datenspeicher einrichten

Für den n8n Workflow gibt es zwei Optionen:

#### Option A: Dateisystem (Einfach, für kleine Setups)

1. Erstellen Sie auf dem n8n Server das Verzeichnis:
   ```bash
   mkdir -p /data/stweg3
   ```

2. Kopieren Sie die `reservations.json` dorthin:
   ```bash
   cp reservations.json /data/stweg3/reservations.json
   chmod 644 /data/stweg3/reservations.json
   ```

#### Option B: Datenbank (Empfohlen für Production)

1. Ersetzen Sie die "Read/Write File" Nodes im n8n Workflow durch Datenbank-Nodes
2. Verwenden Sie z.B. PostgreSQL, MySQL oder MongoDB
3. Schema:
   ```sql
   CREATE TABLE reservations (
     id VARCHAR(50) PRIMARY KEY,
     waschkueche INT NOT NULL,
     date DATE NOT NULL,
     startTime TIME NOT NULL,
     endTime TIME NOT NULL,
     name VARCHAR(100) NOT NULL,
     email VARCHAR(255) NOT NULL,
     createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
     UNIQUE(waschkueche, date, startTime)
   );
   ```

### Schritt 3: Berechtigte E-Mail-Adressen

Fügen Sie die E-Mail-Adressen der berechtigten Bewohner zum OTP-System hinzu:

1. Öffnen Sie den OTP Workflow in n8n
2. Fügen Sie eine Validierungsnode hinzu, die prüft, ob die E-Mail berechtigt ist
3. Oder: Erstellen Sie eine Whitelist-Datei:
   ```json
   {
     "authorizedEmails": [
       "bewohner1@example.com",
       "bewohner2@example.com",
       "admin@stweg3.ch"
     ]
   }
   ```

### Schritt 4: Frontend anpassen

Falls Ihre n8n URLs anders sind, passen Sie in `waschkueche-reservierung.html` an:

```javascript
const OTP_API_URL = 'https://IHR-N8N-SERVER/webhook/stweg3-otp';
const RESERVATION_API_URL = 'https://IHR-N8N-SERVER/webhook/stweg3-reservations';
```

### Schritt 5: Testen

1. Öffnen Sie `https://rosenweg4303.ch/stweg3/waschkueche-reservierung.html`
2. Geben Sie eine berechtigte E-Mail-Adresse ein
3. Prüfen Sie, ob der OTP-Code per E-Mail ankommt
4. Loggen Sie sich ein und testen Sie eine Reservierung
5. Prüfen Sie, ob die Bestätigungs-E-Mail ankommt

## Sicherheit

### OTP-System
- 6-stellige Codes
- 10 Minuten Gültigkeit
- E-Mail-Verifizierung

### Zugriffskontrolle
- Nur berechtigte E-Mail-Adressen können sich anmelden
- Session-basierte Authentifizierung
- Jeder Benutzer kann nur seine eigenen Reservierungen löschen

### Best Practices
- ✓ HTTPS verwenden (bereits aktiviert über n8n.juroct.net)
- ✓ CORS richtig konfigurieren
- ✓ Rate Limiting auf dem n8n Server einrichten
- ✓ Regelmäßige Backups der Reservierungsdaten

## Wartung

### Reservierungen bereinigen

Alte Reservierungen sollten regelmäßig gelöscht werden:

1. Erstellen Sie einen n8n Cronjob, der täglich läuft
2. Löscht Reservierungen älter als 30 Tage
3. Beispiel-Code für n8n:
   ```javascript
   const data = JSON.parse($input.first().binary.data.toString());
   const thirtyDaysAgo = new Date();
   thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

   data.reservations = data.reservations.filter(r => {
     return new Date(r.date) >= thirtyDaysAgo;
   });

   return [{ json: { data: data } }];
   ```

### E-Mail Benachrichtigungen

Das System sendet automatisch E-Mails:
- ✉️ OTP-Code zur Anmeldung
- ✉️ Bestätigung nach Reservierung
- Optional: Erinnerung 1 Tag vor der Reservierung

### Monitoring

Überwachen Sie:
- Anzahl der Reservierungen pro Woche
- Auslastung der Waschküchen
- Fehlgeschlagene Login-Versuche
- E-Mail-Zustellungsfehler

## Anpassungen

### Zeitslots ändern

Bearbeiten Sie `reservations.json`:
```json
"timeSlots": [
  {
    "startTime": "07:00",
    "endTime": "10:00",
    "duration": 180
  },
  // Weitere Slots hinzufügen...
]
```

### Öffnungszeiten ändern

```json
"rules": {
  "openingDays": [1, 2, 3, 4, 5, 6],  // 0=Sonntag, 6=Samstag
  "closedDays": [0],  // Sonntags geschlossen
  "openingHours": "07:00-22:00"
}
```

### Farben und Design

Das Frontend verwendet TailwindCSS. Farben anpassen:
- Grün (Hauptfarbe): `green-600`, `green-700`, etc.
- Ändern Sie die Klassen in der HTML-Datei

## Support

Bei Fragen oder Problemen:
- **Technischer Dienst**: technik@rosenweg4303.ch
- **Admin STWEG 3**: admin@stweg3.ch

## Changelog

### Version 1.0 (2025-11-05)
- Initiales Release
- OTP-Authentifizierung
- Reservierungssystem für 2 Waschküchen
- E-Mail-Benachrichtigungen
- Mobile-responsive Design
