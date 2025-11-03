# STWEG 3 Admin-Bereich

Anleitung für Ausschussvertreter zum Bearbeiten der Kontaktdaten.

## 🎯 Übersicht

Der Admin-Bereich ermöglicht es Ausschussvertretern der STWEG 3, Kontaktdaten direkt über die Website zu bearbeiten.

**URL**: https://rosenweg4303.ch/stweg3/admin.html

**Berechtigung**: Nur für Ausschussvertreter (E-Mail muss in `kontakte.json` > `ausschuss` sein)

## 🔐 Zugriff

### Schritt 1: Anmelden

1. Öffne [admin.html](https://rosenweg4303.ch/stweg3/admin.html)
2. Gib deine **Ausschuss-E-Mail-Adresse** ein
3. Klicke auf "Zugangscode per E-Mail senden"
4. Prüfe dein E-Mail-Postfach (auch Spam-Ordner!)

### Schritt 2: OTP eingeben

1. Gib den **6-stelligen Code** aus der E-Mail ein
2. Code ist **10 Minuten** gültig
3. Klicke auf "Code bestätigen"
4. Du wirst zum Editor weitergeleitet

## ✏️ Daten bearbeiten

Du hast zwei Möglichkeiten, Daten zu bearbeiten:

### Option A: Benutzerfreundlicher Editor (empfohlen)

Ideal für schnelle Änderungen einzelner Wohnungen.

#### 1. Wohnung auswählen

- Alle Wohnungen werden als Karten angezeigt
- Klicke auf eine Wohnung, um sie zu bearbeiten

#### 2. Formular ausfüllen

Das Formular zeigt dir:

**Eigentümer**:
- Name
- E-Mail
- Telefon

**Mieter** (falls vorhanden):
- Name
- E-Mail
- Telefon
- ☑️ Berechtigung für Kontaktliste

#### 3. Speichern

1. Klicke auf "Änderungen speichern"
2. Änderungen werden im JSON-Editor übernommen
3. **Wichtig**: Klicke anschließend auf "JSON speichern"!

### Option B: JSON direkt bearbeiten

Für erfahrene Benutzer oder komplexe Änderungen.

#### 1. Editor öffnen

- Klappe "🔧 Erweitert: JSON direkt bearbeiten" auf
- Das vollständige JSON wird angezeigt

#### 2. Bearbeiten

- Bearbeite das JSON direkt im Textfeld
- Nutze Monospace-Font für bessere Lesbarkeit

#### 3. Validieren

- Klicke auf "Validieren"
- Prüfe, ob "JSON ist gültig! ✓" erscheint
- Bei Fehlern: Fehlermeldung beachten und korrigieren

#### 4. Formatieren (optional)

- Klicke auf "Formatieren"
- JSON wird automatisch eingerückt

#### 5. Speichern

- Klicke auf "JSON speichern"
- Warte auf Bestätigung

## 📋 Was kann ich bearbeiten?

### Eigentümer-Daten

```json
"eigentümer": {
  "name": "Max Mustermann",
  "email": "max.mustermann@example.ch",
  "telefon": "+41 79 123 45 67",
  "typ": "eigentümer"
}
```

**Bearbeitbar**:
- ✅ Name
- ✅ E-Mail
- ✅ Telefon
- ❌ Typ (immer "eigentümer")

### Mieter-Daten

```json
"mieter": {
  "name": "Lisa Musterfrau",
  "email": "lisa.musterfrau@example.ch",
  "telefon": "+ 41 79 987 65 43",
  "typ": "mieter",
  "berechtigt": true
}
```

**Bearbeitbar**:
- ✅ Name
- ✅ E-Mail
- ✅ Telefon
- ✅ Berechtigt (true/false)
- ❌ Typ (immer "mieter")

**Wichtig bei "berechtigt"**:
- `true` = Mieter hat Zugriff auf Kontaktliste ✅
- `false` = Mieter hat KEINEN Zugriff ❌

### Keine Mieter

Falls keine Mieter in einer Wohnung:

```json
"mieter": null
```

## 🔒 Platzhalter-E-Mails

Für unbekannte Daten verwende **`.invalid` Domain**:

```json
{
  "name": "[Name Eigentümer]",
  "email": "eigentuemer-placeholder@beispiel.invalid",
  "telefon": "+41 79 XXX XX XX",
  "typ": "eigentümer"
}
```

**Warum `.invalid`?**
- RFC 2606: Reservierte Domain, nie routbar
- Verhindert versehentlichen E-Mail-Versand an Platzhalter
- Wird vom OTP-System automatisch gefiltert

**Beispiele**:
```
eigentuemer5@beispiel.invalid
mieter-eg1@beispiel.invalid
eigentuemer-hobby@beispiel.invalid
```

## ✅ Best Practices

### Vor dem Bearbeiten

- [ ] Stelle sicher, dass du die richtige Wohnung bearbeitest
- [ ] Prüfe die Daten auf Korrektheit
- [ ] Bei großen Änderungen: Kopiere JSON als Backup

### Beim Bearbeiten

- [ ] Verwende Editor für einfache Änderungen
- [ ] Verwende JSON-Editor nur bei komplexen Änderungen
- [ ] **Validiere JSON** vor dem Speichern!
- [ ] Platzhalter-E-Mails **müssen `.invalid` enden**
- [ ] Telefonnummern im Format `+41 XX XXX XX XX`

### Nach dem Speichern

- [ ] Warte auf Erfolgsmeldung
- [ ] Öffne Kontaktliste in neuem Tab und prüfe Änderungen
- [ ] Bei Fehlern: Seite neu laden und prüfen

## 🚨 Häufige Fehler

### "E-Mail nicht berechtigt"

**Problem**: Deine E-Mail ist nicht als Ausschussvertreter hinterlegt.

**Lösung**:
1. Prüfe, ob deine E-Mail in `kontakte.json` > `ausschuss` steht
2. Bei mehreren E-Mails (kommagetrennt) müssen alle einzeln geprüft werden
3. Kontaktiere technischen Dienst

### "OTP-Code abgelaufen"

**Problem**: Code ist älter als 10 Minuten.

**Lösung**:
1. Gehe zurück zu Schritt 1
2. Fordere neuen Code an

### "JSON-Fehler beim Speichern"

**Problem**: JSON ist ungültig.

**Lösung**:
1. Klicke auf "Validieren"
2. Lies Fehlermeldung genau
3. Häufige Fehler:
   - Fehlende Kommas `,`
   - Fehlende Anführungszeichen `"`
   - Fehlende geschweifte Klammern `{}`
4. Korrigiere Fehler
5. Validiere erneut

### "Fehler beim Speichern: ..."

**Problem**: Backend-Fehler (n8n oder GitHub API).

**Mögliche Ursachen**:
- n8n Workflow nicht aktiv
- GitHub Token ungültig
- Netzwerkfehler

**Lösung**:
1. Versuche es erneut
2. Prüfe Browser-Konsole (F12) für Details
3. Kontaktiere technischen Dienst

## 📊 Was passiert beim Speichern?

```
Admin-Seite
    ↓ POST
n8n Webhook
    ↓ Validierung
GitHub API: GET (hole aktuelle Version)
    ↓
GitHub API: PUT (speichere neue Version)
    ↓
Commit erstellt
    ↓ Success
Admin-Seite
```

### Commit-Message

Jede Änderung erstellt einen Git-Commit:

```
Update kontakte.json via Admin (by stefan+rosenweg@juroct.ch)
```

### Protokollierung

- **Wer**: E-Mail-Adresse wird protokolliert
- **Wann**: Zeitstempel automatisch
- **Was**: Git-Diff zeigt alle Änderungen

## 🔧 Technische Details

### Frontend
- Vanilla JavaScript (kein Framework)
- Tailwind CSS für Styling
- OTP-Validierung im Frontend

### Backend
- **n8n Workflow**: STWEG3 Save JSON
- **GitHub API**: Commits direkt ins Repository
- **Encoding**: Base64 (GitHub-Anforderung)

### Sicherheit
- **OTP-Authentifizierung**: 6-stellig, 10 Min. gültig
- **Berechtigungsprüfung**: Nur Ausschuss-E-Mails
- **Versionierung**: Alle Änderungen in Git
- **Audit-Trail**: Commit-Messages mit E-Mail

## 📚 Weiterführende Links

- **[n8n Save-Setup](n8n-Save-Setup)** - Backend konfigurieren
- **[Kontakte verwalten](Kontakte-Verwalten)** - Detaillierte Best Practices
- **[FAQ](FAQ)** - Häufige Fragen

## 📞 Support

Bei Problemen wende dich an:

**Technischer Dienst Rosenweg**
- Stefan Müller
- E-Mail: stefan+rosenweg@juroct.ch
- Telefon: +41 76 519 99 70
