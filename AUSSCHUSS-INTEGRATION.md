# Anleitung: Integration der Ausschussmitglieder in index.html

Diese Anleitung erklärt, wie die Ausschussmitglieder aus der `ausschuss-kontakte.json` Datei automatisch in die `index.html` geladen und angezeigt werden.

## 📋 Benötigte Dateien

- `index.html` (Ihre Hauptseite)
- `ausschuss-kontakte.json` (Ausschussmitglieder-Daten)
- `ausschuss-loader.js` (JavaScript zum Laden der Daten)

## 🔧 Schritt 1: HTML-Änderungen in index.html

### Änderung 1: Ausschuss-Container mit ID versehen

**Finden Sie** im Bereich "Verwaltung & Kontakte" (ca. Zeile 300-350) diesen Code:

```html
<!-- Ausschuss Kontakte -->
<div class="bg-white p-6 rounded-lg shadow-md">
    <div class="flex items-center mb-4">
        <svg class="h-8 w-8 text-blue-600 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path>
        </svg>
        <h3 class="text-xl font-semibold">Ausschuss-Vertreter</h3>
    </div>
    <p class="text-sm text-gray-600 mb-4">Jede STWEG entsendet 2 Vertreter in den Ausschuss (insgesamt 16 Mitglieder)</p>
    <div class="space-y-3">
        <div class="border-l-2 border-blue-400 pl-3">
            <p class="text-sm font-semibold text-gray-700">STWEG 1</p>
            <p class="text-sm text-gray-600">[Name Vertreter 1] • [Name Vertreter 2]</p>
        </div>
        <!-- ... weitere STWEGs ... -->
    </div>
</div>
```

**Ersetzen Sie** den `<div class="space-y-3">` Block durch:

```html
<div id="ausschuss-liste" class="space-y-3">
    <!-- Wird automatisch aus ausschuss-kontakte.json geladen -->
    <div class="text-sm text-gray-600 animate-pulse">
        <p>Lade Ausschussmitglieder...</p>
    </div>
</div>
<p id="ausschuss-last-update" class="text-xs text-gray-500 mt-4 pt-4 border-t border-gray-200"></p>
```

### Änderung 2: JavaScript einbinden

**Finden Sie** am Ende der Datei, **vor** dem schließenden `</body>` Tag (ca. Zeile 580), diesen Bereich:

```html
    <!-- Mobile Menu Script -->
    <script>
        const mobileMenuButton = document.getElementById('mobile-menu-button');
        // ... existing code ...
    </script>
</body>
</html>
```

**Fügen Sie** direkt **nach** dem öffnenden `<script>` Tag und **vor** dem bestehenden Code diese Zeile hinzu:

```html
    <!-- Mobile Menu Script -->
    <script src="ausschuss-loader.js"></script>
    <script>
        const mobileMenuButton = document.getElementById('mobile-menu-button');
        // ... existing code ...
    </script>
</body>
</html>
```

**ODER** alternativ: Fügen Sie den Inhalt von `ausschuss-loader.js` direkt in das `<script>` Tag ein.

## 📂 Schritt 2: Dateien hochladen

Stellen Sie sicher, dass alle drei Dateien im selben Verzeichnis liegen:

```
/
├── index.html
├── ausschuss-kontakte.json
└── ausschuss-loader.js
```

Wenn Sie GitHub Pages verwenden:
1. Laden Sie alle drei Dateien in Ihr Repository hoch
2. Committen und pushen Sie die Änderungen
3. Nach 1-2 Minuten sollten die Ausschussmitglieder automatisch angezeigt werden

## ✅ Schritt 3: Testen

1. Öffnen Sie die `index.html` lokal in Ihrem Browser
2. Scrollen Sie zum Bereich "Organisation & Verwaltung"
3. Prüfen Sie, ob die Ausschussmitglieder korrekt angezeigt werden
4. In der Browser-Konsole (F12) sollten keine Fehler erscheinen

## 🎨 Was wird angezeigt?

Nach der Integration werden die Ausschussmitglieder automatisch aus der JSON-Datei geladen und wie folgt dargestellt:

- **STWEG 1-7**: Namen der beiden Vertreter pro STWEG (z.B. "Maurice Pretzel • Urs Speiser")
- **STWEG 8 (Tiefgarage)**: Name des Vertreters (hervorgehoben in Grün)
- **Letzte Aktualisierung**: Datum der letzten Änderung wird automatisch angezeigt

## 🔄 Aktualisierung der Ausschussmitglieder

Um die Ausschussmitglieder zu aktualisieren:

1. Bearbeiten Sie die `ausschuss-kontakte.json` Datei
2. Ändern Sie Namen, Telefonnummern oder E-Mails wie benötigt
3. Aktualisieren Sie das Feld `"letzte_aktualisierung"` auf das aktuelle Datum
4. Speichern und hochladen
5. Die Website zeigt automatisch die neuen Daten an (ggf. Browser-Cache leeren)

## 🐛 Fehlerbehebung

### Problem: Ausschussmitglieder werden nicht angezeigt

**Lösungen:**
1. Öffnen Sie die Browser-Konsole (F12) und prüfen Sie auf Fehler
2. Stellen Sie sicher, dass `ausschuss-kontakte.json` und `ausschuss-loader.js` im selben Verzeichnis wie `index.html` liegen
3. Prüfen Sie, ob die JSON-Datei gültig ist (z.B. mit jsonlint.com)
4. Leeren Sie den Browser-Cache (Strg+F5)

### Problem: "Failed to fetch" Fehler

**Ursache:** Lokale Dateien können oft nicht per `fetch()` geladen werden aus Sicherheitsgründen.

**Lösung:**
- Verwenden Sie einen lokalen Webserver (z.B. `python -m http.server` oder VS Code Live Server Extension)
- ODER laden Sie die Dateien auf GitHub Pages hoch (empfohlen)

### Problem: Alte Platzhalter werden noch angezeigt

**Lösung:** Der alte HTML-Code wurde nicht korrekt ersetzt. Prüfen Sie nochmals Schritt 1, Änderung 1.

## 📞 Support

Bei Fragen wenden Sie sich an:
- Technischer Dienst STWEG 3: Stefan Müller (stefan+rosenweg@juroct.ch)
- LangPartners Immobilien AG: +41 61 228 18 18

---

**Erstellt:** Oktober 2025  
**Version:** 1.0  
**Für:** STWEG-Kooperation Rosenweg, Kaiseraugst