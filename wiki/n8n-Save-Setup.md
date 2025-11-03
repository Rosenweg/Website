# n8n Save-Setup

Setup-Anleitung für den n8n Workflow, der JSON-Änderungen via GitHub API speichert.

## 📋 Übersicht

Der Save-Workflow ermöglicht es dem [Admin-Bereich](STWEG3-Admin), Änderungen an `kontakte.json` direkt ins GitHub Repository zu committen.

**Workflow-Funktion:**
- Empfängt JSON-Daten vom Admin-Bereich
- Validiert die Daten
- Holt aktuelle Version von GitHub (SHA)
- Committed neue Version ins Repository
- Erstellt Audit-Trail mit E-Mail-Adresse

## ⚠️ Voraussetzungen

Dieser Workflow funktioniert nur, wenn:
- ✅ Repository auf GitHub gehostet ist
- ✅ GitHub Personal Access Token verfügbar
- ✅ n8n Instanz läuft

**Alternative für andere Hosting-Lösungen** findest du unten.

## 🚀 Installation

### 1. Workflow importieren

1. Öffne n8n: `https://n8n.juroct.net`
2. Gehe zu **Workflows** → **Import from File**
3. Wähle `stweg3/n8n-save-workflow.json`
4. Workflow wird als **"STWEG3 Save JSON"** importiert

### 2. GitHub Token erstellen

#### Token generieren

1. Gehe zu GitHub → **Settings** → **Developer settings**
2. Klicke auf **Personal access tokens** → **Tokens (classic)**
3. Klicke auf **Generate new token (classic)**
4. Konfiguration:
   - **Note**: `n8n STWEG3 Save`
   - **Expiration**: `No expiration` (oder 1 Jahr)
   - **Scopes**: Wähle:
     - ☑️ **repo** (Full control of private repositories)

5. Klicke auf **Generate token**
6. **⚠️ WICHTIG**: Kopiere den Token SOFORT!
   - Format: `ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
   - Wird nur einmal angezeigt!

#### Token in n8n speichern

**Option A: Environment Variables** (empfohlen)

1. In n8n, gehe zu **Settings** → **Variables**
2. Füge hinzu:

| Name | Value |
|------|-------|
| `GITHUB_TOKEN` | `ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `GITHUB_API_URL` | `https://api.github.com/repos/IHR_USERNAME/IHR_REPO/contents/stweg3/kontakte.json` |

**Option B: Direkt im Workflow**

1. Öffne den Workflow
2. Bearbeite jeden "HTTP Request" Node
3. Füge den Token im Header hinzu:
   ```
   Authorization: Bearer ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

### 3. Workflow anpassen

1. Öffne den Workflow in n8n
2. Finde alle **HTTP Request** Nodes
3. Ersetze in der URL:
   - `YOUR_USERNAME` → Dein GitHub Username
   - `YOUR_REPO` → Repository-Name (z.B. `Rosenweg`)

**Beispiel:**
```
https://api.github.com/repos/stefan/Rosenweg/contents/stweg3/kontakte.json
```

### 4. Workflow aktivieren

1. Teste den Workflow mit "Execute Workflow"
2. Klicke auf **Activate** Toggle ✅
3. Webhook ist nun erreichbar:
   ```
   https://n8n.juroct.net/webhook/stweg3-save-json
   ```

## 📊 Workflow-Struktur

```
┌─────────────────┐
│  1. Webhook     │  POST /stweg3-save-json
│  (Trigger)      │  Body: {email, data}
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. Validate     │  • Email vorhanden?
│    Input        │  • Data vorhanden?
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌─────┐   ┌──────────┐
│Error│   │3. Get    │  GitHub API: GET
│ 400 │   │ Current  │  (hole SHA)
└─────┘   │   File   │
          └────┬─────┘
               │
               ▼
         ┌──────────┐
         │4. Update │  GitHub API: PUT
         │   File   │  (commit)
         └────┬─────┘
              │
              ▼
         ┌──────────┐
         │5. Success│  {success: true,
         │ Response │   commit: sha}
         └──────────┘
```

### Node-Details

#### 1. Webhook (Trigger)
- **Path**: `/stweg3-save-json`
- **Method**: POST
- **CORS**: Alle Origins (`*`)
- **Body**:
  ```json
  {
    "email": "admin@example.ch",
    "data": { /* komplettes JSON */ }
  }
  ```

#### 2. Validate Input
Prüft:
- ✅ `email` ist nicht leer
- ✅ `data` ist nicht leer

#### 3. Get Current File
- **GitHub API**: `GET /repos/:owner/:repo/contents/:path`
- **Zweck**: Hole `sha` der aktuellen Datei
- **Notwendig**: GitHub verlangt SHA für Updates

#### 4. Update File
- **GitHub API**: `PUT /repos/:owner/:repo/contents/:path`
- **Body**:
  ```json
  {
    "message": "Update kontakte.json via Admin (by user@example.ch)",
    "content": "BASE64_ENCODED_JSON",
    "sha": "SHA_FROM_STEP_3"
  }
  ```
- **Encoding**: JSON wird Base64-codiert

#### 5. Success Response
```json
{
  "success": true,
  "message": "Datei erfolgreich gespeichert",
  "commit": "abc123..."
}
```

## 🧪 Testing

### Manueller Test via curl

```bash
curl -X POST https://n8n.juroct.net/webhook/stweg3-save-json \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.ch",
    "data": {
      "stweg": {"nummer": 3},
      "ausschuss": []
    }
  }'
```

### Test über Admin-Bereich

1. Öffne [Admin-Bereich](https://rosenweg4303.ch/stweg3/admin.html)
2. Authentifiziere dich
3. Mache eine kleine Änderung
4. Klicke auf "JSON speichern"
5. Prüfe GitHub für neuen Commit

### n8n Execution prüfen

1. Öffne Workflow in n8n
2. Klicke auf **Executions**
3. Siehe letzte Ausführungen
4. Bei Fehler: Klicke auf Execution für Details

## 🚨 Troubleshooting

### "Fehler beim Speichern"

**Überprüfe GitHub Token:**

1. Gehe zu GitHub → Settings → Developer settings → Tokens
2. Prüfe, ob Token noch gültig ist
3. Prüfe Scope: **repo** muss aktiviert sein
4. Bei Ablauf: Erstelle neuen Token

**Überprüfe n8n Variables:**

```bash
# In n8n Settings → Variables prüfen:
GITHUB_TOKEN = ghp_xxxxx...
GITHUB_API_URL = https://api.github.com/repos/...
```

**Überprüfe Workflow URL:**

- URL muss genau deinem Repository entsprechen
- Format: `https://api.github.com/repos/USERNAME/REPO/contents/PATH`

### "400 Bad Request"

**Ursache**: Ungültige Anfrage

**Prüfe**:
- Sind `email` und `data` im Body?
- Ist JSON valid?

### "403 Forbidden"

**Ursache**: Token ungültig oder keine Berechtigung

**Lösung**:
1. Erstelle neuen Token mit `repo` Scope
2. Aktualisiere `GITHUB_TOKEN` in n8n

### "404 Not Found"

**Ursache**: Datei oder Repository nicht gefunden

**Lösung**:
1. Prüfe URL in HTTP Request Nodes
2. Stelle sicher, dass `stweg3/kontakte.json` existiert
3. Prüfe Schreibweise (Groß-/Kleinschreibung!)

### "409 Conflict"

**Ursache**: SHA stimmt nicht überein (Datei wurde zwischenzeitlich geändert)

**Lösung**:
- Erneut versuchen
- Workflow holt automatisch neuen SHA

## 🔒 Sicherheit

### Commit-Message

Jeder Commit enthält die E-Mail des Admins:

```
Update kontakte.json via Admin (by stefan+rosenweg@juroct.ch)
```

**Audit-Trail:**
- Wer hat geändert? → E-Mail-Adresse
- Wann? → Commit-Zeitstempel
- Was? → Git-Diff

### Token-Sicherheit

⚠️ **GitHub Token ist sensibel!**

- Speichere Token in **Environment Variables**
- NICHT im Code hardcoden
- NICHT ins Repository committen
- Regelmäßig erneuern (z.B. jährlich)

### Berechtigung

Nur Ausschussvertreter haben Zugriff auf Admin-Bereich:
- Frontend prüft E-Mail gegen `kontakte.json` > `ausschuss`
- Backend speichert ohne weitere Prüfung
- Vertraue auf Frontend-Validierung

## 🔄 Alternativen

Falls du kein GitHub verwendest:

### Option 1: PHP Backend

```php
<?php
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
        return res.status(400).json({
            success: false,
            error: 'Email und Daten erforderlich'
        });
    }

    fs.writeFileSync('kontakte.json', JSON.stringify(data, null, 2));

    res.json({ success: true, message: 'Gespeichert' });
});

app.listen(3000);
```

### Option 3: Direct File Write (lokal)

Für lokales Hosting kannst du auch direkt schreiben:

```javascript
// Ersetze in admin.html:
async function saveJSON() {
    // Direkt im Browser speichern (Download)
    const blob = new Blob([JSON.stringify(kontakteData, null, 2)],
                          { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kontakte.json';
    a.click();
}
```

## 📚 Weiterführende Links

- **[STWEG3 Admin](STWEG3-Admin)** - Admin-Bereich Anleitung
- **[n8n OTP-Setup](n8n-OTP-Setup)** - OTP E-Mail Setup
- **[GitHub API Docs](https://docs.github.com/en/rest)** - Offizielle API-Dokumentation

## 📞 Support

Bei Problemen:

**Technischer Dienst Rosenweg**
- Stefan Müller
- E-Mail: stefan+rosenweg@juroct.ch
- Telefon: +41 76 519 99 70
