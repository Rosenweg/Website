# Admin-Bereich für STWEG 3

## Übersicht

Der Admin-Bereich ermöglicht es Ausschussvertretern, die Kontaktdaten der STWEG 3 direkt über die Website zu bearbeiten. Der Zugang ist durch OTP-Authentifizierung geschützt.

## Zugriff

- **URL**: `https://rosenweg4303.ch/stweg3/admin.html`
- **Berechtigung**: Nur Ausschussvertreter (E-Mails aus `kontakte.json` > `ausschuss`)
- **Authentifizierung**: OTP-Code per E-Mail (6-stellig, 10 Minuten gültig)

## Funktionen

### 1. Benutzerfreundlicher Editor

Der Editor bietet eine einfache Oberfläche zum Bearbeiten von Wohnungsdaten:

- **Wohnungsauswahl**: Alle Wohnungen werden als Karten angezeigt
- **Formular-basierte Bearbeitung**: Eingabefelder für:
  - Eigentümer (Name, E-Mail, Telefon)
  - Mieter (Name, E-Mail, Telefon, Berechtigung)
- **Automatische Metadaten**: Letzte Änderung wird automatisch aktualisiert

### 2. Erweiterter JSON-Editor

Für fortgeschrittene Benutzer:

- **Direkte JSON-Bearbeitung**: Vollständige Kontrolle über alle Daten
- **Formatierung**: Automatische JSON-Formatierung auf Knopfdruck
- **Validierung**: JSON-Syntax-Prüfung vor dem Speichern
- **Fehlerhinweise**: Detaillierte Fehlermeldungen bei ungültigem JSON

### 3. Speicherung

Die Änderungen werden über einen n8n Workflow gespeichert:

- **Webhook**: `https://n8n.juroct.net/webhook/stweg3-save-json`
- **Backend**: GitHub API (automatische Commits)
- **Sicherheit**: Änderungen werden mit E-Mail-Adresse protokolliert

## Setup

### 1. Admin-Seite bereitstellen

Die Datei `admin.html` muss im `stweg3/` Verzeichnis liegen:

```
stweg3/
├── index.html
├── stweg3-kontakte.html
├── admin.html              ← Admin-Seite
├── kontakte.json
└── ...
```

### 2. n8n Save-Workflow einrichten

#### Workflow importieren

1. Öffne n8n: `https://n8n.juroct.net`
2. Gehe zu **Workflows** → **Import from File**
3. Wähle `n8n-save-workflow.json`

#### GitHub-Token konfigurieren

Der Workflow benötigt einen GitHub Personal Access Token:

1. **GitHub Token erstellen**:
   - Gehe zu GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
   - Klicke auf "Generate new token (classic)"
   - Name: `n8n STWEG3 Save`
   - Scopes: `repo` (Full control of private repositories)
   - Klicke auf "Generate token"
   - **Kopiere den Token sofort** (wird nur einmal angezeigt!)

2. **Token in n8n speichern**:
   - In n8n, gehe zu **Settings** → **Variables** (oder Environment Variables)
   - Füge hinzu:
     - Name: `GITHUB_TOKEN`
     - Value: `ghp_xxxxxxxxxxxxxxxxxxxxx` (dein Token)
     - Name: `GITHUB_API_URL`
     - Value: `https://api.github.com/repos/IHR_USERNAME/IHR_REPO/contents/stweg3/kontakte.json`

3. **Workflow anpassen**:
   - Öffne den importierten Workflow
   - Ersetze in den HTTP Request Nodes:
     - `YOUR_USERNAME` → Dein GitHub Username
     - `YOUR_REPO` → Repository-Name (z.B. `Rosenweg/Website`)

4. **Workflow aktivieren**:
   - Klicke auf **Activate** Toggle oben rechts
   - Der Webhook ist nun unter `https://n8n.juroct.net/webhook/stweg3-save-json` erreichbar

#### Workflow-Struktur

```
1. Webhook (POST) → Empfängt email + data
2. Validate Input → Prüft, ob beide vorhanden
3. Get Current File → Holt SHA der aktuellen Datei von GitHub
4. Update File → Commitet neue Version
5. Success Response → Gibt Bestätigung zurück
```

## Nutzung

### Schritt 1: Anmelden

1. Öffne `admin.html`
2. Gib deine E-Mail-Adresse ein (muss in `kontakte.json` > `ausschuss` sein)
3. Klicke auf "Zugangscode per E-Mail senden"
4. Prüfe dein E-Mail-Postfach (auch Spam-Ordner)

### Schritt 2: OTP eingeben

1. Gib den 6-stelligen Code ein
2. Klicke auf "Code bestätigen"
3. Du wirst zum Editor weitergeleitet

### Schritt 3: Daten bearbeiten

#### Option A: Benutzerfreundlicher Editor

1. Wähle eine Wohnung aus der Liste
2. Bearbeite die Felder im Formular
3. Klicke auf "Änderungen speichern"
4. Die Änderungen werden im JSON-Editor übernommen
5. Klicke auf "JSON speichern", um dauerhaft zu speichern

#### Option B: JSON direkt bearbeiten

1. Öffne den erweiterten Editor ("🔧 Erweitert: JSON direkt bearbeiten")
2. Bearbeite das JSON direkt
3. Klicke auf "Validieren", um Syntax zu prüfen
4. Klicke auf "Formatieren", um das JSON zu formatieren
5. Klicke auf "JSON speichern"

### Schritt 4: Änderungen überprüfen

- Die Änderungen werden sofort in `kontakte.json` gespeichert
- Ein GitHub-Commit wird automatisch erstellt
- Die Commit-Message enthält deine E-Mail-Adresse
- Die Kontaktliste wird sofort aktualisiert

## Sicherheit

### OTP-Authentifizierung

- **Nur Ausschussvertreter**: E-Mail muss in `kontakte.json` > `ausschuss` sein
- **Zeitlimit**: OTP-Codes sind 10 Minuten gültig
- **Einmalverwendung**: Codes werden bei Verwendung ungültig (Frontend-seitig)

### Protokollierung

Jede Änderung wird in GitHub protokolliert:

- **Commit-Message**: `Update kontakte.json via Admin (by user@example.ch)`
- **Autor**: GitHub-Account (Token-Besitzer)
- **Zeitstempel**: Automatisch von GitHub
- **Änderungen**: In Git-History nachvollziehbar

### Validierung

- **Frontend-Validierung**: JSON-Syntax-Prüfung vor dem Senden
- **Backend-Validierung**: n8n prüft, ob `email` und `data` vorhanden sind
- **GitHub-Validierung**: GitHub prüft, ob Token berechtigt ist

## Fehlerbehandlung

### "E-Mail nicht berechtigt"

**Problem**: Deine E-Mail ist nicht als Ausschussvertreter hinterlegt.

**Lösung**:
1. Prüfe, ob deine E-Mail in `kontakte.json` > `ausschuss` steht
2. Achte auf Groß-/Kleinschreibung (wird zu lowercase konvertiert)
3. Bei mehreren E-Mails (kommagetrennt) müssen alle einzeln geprüft werden

### "OTP-Code abgelaufen"

**Problem**: Der Code ist älter als 10 Minuten.

**Lösung**:
1. Gehe zurück zu Schritt 1
2. Fordere einen neuen Code an

### "JSON-Fehler beim Speichern"

**Problem**: Das JSON ist ungültig.

**Lösung**:
1. Klicke auf "Validieren"
2. Prüfe die Fehlermeldung
3. Korrigiere den Fehler
4. Klicke erneut auf "Validieren"
5. Erst wenn "JSON ist gültig! ✓" erscheint, speichern

### "Fehler beim Speichern: ..."

**Problem**: Der n8n Workflow oder GitHub API hat einen Fehler.

**Mögliche Ursachen**:
1. **n8n Workflow nicht aktiv**: Aktiviere den Workflow in n8n
2. **GitHub Token ungültig**: Erstelle einen neuen Token
3. **Keine Berechtigung**: Token benötigt `repo` Scope
4. **GitHub API-Limit erreicht**: Warte eine Stunde
5. **Netzwerkfehler**: Versuche es erneut

**Lösung**:
1. Prüfe die Browser-Konsole (F12) für Details
2. Prüfe n8n Workflow-Logs unter "Executions"
3. Kontaktiere den technischen Dienst

## Best Practices

### Vor dem Bearbeiten

- [ ] Prüfe, ob du die richtige Wohnung ausgewählt hast
- [ ] Stelle sicher, dass die Daten korrekt sind
- [ ] Bei großen Änderungen: Kopiere das JSON vorher (Backup)

### Beim Bearbeiten

- [ ] Verwende den benutzerfreundlichen Editor für einfache Änderungen
- [ ] Verwende den JSON-Editor nur bei komplexen Änderungen
- [ ] Validiere das JSON vor dem Speichern
- [ ] Prüfe Platzhalter-E-Mails (müssen `.invalid` enden)

### Nach dem Speichern

- [ ] Prüfe die Erfolgsmeldung
- [ ] Öffne die Kontaktliste in einem neuen Tab und prüfe die Änderungen
- [ ] Bei Fehlern: Lade die Seite neu und prüfe, ob Änderungen übernommen wurden

## JSON-Struktur

### Eigentümer

```json
"eigentümer": {
  "name": "Max Mustermann",
  "email": "max.mustermann@example.ch",
  "telefon": "+41 79 123 45 67",
  "typ": "eigentümer"
}
```

### Mieter

```json
"mieter": {
  "name": "Lisa Musterfrau",
  "email": "lisa.musterfrau@example.ch",
  "telefon": "+41 79 987 65 43",
  "typ": "mieter",
  "berechtigt": true  // oder false
}
```

**Wichtig**:
- `berechtigt: true` → Mieter hat Zugriff auf Kontaktliste
- `berechtigt: false` → Mieter hat KEINEN Zugriff
- `mieter: null` → Keine Mieter in dieser Wohnung

### Platzhalter

Für unbekannte Daten verwende `.invalid` Domain:

```json
{
  "name": "[Name Eigentümer]",
  "email": "eigentuemer-placeholder@beispiel.invalid",
  "telefon": "+41 79 XXX XX XX",
  "typ": "eigentümer"
}
```

**Warum `.invalid`?**
- RFC 2606: Reservierte TLD, nie routbar
- Verhindert versehentlichen E-Mail-Versand
- Wird vom OTP-System automatisch gefiltert

## Technische Details

### Frontend

- **Framework**: Vanilla JavaScript
- **Styling**: Tailwind CSS
- **Authentifizierung**: OTP (Frontend-generiert, 10 Min. gültig)
- **Editor**: Textarea mit Monospace-Font

### Backend

- **n8n Workflow**: `STWEG3 Save JSON`
- **API**: GitHub REST API v3
- **Methode**: `PUT /repos/:owner/:repo/contents/:path`
- **Encoding**: Base64 (required by GitHub)

### Datenfluss

```
Admin-Seite
    ↓ (POST)
n8n Webhook
    ↓ (Validate)
GitHub API: GET (hole SHA)
    ↓
GitHub API: PUT (update file)
    ↓
Commit erstellt
    ↓ (Success Response)
Admin-Seite
```

## Alternativen zum GitHub-Workflow

Falls GitHub Pages nicht verwendet wird oder ein anderes Backend gewünscht ist:

### Option 1: PHP Backend

```php
<?php
// save.php
header('Content-Type: application/json');

$email = $_POST['email'] ?? '';
$data = $_POST['data'] ?? '';

if (empty($email) || empty($data)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Email und Daten erforderlich']);
    exit;
}

// Validiere JSON
$json = json_decode($data);
if ($json === null) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Ungültiges JSON']);
    exit;
}

// Speichern
file_put_contents('kontakte.json', json_encode($json, JSON_PRETTY_PRINT));

echo json_encode(['success' => true, 'message' => 'Gespeichert']);
?>
```

### Option 2: Node.js Backend

```javascript
const express = require('express');
const fs = require('fs');
const app = express();

app.use(express.json());

app.post('/api/save', (req, res) => {
    const { email, data } = req.body;

    if (!email || !data) {
        return res.status(400).json({ success: false, error: 'Email und Daten erforderlich' });
    }

    fs.writeFileSync('kontakte.json', JSON.stringify(data, null, 2));
    res.json({ success: true, message: 'Gespeichert' });
});

app.listen(3000);
```

## Support

Bei Problemen wende dich an:

**Technischer Dienst Rosenweg**
- Stefan Müller
- E-Mail: stefan+rosenweg@juroct.ch
- Telefon: +41 76 519 99 70

## Changelog

### Version 1.0 (2025-11-04)
- ✨ Initiale Version
- ✨ OTP-Authentifizierung für Ausschussvertreter
- ✨ Benutzerfreundlicher Editor
- ✨ Erweiterter JSON-Editor
- ✨ n8n Integration mit GitHub API
- ✨ Automatische Protokollierung
