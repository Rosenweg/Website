# Wiki auf GitHub einrichten

Diese Anleitung zeigt dir, wie du das GitHub Wiki für das STWEG Rosenweg Repository einrichtest.

## 📋 Voraussetzungen

- GitHub Repository existiert
- Du hast Admin-Rechte im Repository
- Git ist auf deinem Computer installiert

## 🚀 Schritt-für-Schritt-Anleitung

### 1. Wiki im Repository aktivieren

1. Gehe zu deinem GitHub Repository
2. Klicke auf **Settings** (Zahnrad-Icon)
3. Scrolle runter zu **Features**
4. Aktiviere **☑️ Wikis**
5. Klicke auf **Save**

### 2. Wiki klonen

Das Wiki ist ein eigenes Git-Repository:

```bash
# Format: https://github.com/USERNAME/REPO.wiki.git
git clone https://github.com/IHR_USERNAME/Rosenweg.wiki.git
cd Rosenweg.wiki
```

### 3. Wiki-Seiten kopieren

Kopiere alle `.md` Dateien aus `wiki/` in das geklonte Wiki-Repo:

```bash
# Aus dem Haupt-Repository
cp -r Website/Website/wiki/*.md ../Rosenweg.wiki/
```

### 4. Commit & Push

```bash
cd ../Rosenweg.wiki

# Alle Dateien hinzufügen
git add .

# Commit
git commit -m "Initial wiki setup with all documentation"

# Push zum GitHub Wiki
git push origin master
```

### 5. Verifizieren

1. Gehe zu deinem Repository auf GitHub
2. Klicke auf den **Wiki** Tab (oben)
3. Du solltest jetzt alle Seiten sehen!

## 📁 Wiki-Struktur

Nach dem Setup sollte das Wiki folgende Seiten haben:

```
Home.md                  → Startseite
_Sidebar.md              → Navigation (automatisch)
n8n-OTP-Setup.md         → n8n OTP Einrichtung
n8n-Save-Setup.md        → n8n Save Einrichtung
STWEG3-Admin.md          → Admin-Bereich Anleitung
STWEG3-Kontaktliste.md   → Kontaktliste Anleitung
Kontakte-Verwalten.md    → Best Practices
Architektur.md           → Technische Übersicht
Deployment.md            → Deployment-Anleitung
API-Referenz.md          → API-Dokumentation
FAQ.md                   → Häufige Fragen
```

## ✨ Spezielle Dateien

### `Home.md`
- Ist die Startseite des Wikis
- Wird bei Klick auf "Home" angezeigt
- Enthält Übersicht und Navigation

### `_Sidebar.md`
- Wird automatisch als Seitenleiste angezeigt
- Erscheint auf **jeder** Wiki-Seite
- Enthält Navigation zu allen Seiten

### `_Footer.md` (optional)
Falls du einen Footer möchtest:

```markdown
---
© 2025 STWEG-Kooperation Rosenweg | [Support](mailto:stefan+rosenweg@juroct.ch)
```

## 🔄 Änderungen am Wiki vornehmen

### Option 1: Direkt auf GitHub

1. Gehe zum Wiki
2. Klicke auf eine Seite
3. Klicke auf **Edit** (Stift-Icon)
4. Mache deine Änderungen
5. Klicke auf **Save Page**

### Option 2: Lokal bearbeiten

```bash
# Wiki klonen (falls noch nicht getan)
git clone https://github.com/IHR_USERNAME/Rosenweg.wiki.git
cd Rosenweg.wiki

# Datei bearbeiten
nano Home.md

# Commit & Push
git add Home.md
git commit -m "Update Home page"
git push origin master
```

## 🎨 Markdown-Tipps

### Interne Links

```markdown
[Link zu anderer Wiki-Seite](n8n-OTP-Setup)
```

### Externe Links

```markdown
[Link zur Website](https://rosenweg4303.ch)
```

### Bilder

```markdown
![Alt-Text](https://example.com/bild.png)
```

### Code-Blöcke

````markdown
```javascript
const code = "hier";
```
````

### Tabellen

```markdown
| Spalte 1 | Spalte 2 |
|----------|----------|
| Wert 1   | Wert 2   |
```

### Checklisten

```markdown
- [x] Erledigt
- [ ] Offen
```

### Emojis

```markdown
:white_check_mark: ✅
:warning: ⚠️
:rocket: 🚀
```

## 🔒 Wiki-Berechtigungen

### Öffentliche Repositories
- Wiki ist standardmäßig **öffentlich** lesbar
- Nur Collaborators können editieren

### Private Repositories
- Wiki ist nur für Repository-Mitglieder sichtbar

### Berechtigungen anpassen

1. Gehe zu **Settings** → **Manage access**
2. Füge Collaborators hinzu
3. Diese können dann das Wiki bearbeiten

## 📊 Wiki-Historie

Jede Änderung wird versioniert:

1. Gehe zu einer Wiki-Seite
2. Klicke auf **Page History** (Uhr-Icon)
3. Siehe alle Änderungen mit Autor und Zeitstempel
4. Klicke auf **View** für ältere Versionen
5. Klicke auf **Revert** zum Zurücksetzen

## 🔍 Wiki-Suche

GitHub bietet automatisch eine Suchfunktion:

1. Gehe zum Wiki
2. Nutze die Suchleiste oben rechts
3. Suche durchsucht alle Wiki-Seiten

## 💡 Best Practices

### Dateinamen
- Verwende **keine Leerzeichen**: `n8n-OTP-Setup.md` ✅ nicht `n8n OTP Setup.md` ❌
- PascalCase oder kebab-case: `STWEG3-Admin.md` ✅
- Dateiendung immer `.md`

### Struktur
- Nutze `_Sidebar.md` für konsistente Navigation
- Gruppiere verwandte Seiten
- Halte `Home.md` übersichtlich

### Inhalte
- Schreibe für deine Zielgruppe (Bewohner, Ausschuss, Entwickler)
- Verwende viele Beispiele
- Screenshots helfen oft mehr als Text
- Verlinke zwischen Seiten

### Wartung
- Halte Dokumentation aktuell
- Vermeide doppelte Informationen
- Archiviere veraltete Seiten (z.B. `Archive-Alte-Version.md`)

## 🚨 Troubleshooting

### "Wiki not found"
- Stelle sicher, dass Wikis aktiviert sind (Settings → Features)
- Erstelle mindestens eine Seite über die Web-UI

### Änderungen erscheinen nicht
- Warte ein paar Sekunden (GitHub braucht Zeit zum Rendern)
- Lösche Browser-Cache
- Prüfe, ob Push erfolgreich war (`git push`)

### Seitenleiste erscheint nicht
- Dateiname muss **exakt** `_Sidebar.md` sein (mit Underscore!)
- Groß-/Kleinschreibung beachten

### Bilder werden nicht angezeigt
- Nutze vollständige URLs: `https://...`
- Prüfe, ob Bild öffentlich zugänglich ist
- Alternative: Bilder ins Wiki-Repo legen

## 📚 Weiterführende Links

- [GitHub Wiki Dokumentation](https://docs.github.com/en/communities/documenting-your-project-with-wikis)
- [Markdown Guide](https://www.markdownguide.org/)
- [GitHub Flavored Markdown](https://github.github.com/gfm/)

## 📞 Support

Bei Problemen:

**Technischer Dienst Rosenweg**
- Stefan Müller
- E-Mail: stefan+rosenweg@juroct.ch
- Telefon: +41 76 519 99 70
