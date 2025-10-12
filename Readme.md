# STWEG-Kooperation Rosenweg - Website

Moderne, responsive Website für die STWEG-Kooperation Rosenweg (STWEG 1-8) in 4303 Kaiseraugst, Aargau.

## 📋 Über die STWEG-Kooperation

Die STWEG-Kooperation Rosenweg ist ein Zusammenschluss von **8 eigenständigen Stockwerkeigentümergemeinschaften**:
- **STWEG 1-7**: Wohngebäude
- **STWEG 8**: Gemeinsame Tiefgarage

### Organisationsstruktur
- **Hauptversammlung**: Hauptorgan, tagt einmal jährlich mit allen 8 STWEGs
- **Ausschuss**: Tagt regelmäßig, besteht aus 2 Vertretern pro STWEG (16 Personen)
- **Verwaltung**: LangPartners Immobilien AG, Muttenz

## 📋 Inhalt

Diese Website enthält alle wichtigen Informationen für die STWEG-Kooperation:

- **Startseite** mit aktuellen Mitteilungen
- **Über die STWEG-Kooperation** mit Erklärung der 8 STWEGs
- **Organisation** (Hauptversammlung, Ausschuss, Verwaltung LangPartners)
- **Wichtige Informationen** (Abfallentsorgung, Hausordnung, Tiefgarage)
- **Termine & Veranstaltungen** (Hauptversammlung, Ausschusssitzungen)
- **Dokumente** (teilweise geschützter Bereich)
- **Kontaktformular**

## 🚀 GitHub Pages Deployment

### Schritt 1: Repository erstellen
1. Gehe zu [GitHub](https://github.com) und logge dich ein
2. Klicke auf "New repository" (oder das + Symbol oben rechts)
3. Nenne das Repository z.B. `stwe-rosenweg`
4. Wähle "Public" (für kostenlose GitHub Pages)
5. Klicke auf "Create repository"

### Schritt 2: Dateien hochladen
1. Auf der Repository-Seite klicke auf "uploading an existing file"
2. Lade die `index.html` hoch
3. Schreibe eine Commit-Nachricht (z.B. "Initial commit")
4. Klicke auf "Commit changes"

### Schritt 3: GitHub Pages aktivieren
1. Gehe zu "Settings" (in deinem Repository)
2. Klicke im linken Menü auf "Pages"
3. Unter "Source" wähle "main" Branch
4. Klicke auf "Save"
5. Nach ca. 1-2 Minuten ist deine Website unter `https://[dein-username].github.io/stwe-rosenweg/` erreichbar

## ✏️ Anpassungen vornehmen

Die Website enthält Platzhalter in eckigen Klammern `[...]`, die Sie anpassen sollten:

### STWEG-Informationen (Sektion "Über die STWEG-Kooperation")
- `[Jahr eintragen]` - Gründungsjahr der Kooperation

### Ausschuss-Vertreter (Sektion "Organisation & Verwaltung")
- Namen der 16 Ausschussmitglieder (2 pro STWEG)
- STWEG 1-7: je 2 Vertreter
- STWEG 8 (Tiefgarage): 2 Vertreter

### Hauswart (falls vorhanden)
- `[Name des Hauswarts]` - Name
- `[Telefonnummer]` - Kontakt
- `[Mobile]` - Mobile Nummer
- `[Zeiten eintragen]` - Erreichbarkeitszeiten

### Termine
- Hauptversammlung: Datum, Uhrzeit, Ort
- Ausschusssitzungen: Termine
- Wartungsarbeiten: Details
- Hausreinigung: Wochentag

## 🎨 Design-Features

- ✅ Vollständig responsive (funktioniert auf Desktop, Tablet, Smartphone)
- ✅ Moderne Tailwind CSS Gestaltung
- ✅ Smooth Scrolling Navigation
- ✅ Mobile-freundliches Menü
- ✅ Professionelles Farbschema (Blau/Grau)
- ✅ Barrierefreie Icons und Struktur

## 📍 Lokale Informationen

Die Website enthält bereits integrierte lokale Informationen:

- **Verwaltung**: LangPartners Immobilien AG, Kirchplatz 18, 4132 Muttenz
  - Tel: +41 61 228 18 18
  - E-Mail: hello@langpartners.ch
  - Website: langpartners.ch
- **Abfallentsorgung**: GAF Gemeindeverband (mit Sammeltagen)
- **Entsorgungsstelle**: REWAG Entsorgung AG, Kaiseraugst
- **Standort**: 4303 Kaiseraugst, Kanton Aargau
- Links zur Gemeinde und zum Abfallkalender

## 🔒 Geschützte Dokumente

Für geschützte Dokumente (Protokolle, Jahresabrechnungen, etc.) gibt es mehrere Optionen:

1. **GitHub Pages mit Passwort-geschützter Seite**: Erfordert zusätzliche JavaScript-Lösung
2. **Google Drive** mit beschränktem Zugriff und Links auf der Website
3. **Cloud-Lösung** (Dropbox, OneDrive) mit Passwortschutz
4. **Separater Login-Bereich**: Benötigt Backend-Lösung

Empfehlung: Für den Anfang können Sie Google Drive oder eine andere Cloud-Lösung nutzen und die Links in der Website aktualisieren.

## 📱 Kontaktformular

Das aktuelle Kontaktformular ist rein Frontend-basiert. Für funktionale E-Mail-Versendung benötigen Sie:

- **FormSpree** (kostenlos für begrenzte Anfragen): https://formspree.io
- **Netlify Forms** (wenn Sie zu Netlify wechseln): https://www.netlify.com
- **EmailJS** (kostenlos für begrenzte E-Mails): https://www.emailjs.com

## 🛠️ Wartung & Updates

Um die Website zu aktualisieren:
1. Bearbeite die `index.html` lokal
2. Gehe zu deinem GitHub Repository
3. Klicke auf die `index.html` Datei
4. Klicke auf das Stift-Symbol (Edit)
5. Füge deine Änderungen ein
6. Scrolle nach unten und klicke "Commit changes"

Alternativ kannst du auch GitHub Desktop verwenden für einfachere Updates.

## 📞 Support

Bei Fragen zur Website-Anpassung:
- HTML & Tailwind CSS Dokumentation: https://tailwindcss.com
- GitHub Pages Hilfe: https://pages.github.com

## 📄 Lizenz

Diese Website wurde für die Stockwerkeigentümerschaft Rosenweg erstellt. Freie Verwendung und Anpassung erlaubt.

---

**Erstellt:** Oktober 2025  
**Für:** STWEG-Kooperation Rosenweg (STWEG 1-8), Kaiseraugst  
**Verwaltung:** LangPartners Immobilien AG, Muttenz  
**Technologie:** HTML5, Tailwind CSS, Vanilla JavaScript  
**Hosting:** GitHub Pages ready
