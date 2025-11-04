# E-Mail-Verteilerlisten System

## Übersicht

Das E-Mail-Verteilerlisten-System ermöglicht die dynamische Verwaltung von E-Mail-Verteilern für STWEG 3. Die Verteilerlisten werden automatisch aus `kontakte.json` generiert oder können manuell verwaltet werden.

## Dateien

### 1. `verteiler.json`
Die zentrale Konfigurationsdatei für alle E-Mail-Verteilerlisten.

**Struktur:**
```json
{
  "meta": {
    "letzte_aktualisierung": "2025-01-15T10:30:00Z",
    "generiert_von": "n8n-workflow",
    "version": "1.0"
  },
  "verteiler": [
    {
      "id": "eigentuemer",
      "name": "Eigentümer-Verteiler",
      "email": "eigentuemer@rosenweg9.ch",
      "beschreibung": "Alle Eigentümer von STWEG 3",
      "typ": "automatisch",
      "quelle": "kontakte.json",
      "filter": { "rolle": "eigentümer" },
      "mitglieder": []
    }
  ]
}
```

**Verteiler-Typen:**
- **`automatisch`**: Mitglieder werden automatisch aus `kontakte.json` generiert
- **`manuell`**: Mitglieder werden manuell in der JSON-Datei gepflegt

### 2. `stweg3-kontakte.html`
Die Kontaktlisten-Seite lädt und zeigt die Verteilerlisten an.

**Features:**
- Lädt `verteiler.json` beim Seitenaufruf
- Generiert automatische Verteilerlisten on-the-fly aus `kontakte.json`
- Fallback auf statische Anzeige, falls `verteiler.json` nicht verfügbar
- Zeigt Verteiler-Typ (Auto/Manuell) mit farbigen Badges an
- Responsive 2-Spalten-Layout für große Listen

### 3. `n8n-verteiler-workflow.json`
n8n Workflow zur automatischen Generierung von `verteiler.json`.

**Workflow-Schritte:**
1. **Webhook Trigger**: Ausgelöst bei Änderungen an `kontakte.json`
2. **Lade kontakte.json**: Holt die aktuelle Version von GitHub
3. **Generiere Verteiler-JSON**: Extrahiert Mitglieder aus Kontakten
4. **Update GitHub**: Schreibt `verteiler.json` zurück ins Repository
5. **Response**: Sendet Erfolgsbestätigung

## Automatische Verteilerlisten

Die folgenden Verteiler werden automatisch aus `kontakte.json` generiert:

### 1. Eigentümer-Verteiler (`eigentuemer@rosenweg9.ch`)
- **Quelle**: Alle `eigentümer` aus allen Wohnungen und Sonstigem
- **Mitglieder**: Name, E-Mail, Wohnung

### 2. Ausschuss-Verteiler (`ausschuss@rosenweg9.ch`)
- **Quelle**: Alle Einträge in `ausschuss`
- **Mitglieder**: Name, E-Mail, Wohnung, Funktion

### 3. Alle Bewohner (`alle@rosenweg9.ch`)
- **Quelle**: Alle Eigentümer + berechtigte Mieter (`berechtigt: true`)
- **Mitglieder**: Name, E-Mail, Wohnung

## Setup

### n8n Workflow einrichten

1. **Importiere `n8n-verteiler-workflow.json` in n8n**

2. **GitHub OAuth2 einrichten:**
   - Erstelle eine GitHub OAuth2 App
   - Füge die Credentials in n8n hinzu
   - Verknüpfe sie mit dem "Update verteiler.json auf GitHub" Node

3. **Webhook URL notieren:**
   - Die Webhook URL ist: `https://<n8n-domain>/webhook/stweg3-verteiler-update`

4. **GitHub Action erstellen (optional):**

Erstelle `.github/workflows/update-verteiler.yml`:

```yaml
name: Update Verteilerlisten

on:
  push:
    paths:
      - 'stweg3/kontakte.json'
    branches:
      - main

jobs:
  update-verteiler:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger n8n Workflow
        run: |
          curl -X POST https://n8n.juroct.net/webhook/stweg3-verteiler-update
```

### Manuelle Aktualisierung

Rufe einfach die Webhook URL auf:

```bash
curl -X POST https://n8n.juroct.net/webhook/stweg3-verteiler-update
```

## Manuelle Verteilerlisten

Du kannst auch manuelle Verteilerlisten in `verteiler.json` definieren:

```json
{
  "id": "custom-beispiel",
  "name": "Beispiel: Benutzerdefinierte Liste",
  "email": "beispiel@rosenweg9.ch",
  "beschreibung": "Benutzerdefinierte Verteilerliste",
  "typ": "manuell",
  "quelle": null,
  "filter": null,
  "mitglieder": [
    {
      "name": "Max Mustermann",
      "email": "max@beispiel.ch",
      "wohnung": "EG.1",
      "hinzugefuegt_am": "2025-01-10"
    }
  ]
}
```

## Admin-Tool Integration (Geplant)

In Zukunft wird das Admin-Tool erweitert, um Verteilerlisten zu verwalten:

- ✅ Ansicht aller Verteilerlisten
- ⏳ Erstellen neuer manueller Verteiler
- ⏳ Hinzufügen/Entfernen von Mitgliedern
- ⏳ Ändern von Verteiler-Eigenschaften (Name, Beschreibung)
- ⏳ Manuelles Triggern der Auto-Generierung

## Fehlerbehebung

### Problem: verteiler.json wird nicht geladen
- **Lösung**: Prüfe, ob die Datei im gleichen Verzeichnis wie `stweg3-kontakte.html` liegt
- **Fallback**: Die Seite zeigt automatisch die Standard-Verteiler (Eigentümer, Ausschuss) an

### Problem: Mitglieder fehlen in automatischen Verteilern
- **Lösung**: Prüfe `kontakte.json` auf korrekte Struktur
- **Tipp**: Triggere den n8n Workflow manuell neu

### Problem: GitHub Update schlägt fehl
- **Lösung**: Prüfe OAuth2 Credentials in n8n
- **Tipp**: Stelle sicher, dass der GitHub Token Schreibrechte hat

## Sicherheit

- **Zugriff**: Verteilerlisten sind nur nach OTP-Authentifizierung sichtbar
- **Berechtigungen**: Nur berechtigte E-Mails können die Kontaktliste öffnen
- **GitHub**: n8n benötigt Schreibrechte auf das Repository

## Roadmap

- [ ] Admin-Tool Integration für Verteiler-Verwaltung
- [ ] E-Mail-Validierung für manuelle Einträge
- [ ] Export-Funktion (CSV, VCF)
- [ ] Historisierung von Änderungen
- [ ] Benachrichtigungen bei Änderungen
