# STWEG-Kooperation Rosenweg - Website

Moderne, responsive Website für die STWEG-Kooperation Rosenweg (STWEG 1-8) in 4303 Kaiseraugst, Aargau.

## 📋 Über die STWEG-Kooperation

Die STWEG-Kooperation Rosenweg ist ein Zusammenschluss von **8 eigenständigen Stockwerkeigentümergemeinschaften**:
- **STWEG 1-7**: Wohngebäude
- **STWEG 8**: Gemeinsame Tiefgarage

### Organisationsstruktur
- **Hauptversammlung**: Hauptorgan, tagt einmal jährlich mit allen 8 STWEGs
- **Ausschuss**: Tagt regelmäßig, besteht aus 2 Vertretern pro STWEG 1-7 und 1 Vertreter für STWEG 8 (insgesamt 15 Personen)
- **Verwaltung**: LangPartners Immobilien AG, Muttenz

## 🆕 Neue Funktionen

### Dynamisches Laden der Ausschussmitglieder

Die Ausschussmitglieder werden jetzt automatisch aus der `ausschuss-kontakte.json` Datei geladen. Dies ermöglicht:
- ✅ Zentrale Verwaltung aller Kontaktdaten
- ✅ Einfache Aktualisierung ohne HTML-Kenntnisse
- ✅ Konsistenz über mehrere Seiten hinweg
- ✅ Automatische Anzeige mit korrekter Formatierung

**Implementierung**: Siehe `AUSSCHUSS_INTEGRATION.md` für Details

### STWEG 3 - Eigene Unterseite

STWEG 3 (Rosenweg 9) hat eine eigene dedizierte Seite:
- 9 Wohnungen detailliert beschrieben
- 2 Waschküchen mit Reservierungssystem
- 1 Hobbyraum
- Kontakte der Ausschussvertreter

**Datei**: `stweg3.html`

### Geschützte Kontaktliste für STWEG 3

Eine passwortgeschützte Seite mit allen Bewohnerkontakten:
- E-Mail-Verifizierung mit OTP (One-Time-Password)
- Zugriff nur für berechtigte Bewohner
- Daten werden aus `kontakte.json` geladen
- EmailJS-Integration für OTP-Versand

**Dateien**: 
- `stweg3-kontakte.html` - Die geschützte Seite
- `kontakte.json` - Bewohnerdaten für STWEG 3

**Setup**: Siehe `EMAILJS_SETUP.md` für Konfiguration

### Entsorgungsseite

Detaillierte Informationen zur Abfallentsorgung in Kaiseraugst:
- Eigene Container am Rosenweg
- Sammelstellen mit Google Maps Integration
- REWAG Recyclinghof Details
- Was gehört wohin? Übersicht

**Datei**: `entsorgung.html`

## 📁 Dateistruktur

```
stweg-rosenweg/
├── index.html                          # Hauptseite der Kooperation
├── stweg3.html                         # Unterseite für STWEG 3
├── stweg3-kontakte.html                # Geschützte Kontaktliste STWEG 3
├── entsorgung.html                     # Entsorgungsinformationen
├── ausschuss-kontakte.json             # Ausschussmitglieder aller STWEGs
├── kontakte.json                       # Bewohnerkontakte STWEG 3
├── .gitignore                          # Git-Ignore-Regeln
├── Readme.md                           # Diese Datei
├── ANLEITUNG.md                        # GitHub Pages Deployment
├── ORGANISATIONSSTRUKTUR.md            # Struktur der Kooperation
├── AUSSCHUSS_INTEGRATION.md            # Dynamisches Laden der Ausschussmitglieder
└── EMAILJS_SETUP.md                    # EmailJS Konfiguration (zu erstellen)
```

## 🚀 GitHub Pages Deployment

### Schritt 1: Repository erstellen
1. Gehe zu [GitHub](https://github.com) und logge dich ein
2. Klicke auf "New repository"
3. Nenne das Repository z.B. `stwe-rosenweg`
4. Wähle "Public" (für kostenlose GitHub Pages)
5. Klicke auf "Create repository"

### Schritt 2: Dateien hochladen
1. Auf der Repository-Seite klicke auf "uploading an existing file"
2. Lade **alle Dateien** hoch:
   - `index.html`
   - `stweg3.html`
   - `stweg3-kontakte.html`
   - `entsorgung.html`
   - `ausschuss-kontakte.json`
   - `kontakte.json`
   - Alle `.md` Dateien
3. Schreibe eine Commit-Nachricht (z.B. "Initial commit")
4. Klicke auf "Commit changes"

### Schritt 3: GitHub Pages aktivieren
1. Gehe zu "Settings" (in deinem Repository)
2. Klicke im linken Menü auf "Pages"
3. Unter "Source" wähle "main" Branch
4. Klicke auf "Save"
5. Nach ca. 1-2 Minuten ist deine Website unter `https://[dein-username].github.io/stwe-rosenweg/` erreichbar

## ✏️ Anpassungen vornehmen

### Ausschussmitglieder aktualisieren

**Datei**: `ausschuss-kontakte.json`

1. Öffne die Datei in einem Texteditor
2. Finde die entsprechende STWEG
3. Aktualisiere die Daten:

```json
{
  "funktion": "Vertreter 1",
  "anrede": "Herr",
  "vorname": "Max",
  "nachname": "Mustermann",
  "name_vollständig": "Max Mustermann",
  "haus_nr": "9",
  "telefon": "+41 79 123 45 67",
  "email": "max.mustermann@beispiel.ch"
}
```

4. Speichern und auf GitHub hochladen
5. Die Website aktualisiert sich automatisch beim nächsten Laden

### STWEG 3 Kontakte aktualisieren

**Datei**: `kontakte.json`

1. Öffne die Datei
2. Aktualisiere Eigentümer oder Mieter:

```json
{
  "bezeichnung": "EG.1",
  "zimmer": "3.5",
  "eigentümer": {
    "name": "Neuer Name",
    "email": "neue@email.ch",
    "telefon": "+41 79 999 99 99"
  }
}
```

3. Füge neue berechtigte E-Mails hinzu:

```json
"berechtigte_emails": [
  "bewohner1@beispiel.ch",
  "bewohner2@beispiel.ch"
]
```

### Platzhalter in index.html ersetzen

Suche in der `index.html` nach folgenden Platzhaltern:

#### STWEG-Informationen
- `[Jahr eintragen]` → z.B. "1998" (Gründungsjahr)

#### Hauswart (falls vorhanden)
- `[Name des Hauswarts]` → Name
- `[Telefonnummer]` → Kontakt
- `[Mobile]` → Mobile Nummer
- `[Zeiten eintragen]` → Erreichbarkeitszeiten

#### Termine
- Hauptversammlung: Datum, Uhrzeit, Ort
- Ausschusssitzungen: Termine
- Wartungsarbeiten: Details
- Hausreinigung: Wochentag

## 🎨 Design-Features

- ✅ Vollständig responsive (Desktop, Tablet, Smartphone)
- ✅ Moderne Tailwind CSS Gestaltung
- ✅ Smooth Scrolling Navigation
- ✅ Mobile-freundliches Menü
- ✅ Professionelles Farbschema (Blau/Grau/Grün)
- ✅ Barrierefreie Icons und Struktur
- ✅ Dynamisches Laden von Daten aus JSON
- ✅ Google Maps Integration (Entsorgungsseite)

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

1. **OTP-System** (wie bei STWEG 3 Kontakten): Erfordert EmailJS-Setup
2. **Google Drive** mit beschränktem Zugriff und Links auf der Website
3. **Cloud-Lösung** (Dropbox, OneDrive) mit Passwortschutz

Empfehlung: Für den Anfang Google Drive mit spezifischen Berechtigungen nutzen.

## 📱 Kontaktformular

Das aktuelle Kontaktformular auf der Hauptseite ist rein Frontend-basiert. Für funktionale E-Mail-Versendung:

- **FormSpree** (kostenlos für begrenzte Anfragen): https://formspree.io
- **Netlify Forms** (wenn Sie zu Netlify wechseln): https://www.netlify.com
- **EmailJS** (kostenlos für begrenzte E-Mails): https://www.emailjs.com

Die STWEG 3 Kontaktseite nutzt bereits EmailJS für OTP-Versand.

## 🔐 EmailJS Setup (für STWEG 3 Kontakte)

**Datei**: `stweg3-kontakte.html` (Zeilen 15-17)

Aktualisieren Sie folgende Werte:

```javascript
const EMAILJS_SERVICE_ID = 'service_qevit9e';      // Ihre Service ID
const EMAILJS_TEMPLATE_ID = 'template_uc5u3gi';     // Ihre Template ID
const EMAILJS_PUBLIC_KEY = 'DnHPrkTT61uco4ro4';     // Ihr Public Key
```

**Anleitung**:
1. Erstellen Sie ein Konto auf https://www.emailjs.com
2. Erstellen Sie einen Email Service (z.B. Gmail)
3. Erstellen Sie ein Email Template mit Variablen:
   - `{{to_email}}` - Empfänger E-Mail
   - `{{otp_code}}` - Der 6-stellige Code
   - `{{valid_minutes}}` - Gültigkeitsdauer
4. Kopieren Sie Service ID, Template ID und Public Key
5. Fügen Sie diese in die Datei ein

## 🛠️ Wartung & Updates

### Website aktualisieren via GitHub

1. Gehe zu deinem GitHub Repository
2. Klicke auf die Datei, die du bearbeiten möchtest
3. Klicke auf das Stift-Symbol (Edit)
4. Nimm deine Änderungen vor
5. Scrolle nach unten und klicke "Commit changes"

### Lokale Bearbeitung mit GitHub Desktop

1. Lade GitHub Desktop herunter: https://desktop.github.com
2. Clone dein Repository
3. Bearbeite die Dateien lokal
4. Committe und pushe die Änderungen

## 📊 Technologie-Stack

- **HTML5**: Semantisches HTML
- **Tailwind CSS**: Utility-first CSS Framework (via CDN)
- **Vanilla JavaScript**: Keine Frameworks, pure JS
- **JSON**: Datenstruktur für Kontakte
- **EmailJS**: E-Mail-Versand für OTP
- **GitHub Pages**: Kostenloses Hosting

## 🔍 Browser-Kompatibilität

Getestet und funktioniert in:
- ✅ Chrome/Edge (neueste Version)
- ✅ Firefox (neueste Version)
- ✅ Safari (neueste Version)
- ✅ Mobile Browser (iOS Safari, Chrome Mobile)

## 📞 Support

Bei technischen Fragen zur Website:
- **Tailwind CSS Dokumentation**: https://tailwindcss.com
- **GitHub Pages Hilfe**: https://pages.github.com
- **EmailJS Dokumentation**: https://www.emailjs.com/docs/

Bei Fragen zur Verwaltung:
- **LangPartners Immobilien AG**: +41 61 228 18 18

## 🎯 Roadmap / Geplante Features

- [ ] Weitere STWEG-Unterseiten (STWEG 1, 2, 4-7)
- [ ] Kalender-Integration für Termine
- [ ] Push-Benachrichtigungen für wichtige Mitteilungen
- [ ] Mitgliederbereich mit Login
- [ ] Download-Bereich für Dokumente
- [ ] Online-Formulare für Anfragen

## 📄 Lizenz

Diese Website wurde für die Stockwerkeigentümerschaft Rosenweg erstellt. Freie Verwendung und Anpassung erlaubt.

---

**Erstellt:** Oktober 2025  
**Für:** STWEG-Kooperation Rosenweg (STWEG 1-8), Kaiseraugst  
**Verwaltung:** LangPartners Immobilien AG, Muttenz  
**Technologie:** HTML5, Tailwind CSS, Vanilla JavaScript, JSON  
**Hosting:** GitHub Pages ready  
**Letzte Aktualisierung:** Oktober 2025
