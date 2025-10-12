# 📚 Detaillierte Anleitung: Website auf GitHub veröffentlichen

Diese Anleitung führt Sie Schritt für Schritt durch die Veröffentlichung der Website für die STWEG-Kooperation Rosenweg auf GitHub Pages.

## Über die STWEG-Kooperation Rosenweg

Die Website ist für die Kooperation von 8 eigenständigen STWEGs (STWEG 1-8) am Rosenweg in Kaiseraugst:
- **STWEG 1-7**: Wohngebäude
- **STWEG 8**: Gemeinsame Tiefgarage
- **Verwaltung**: LangPartners Immobilien AG, Muttenz

## ✅ Voraussetzungen

- Ein GitHub Account (kostenlos unter https://github.com/signup)
- Die Website-Dateien (index.html, README.md, .gitignore)

## 🚀 Schritt-für-Schritt Anleitung

### 1️⃣ GitHub Repository erstellen

1. Öffnen Sie https://github.com und loggen Sie sich ein
2. Klicken Sie oben rechts auf das **+** Symbol
3. Wählen Sie **"New repository"**
4. Füllen Sie die Felder aus:
   - **Repository name**: `stwe-rosenweg` (oder ein anderer Name Ihrer Wahl)
   - **Description** (optional): "Website für die Stockwerkeigentümerschaft Rosenweg"
   - Wählen Sie **"Public"** (wichtig für kostenlose GitHub Pages!)
   - ✅ Aktivieren Sie **"Add a README file"**
5. Klicken Sie auf **"Create repository"**

### 2️⃣ Dateien hochladen

**Methode 1: Über den Browser (einfach)**

1. Klicken Sie in Ihrem neuen Repository auf **"Add file"** → **"Upload files"**
2. Ziehen Sie alle drei Dateien in das Fenster:
   - `index.html`
   - `README.md`
   - `.gitignore`
3. Schreiben Sie unten eine Commit-Nachricht: `"Website hinzugefügt"`
4. Klicken Sie auf **"Commit changes"**

**Methode 2: Mit GitHub Desktop (empfohlen für regelmäßige Updates)**

1. Laden Sie GitHub Desktop herunter: https://desktop.github.com
2. Installieren und öffnen Sie die App
3. Melden Sie sich mit Ihrem GitHub-Account an
4. Klicken Sie auf **"Clone a repository"**
5. Wählen Sie Ihr Repository aus der Liste
6. Wählen Sie einen lokalen Ordner auf Ihrem Computer
7. Kopieren Sie die drei Dateien in diesen Ordner
8. In GitHub Desktop sehen Sie nun die Änderungen
9. Schreiben Sie eine Commit-Nachricht unten links: `"Website hinzugefügt"`
10. Klicken Sie auf **"Commit to main"**
11. Klicken Sie oben auf **"Push origin"**

### 3️⃣ GitHub Pages aktivieren

1. Gehen Sie in Ihrem Repository zu **"Settings"** (oben im Menü)
2. Klicken Sie links auf **"Pages"**
3. Unter **"Source"**:
   - Wählen Sie **"Deploy from a branch"**
   - Branch: **"main"**
   - Folder: **"/ (root)"**
4. Klicken Sie auf **"Save"**
5. Nach ca. 1-2 Minuten erscheint oben eine grüne Box mit der URL Ihrer Website:
   - Format: `https://[ihr-username].github.io/stwe-rosenweg/`

### 4️⃣ Website testen

1. Klicken Sie auf die angezeigte URL oder geben Sie sie im Browser ein
2. Ihre Website sollte nun online sein! 🎉

## ✏️ Website anpassen

### Inhalte bearbeiten

**Direkt auf GitHub (für kleine Änderungen):**

1. Gehen Sie zu Ihrem Repository
2. Klicken Sie auf die Datei `index.html`
3. Klicken Sie auf das **Stift-Symbol** (rechts oben)
4. Nehmen Sie Ihre Änderungen vor
5. Scrollen Sie nach unten
6. Schreiben Sie eine kurze Beschreibung der Änderung
7. Klicken Sie auf **"Commit changes"**
8. Nach 1-2 Minuten ist die Änderung online sichtbar

**Mit GitHub Desktop (für größere Änderungen):**

1. Öffnen Sie die lokale `index.html` Datei mit einem Editor (z.B. Visual Studio Code, Notepad++)
2. Nehmen Sie Ihre Änderungen vor
3. Speichern Sie die Datei
4. Öffnen Sie GitHub Desktop
5. Sie sehen die Änderungen automatisch
6. Schreiben Sie eine Commit-Nachricht
7. Klicken Sie auf **"Commit to main"**
8. Klicken Sie auf **"Push origin"**

### Was sollten Sie anpassen?

Suchen Sie in der `index.html` nach folgenden Platzhaltern und ersetzen Sie diese:

#### STWEG-Informationen
- `[Jahr eintragen]` → z.B. "1998" (Gründungsjahr der Kooperation)

#### Ausschuss-Vertreter
- `[Name Vertreter 1]` → z.B. "Max Mustermann"
- `[Name Vertreter 2]` → z.B. "Maria Muster"
- Namen für alle 8 STWEGs eintragen (je 2 Vertreter = 16 Personen total)

#### Hauswart
- `[Name des Hauswarts]` → z.B. "Hans Meier"
- `[Telefonnummer]` → z.B. "+41 61 123 45 67"
- `[Mobile]` → z.B. "+41 79 123 45 67"

#### Termine
- Hauptversammlung: Datum, Uhrzeit, Ort
- Ausschusssitzungen: Termine
- Wartungsarbeiten: Details
- Hausreinigung: Wochentag

## 📱 Funktionierendes Kontaktformular einrichten

Das Standard-Formular ist nur Design. Für echte E-Mail-Funktion:

### Option 1: FormSpree (Empfohlen, kostenlos)

1. Gehen Sie zu https://formspree.io
2. Registrieren Sie sich kostenlos
3. Erstellen Sie ein neues Formular
4. Kopieren Sie die Formular-Aktion-URL
5. In der `index.html`, Zeile 398, ändern Sie:
   ```html
   <form class="space-y-6">
   ```
   zu:
   ```html
   <form action="https://formspree.io/f/IHRE-FORMULAR-ID" method="POST" class="space-y-6">
   ```
6. Fügen Sie `name`-Attribute zu den Feldern hinzu:
   ```html
   <input type="text" name="name" ...>
   <input type="email" name="_replyto" ...>
   <input type="text" name="subject" ...>
   <textarea name="message" ...>
   ```

### Option 2: EmailJS

1. Gehen Sie zu https://www.emailjs.com
2. Registrieren Sie sich
3. Folgen Sie der Setup-Anleitung
4. Fügen Sie den EmailJS-Code zur Website hinzu

## 🔒 Geschützte Dokumente einbinden

### Empfohlene Lösung: Google Drive

1. Laden Sie Ihre Dokumente in Google Drive hoch
2. Für jedes Dokument:
   - Rechtsklick → **"Freigeben"**
   - **"Freigabelink abrufen"**
   - Setzen Sie die Berechtigung auf **"Jeder mit dem Link"** oder **"Bestimmte Personen"**
   - Kopieren Sie den Link
3. In der `index.html` ersetzen Sie die `#` bei den Dokumenten mit den echten Links:
   ```html
   <a href="https://drive.google.com/file/d/IHRE-DATEI-ID" class="text-blue-600 hover:underline text-sm">Download (PDF)</a>
   ```

### Alternative: Passwortschutz

Für einfachen Passwortschutz können Sie Tools wie:
- https://www.staticrypt.com (generiert passwortgeschützte HTML-Seiten)
- Oder separate Cloud-Lösung mit Passwort (Dropbox, OneDrive)

## 🎨 Design anpassen

### Farben ändern

Die Website nutzt hauptsächlich Blau. Um andere Farben zu verwenden, suchen Sie nach:
- `blue-600`, `blue-700`, `blue-800` → ersetzen mit z.B. `green-600`, `red-600`, etc.

Tailwind Farben: https://tailwindcss.com/docs/customizing-colors

### Logo hinzufügen

Ersetzen Sie in Zeile 19-21 das SVG-Icon mit Ihrem Logo:
```html
<img src="logo.png" alt="StWE Rosenweg" class="h-8">
```

## 📊 Website-Statistiken (optional)

Um zu sehen, wie viele Besucher Ihre Website hat:

1. **Google Analytics**: https://analytics.google.com
2. **Simple Analytics** (DSGVO-konform): https://simpleanalytics.com
3. **Plausible** (Open Source): https://plausible.io

## ❓ Häufige Probleme

### Website wird nicht angezeigt
- Warten Sie 2-3 Minuten nach Aktivierung von GitHub Pages
- Überprüfen Sie, ob das Repository auf "Public" gesetzt ist
- Stellen Sie sicher, dass die Datei `index.html` heißt (nicht Index.html oder index.HTML)

### Änderungen sind nicht sichtbar
- Leeren Sie den Browser-Cache (Strg+F5 oder Cmd+Shift+R)
- Warten Sie 1-2 Minuten nach dem Push

### Mobile Ansicht funktioniert nicht
- Die Website ist bereits responsive, testen Sie auf einem echten Gerät oder mit Browser-Entwicklertools (F12)

## 💡 Nützliche Links

- **GitHub Pages Dokumentation**: https://docs.github.com/pages
- **Tailwind CSS Dokumentation**: https://tailwindcss.com/docs
- **HTML Validator**: https://validator.w3.org
- **GitHub Desktop Download**: https://desktop.github.com
- **Visual Studio Code** (guter Code-Editor): https://code.visualstudio.com

## 📞 Weitere Hilfe

Bei technischen Fragen zur Website können Sie:
- Die GitHub Community konsultieren
- Auf Stack Overflow nach Lösungen suchen
- Einen Webentwickler kontaktieren

---

**Viel Erfolg mit Ihrer Website! 🎉**
