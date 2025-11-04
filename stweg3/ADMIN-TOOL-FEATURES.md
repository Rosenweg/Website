# Admin Tool - Neue Features

## Übersicht der Verbesserungen

Das Admin-Tool wurde um folgende Funktionen erweitert:

### 1. ✅ Immer sichtbarer Speichern-Button

**Problem gelöst**: Der "JSON speichern" Button war nur sichtbar, wenn das `<details>` Element geöffnet war.

**Lösung**: Der Speichern-Button ist jetzt **immer sichtbar** am oberen Rand der Seite, auch wenn der erweiterte JSON-Editor eingeklappt ist.

**Features**:
- Großer, prominenter Button mit Icon
- Visueller Indikator (gelber Ring) wenn ungespeicherte Änderungen vorhanden sind
- Button wird nach erfolgreichem Speichern wieder normal angezeigt

### 2. 🔄 Auto-Speichern Funktion

**Feature**: Optionale automatische Speicherung alle 30 Sekunden

**Aktivierung**:
- Checkbox "🔄 Auto-Speichern" neben dem Speichern-Button
- Grüne Statusmeldung zeigt an, wenn Auto-Speichern aktiv ist

**Verhalten**:
- Speichert nur, wenn tatsächlich Änderungen vorgenommen wurden
- Keine Sicherheitsabfrage bei Auto-Speichern (läuft im Hintergrund)
- Zeigt "✓ Auto-Speichern erfolgreich!" nach jedem erfolgreichen Speichervorgang
- Kann jederzeit deaktiviert werden

### 3. 🔒 Selbstmutation: Berechtigungsbasierte Bearbeitung

**Konzept**: Jeder Nutzer kann nur seine eigenen Daten bearbeiten. Ausschussmitglieder können alle Daten bearbeiten.

#### Berechtigungen:

**Normale Bewohner (👤 Bewohner)**:
- Können nur Wohnungen bearbeiten, bei denen sie als **Eigentümer** eingetragen sind
- Können nur Wohnungen bearbeiten, bei denen sie als **berechtigter Mieter** eingetragen sind
- Sehen eine gelbe Warnung im JSON-Editor-Bereich
- Nicht bearbeitbare Wohnungen sind ausgegraut und mit 🔒 gekennzeichnet

**Ausschussmitglieder (⭐ Ausschuss)**:
- Können **alle Wohnungen** bearbeiten
- Können den JSON-Editor ohne Einschränkungen nutzen
- Sehen kein Warnung im JSON-Editor-Bereich
- Alle Wohnungen sind vollständig bearbeitbar

#### Visuelle Indikatoren:

1. **Permission Badge** neben dem angemeldeten E-Mail:
   - `👤 Bewohner` (blau) - normale Berechtigungen
   - `⭐ Ausschuss` (lila) - erweiterte Berechtigungen

2. **Wohnungskarten**:
   - Bearbeitbare Wohnungen: normal, mit Hover-Effekt
   - Nicht bearbeitbare Wohnungen: ausgegraut, mit 🔒 Symbol

3. **Warnung im JSON-Editor**:
   - Gelbe Warnung für normale Bewohner mit Hinweis auf eingeschränkte Berechtigungen

### 4. 🎨 Visuelle Verbesserungen

**Änderungserkennung**:
- Textarea hat `oninput="onJSONChange()"` Event
- Bei Änderungen bekommt der Speichern-Button einen gelben Ring als visuellen Hinweis
- Ring verschwindet nach erfolgreichem Speichern

**Auto-Save Status**:
- Grüne Info-Box zeigt an, wenn Auto-Speichern aktiv ist
- Versteckt sich automatisch, wenn Auto-Speichern deaktiviert wird

## Technische Implementation

### Neue JavaScript-Funktionen:

```javascript
// Auto-Save
onJSONChange()           // Erkennt Änderungen im JSON-Editor
toggleAutoSave()         // Aktiviert/Deaktiviert Auto-Speichern

// Permissions
canEditWohnung(wohnung)  // Prüft Bearbeitungsrechte für eine Wohnung
checkEditPermissions()   // Zeigt Permission-Badge und Warnung an

// Updated Functions
saveJSON(autoSave)       // Jetzt mit optional autoSave Parameter
createWohnungCard()      // Zeigt Permission-Status in Wohnungskarten
editWohnung()            // Prüft Berechtigungen vor Bearbeitung
loadEditor()             // Ruft checkEditPermissions() auf
```

### Berechtigungsprüfung:

```javascript
function canEditWohnung(wohnung) {
    // 1. Prüfe ob Ausschussmitglied
    if (kontakteData.ausschuss.some(a => a.email === currentEmail)) {
        return true; // Ausschuss kann alles bearbeiten
    }

    // 2. Prüfe ob Eigentümer
    if (wohnung.eigentümer.email === currentEmail) {
        return true;
    }

    // 3. Prüfe ob berechtigter Mieter
    if (wohnung.mieter?.berechtigt && wohnung.mieter.email === currentEmail) {
        return true;
    }

    return false; // Keine Berechtigung
}
```

## Verwendung

### Als Bewohner:

1. Mit Ihrer E-Mail anmelden
2. Sie sehen nur die Wohnungen, die Sie bearbeiten dürfen (ohne 🔒)
3. Klicken Sie auf Ihre Wohnung, um Ihre Daten zu bearbeiten
4. Optional: Aktivieren Sie Auto-Speichern für automatische Sicherung

### Als Ausschussmitglied:

1. Mit Ihrer Ausschuss-E-Mail anmelden
2. Sie sehen das ⭐ Ausschuss-Badge neben Ihrem Namen
3. Sie können alle Wohnungen bearbeiten
4. Sie können den JSON-Editor ohne Einschränkungen nutzen
5. Optional: Aktivieren Sie Auto-Speichern für automatische Sicherung

## Sicherheit

- **Serverseitige Prüfung**: Die Berechtigungen werden nur clientseitig visualisiert. Der n8n-Workflow sollte ebenfalls Berechtigungen prüfen
- **Ausschuss-Mitgliedschaft**: Wird aus `kontakteData.ausschuss` Array gelesen
- **E-Mail-Verifikation**: Nutzer müssen sich mit OTP authentifizieren

## Empfehlungen

1. **Auto-Speichern**: Aktivieren Sie Auto-Speichern nur, wenn Sie aktiv Änderungen vornehmen
2. **JSON-Editor**: Nutzen Sie den benutzerfreundlichen Editor statt direkter JSON-Bearbeitung
3. **Berechtigungen**: Nur Ausschussmitglieder sollten den JSON-Editor direkt verwenden

## Zukünftige Erweiterungen

- [ ] Änderungsprotokoll (wer hat was wann geändert)
- [ ] Rückgängig-Funktion
- [ ] Mehrere Wohnungen gleichzeitig bearbeiten
- [ ] Export-Funktion für eigene Daten
- [ ] E-Mail-Benachrichtigung bei Änderungen
