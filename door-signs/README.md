# 📋 Türschilder A4 - STWEG-Kooperation Rosenweg

Dynamische Türschilder im A4-Format mit QR-Code-Integration für spezielle Räume.

## 💡 Konzept

### Das Problem
Herkömmliche Türschilder müssen bei jedem Wechsel von Ansprechpartnern, Schlüsselhaltern oder Kontaktinformationen neu gedruckt und ausgetauscht werden.

### Die Lösung
**Hybrid-Ansatz: Statisch gedruckt + Dynamisch per QR-Code**

#### Statischer Teil (auf dem Schild gedruckt)
- ✅ Raumname & Standort
- ✅ Grundausstattung
- ✅ Wichtige Sicherheitshinweise
- ✅ Farbcodierung nach Raumtyp

#### Dynamischer Teil (über QR-Codes abrufbar)
- 📱 Ansprechpartner & Verantwortliche
- 📱 Schlüsselhalter & Zugangsberechtigungen
- 📱 Notfallnummern & Service-Kontakte
- 📱 Detaillierte Dokumentation & Regeln

### Vorteil
Bei Änderungen von Kontaktpersonen oder anderen dynamischen Informationen müssen **nur die Web-Seiten** hinter den QR-Codes aktualisiert werden - die Türschilder bleiben unverändert!

## 🎨 Farbcodierung

Jeder Raumtyp hat eine eigene Farbe für schnelle visuelle Orientierung:

| Raumtyp | Farbe | Gradient |
|---------|-------|----------|
| 🔥 Heizung & Technik | Orange/Rot | `#ea580c` → `#dc2626` |
| 🧺 Waschküche | Grün | `#16a34a` → `#15803d` |
| 📡 Telekommunikation | Blau | `#3b82f6` → `#2563eb` |
| ⚡ Hauptverteilung | Lila | `#9333ea` → `#7c3aed` |
| 🛗 Liftmaschinenraum | Grau/Slate | `#475569` → `#334155` |

## 📁 Struktur

```
door-signs/
├── index.html                      # Übersichtsseite (START HIER!)
├── README.md                       # Diese Datei
│
├── heizung-technikraum.html       # Türschild: Heizungs- und Technikraum
├── waschkueche.html               # Türschild: Waschküche
├── telekommunikation.html         # Türschild: Telekommunikation
├── hauptverteilung.html           # Türschild: Hauptverteilung (Elektro)
├── liftmaschinenraum.html         # Türschild: Liftmaschinenraum
│
├── data/                          # JSON-Daten für dynamische Inhalte
│   ├── heizung-ansprechpartner.json
│   ├── waschkueche-ansprechpartner.json
│   └── [weitere JSON-Dateien]
│
└── templates/                     # Wiederverwendbare Templates
    └── ansprechpartner-template.html
```

## 🚀 Schnellstart

### 1. Übersichtsseite öffnen
Öffnen Sie `index.html` im Browser, um alle verfügbaren Türschilder zu sehen.

### 2. Türschild auswählen & anpassen
- Klicken Sie auf "Anzeigen" beim gewünschten Raumtyp
- Optional: Passen Sie Standort/Gebäude-Nummer im HTML an

### 3. Drucken
- Öffnen Sie die HTML-Datei im Browser
- Drucken Sie auf **A4-Papier** (210×297mm)
- **Wichtig:** Aktivieren Sie "Hintergrundgrafiken" im Druckdialog!

### 4. Detail-Seiten erstellen
Erstellen Sie die Web-Seiten, auf die die QR-Codes verweisen:

**Beispiel-URLs für Heizungsraum:**
- `https://rosenweg4303.ch/heizung-ansprechpartner.html`
- `https://rosenweg4303.ch/heizung-zugang.html`
- `https://rosenweg4303.ch/heizung-notfall.html`

Sie können entweder:
- **Option A:** Das Template verwenden (`templates/ansprechpartner-template.html`)
- **Option B:** Eigene HTML-Seiten erstellen
- **Option C:** Auf bestehende Seiten Ihrer Website verlinken

### 5. Anbringen
- Laminieren Sie das Schild für längere Haltbarkeit
- Bringen Sie es mit doppelseitigem Klebeband oder in einem Rahmen an der Tür an

## 📖 Verwendung der Templates

### Ansprechpartner-Template

Das Template `templates/ansprechpartner-template.html` lädt Kontaktdaten aus einer JSON-Datei.

**So verwenden Sie es:**

1. **JSON-Datei erstellen** (siehe Beispiele in `/data/`)
2. **Template kopieren** und umbenennen (z.B. `heizung-ansprechpartner.html`)
3. **DATA_FILE Pfad anpassen** im JavaScript:
   ```javascript
   const DATA_FILE = '../data/heizung-ansprechpartner.json';
   ```
4. **Online stellen** - Upload auf Webserver

### JSON-Struktur für Ansprechpartner

```json
{
  "title": "Raumname - Ansprechpartner",
  "updated": "2024-11-05",
  "contacts": [
    {
      "role": "Rolle/Funktion",
      "name": "Max Mustermann",
      "phone": "+41 79 123 45 67",
      "email": "max@example.com",
      "available": "Mo-Fr 08:00-17:00"
    }
  ],
  "service": {
    "company": "Firma XY AG",
    "phone": "+41 61 123 45 67",
    "emergency_phone": "+41 79 999 88 77",
    "email": "service@firma.ch"
  },
  "notes": [
    "Wichtiger Hinweis 1",
    "Wichtiger Hinweis 2"
  ]
}
```

## 🎯 Für spezifische Standorte anpassen

### Mehrere Gebäude (z.B. 3 Liftmaschinenräume)

Wenn Sie 3 verschiedene Liftmaschinenräume haben:

1. **Kopieren Sie** `liftmaschinenraum.html` 3x:
   - `liftmaschinenraum-stweg1.html`
   - `liftmaschinenraum-stweg3.html`
   - `liftmaschinenraum-stweg8.html`

2. **Passen Sie den Standort an:**
   ```html
   <h1>🛗 Liftmaschinenraum</h1>
   <p>STWEG 1 - Rosenweg 7</p>
   ```

3. **Passen Sie die QR-Code-URLs an:**
   ```html
   data=https://rosenweg4303.ch/lift-stweg1-ansprechpartner.html
   ```

## 🔧 Anpassung der Türschilder

### Farben ändern

Suchen Sie nach den Gradient-Definitionen:
```css
background: linear-gradient(135deg, #ea580c 0%, #dc2626 100%);
```

### Inhalte anpassen

Jede HTML-Datei ist vollständig eigenständig - Sie können:
- Texte ändern
- Listeneinträge hinzufügen/entfernen
- Warnungen anpassen
- QR-Code-URLs ändern

### Neue Raumtypen hinzufügen

1. Kopieren Sie ein bestehendes Türschild als Vorlage
2. Ändern Sie die Farben (Header + Hintergrund)
3. Passen Sie Icon, Titel und Inhalte an
4. Fügen Sie es zur `index.html` hinzu

## 📱 QR-Code-Generator

Die QR-Codes werden von der API `qrserver.com` generiert:

```html
<img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=https://ihre-url.ch" alt="QR Code">
```

**Parameter:**
- `size`: Größe in Pixel (empfohlen: 300x300)
- `data`: Die URL, die beim Scannen geöffnet wird

## 🖨️ Druck-Tipps

### Empfohlene Einstellungen
- **Format:** A4 (210×297mm)
- **Ausrichtung:** Hochformat
- **Ränder:** Keine (oder minimal)
- **Hintergrundgrafiken:** ✅ Aktiviert
- **Seitengröße:** An Seite anpassen

### Browser-spezifisch

#### Chrome/Edge
- Strg+P (Windows) / Cmd+P (Mac)
- "Weitere Einstellungen" → "Hintergrundgrafiken" aktivieren

#### Firefox
- Strg+P (Windows) / Cmd+P (Mac)
- "Hintergrundfarben und -bilder drucken" aktivieren

#### Safari
- Cmd+P
- "Hintergründe drucken" aktivieren

## 📋 Checkliste für neue Türschilder

- [ ] Türschild-HTML ausgewählt/erstellt
- [ ] Standort/Gebäude im HTML angepasst
- [ ] JSON-Dateien für dynamische Inhalte erstellt
- [ ] Detail-Seiten (für QR-Codes) erstellt
- [ ] QR-Code-URLs im Türschild angepasst
- [ ] Detail-Seiten online gestellt
- [ ] QR-Codes getestet (mit Smartphone gescannt)
- [ ] Türschild ausgedruckt (A4, mit Hintergrundgrafiken)
- [ ] Laminiert
- [ ] An der Tür angebracht

## 🆘 Support & Fragen

Bei Fragen oder Problemen wenden Sie sich an:
- **Hauswart:** hauswart@rosenweg4303.ch
- **IT-Verantwortlicher:** [Kontakt einfügen]

## 📄 Lizenz

© 2024 STWEG-Kooperation Rosenweg · Kaiseraugst

Diese Türschilder wurden für die interne Verwendung in der STWEG-Kooperation Rosenweg erstellt.
