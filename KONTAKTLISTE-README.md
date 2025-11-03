# Geschützte Kontaktliste STWEG 3

## 📋 Übersicht

Diese geschützte Kontaktliste ermöglicht es berechtigten Bewohnern der STWEG 3, auf die Kontaktdaten aller Wohnungen zuzugreifen. Der Zugriff erfolgt über einen per E-Mail versandten Zugangscode (OTP - One-Time-Password).

## 🔐 Berechtigungssystem

### Automatisch berechtigt:
- ✅ **Alle Eigentümer** - haben automatisch Zugriff
- ✅ **Ausschussvertreter** - haben automatisch Zugriff

### Mieter:
- ⚠️ Mieter benötigen eine **explizite Berechtigung**
- Diese wird durch das Feld `"berechtigt": true` in der `kontakte.json` gesetzt
- Standardmäßig ist `"berechtigt": false`

## 📁 Dateien

### 1. `stweg3-kontakte.html`
Die Hauptseite für den geschützten Zugriff auf die Kontaktliste.

**Features:**
- 2-Faktor-Authentifizierung per E-Mail
- Automatische Berechtigungsprüfung
- Responsive Design
- Druckfunktion
- Übersichtliche Darstellung nach Etagen

### 2. `kontakte.json`
Enthält alle Kontaktdaten der Bewohner.

**Struktur:**
```json
{
  "wohnungen": {
    "erdgeschoss": [
      {
        "bezeichnung": "EG.1",
        "eigentümer": {
          "name": "Max Mustermann",
          "email": "max@beispiel.ch",
          "telefon": "+41 79 123 45 67",
          "typ": "eigentümer"
        },
        "mieter": {
          "name": "Maria Muster",
          "email": "maria@beispiel.ch",
          "telefon": "+41 79 234 56 78",
          "typ": "mieter",
          "berechtigt": true    ← Wichtig für Mieter!
        }
      }
    ]
  }
}
```

## 🔧 Verwaltung der Berechtigungen

### Einem Mieter Zugriff gewähren:

1. Öffne `kontakte.json`
2. Suche den Mieter
3. Setze `"berechtigt": true`

**Beispiel:**
```json
"mieter": {
  "name": "Hans Meier",
  "email": "hans.meier@beispiel.ch",
  "telefon": "+41 79 345 67 89",
  "typ": "mieter",
  "berechtigt": true    ← Auf true setzen
}
```

### Einem Mieter Zugriff entziehen:

Setze `"berechtigt": false` oder entferne das Feld komplett.

## 📧 E-Mail-System (EmailJS)

Die Kontaktliste verwendet **EmailJS** für den Versand der Zugangscodes.

### Konfiguration in `stweg3-kontakte.html`:

```javascript
const EMAILJS_SERVICE_ID = 'service_qevit9e';
const EMAILJS_TEMPLATE_ID = 'template_uc5u3gi';
const EMAILJS_PUBLIC_KEY = 'DnHPrkTT61uco4ro4';
```

### EmailJS Template-Variablen:

Das E-Mail-Template sollte folgende Variablen enthalten:
- `{{to_email}}` - Empfänger-E-Mail
- `{{otp_code}}` - 6-stelliger Zugangscode
- `{{valid_minutes}}` - Gültigkeit in Minuten (10)
- `{{stweg}}` - "STWEG 3 - Rosenweg 9"

### Bei E-Mail-Problemen:

1. Prüfe EmailJS-Dashboard auf Fehlermeldungen
2. Überprüfe monatliches Limit (kostenlose Version: 200 E-Mails/Monat)
3. Verifiziere, dass das Template aktiv ist
4. Schaue in die Browser-Konsole (F12) für detaillierte Fehlermeldungen

## 🎯 Verwendung der Kontaktliste

### Für Bewohner:

1. Öffne `stweg3-kontakte.html`
2. Gebe deine E-Mail-Adresse ein
3. Erhalte den 6-stelligen Code per E-Mail
4. Gebe den Code ein (gültig für 10 Minuten)
5. Zugriff auf die vollständige Kontaktliste

### Für Administratoren:

**Neue Bewohner hinzufügen:**
```json
{
  "bezeichnung": "1OG.1",
  "zimmer": "3.5",
  "flaeche_m2": 75,
  "besonderheiten": ["Balkon"],
  "eigentümer": {
    "name": "Neuer Eigentümer",
    "email": "neu@beispiel.ch",
    "telefon": "+41 79 111 22 33",
    "typ": "eigentümer"
  },
  "mieter": null
}
```

**Wohnung mit Mieter:**
```json
{
  "bezeichnung": "2OG.2",
  "eigentümer": { ... },
  "mieter": {
    "name": "Neuer Mieter",
    "email": "mieter.neu@beispiel.ch",
    "telefon": "+41 79 222 33 44",
    "typ": "mieter",
    "berechtigt": false    ← Standardmäßig false
  }
}
```

## 🔄 Aktualisierung der Kontaktdaten

1. Bearbeite `kontakte.json`
2. Aktualisiere das Feld `letzte_aktualisierung` im Format "YYYY-MM-DD"
3. Lade beide Dateien auf GitHub hoch

```json
"stweg": {
  "letzte_aktualisierung": "2025-11-03"
}
```

## 👤 Technischer Dienst Rosenweg

Bei Fragen oder Problemen:

**Stefan Müller**
- E-Mail: stefan+rosenweg@juroct.ch
- Telefon: +41 76 519 99 70
- Funktion: Ausschuss-Vertreter 1 & Technischer Dienst

## 🔒 Datenschutz & Sicherheit

### Sicherheitsmaßnahmen:
- ✅ 2-Faktor-Authentifizierung (E-Mail + OTP)
- ✅ Zeitlich begrenzte Zugangscodes (10 Minuten)
- ✅ Automatische Berechtigungsprüfung
- ✅ Keine Passwörter gespeichert
- ✅ Getrennte Berechtigungen für Eigentümer/Mieter

### Datenschutz-Hinweise:
- Die Kontaktdaten sind nur für berechtigte Bewohner zugänglich
- Die Daten dürfen nicht an Dritte weitergegeben werden
- Die Nutzung erfolgt ausschließlich für interne Zwecke der STWEG 3

## 🛠️ Fehlerbehebung

### Problem: "E-Mail-Adresse nicht berechtigt"

**Lösung für Eigentümer:**
- Überprüfe, ob deine E-Mail in `kontakte.json` korrekt hinterlegt ist
- Achte auf Tippfehler und Groß-/Kleinschreibung

**Lösung für Mieter:**
- Kontaktiere den technischen Dienst Rosenweg
- Das Feld `"berechtigt": true` muss für dich gesetzt werden

### Problem: "Fehler beim E-Mail-Versand"

**Mögliche Ursachen:**
1. EmailJS-Limit erreicht (200 E-Mails/Monat im kostenlosen Plan)
2. Falsche EmailJS-Konfiguration
3. Template deaktiviert oder gelöscht

**Lösung:**
1. Prüfe EmailJS-Dashboard: https://dashboard.emailjs.com
2. Überprüfe die Credentials in der HTML-Datei
3. Kontaktiere den technischen Dienst Rosenweg

### Problem: "Code ist abgelaufen"

**Lösung:**
- Klicke auf "Code erneut senden"
- Der neue Code ist wieder 10 Minuten gültig

## 📊 Statistiken

- **Anzahl Wohnungen:** 9
- **Anzahl Hobbyräume:** 1
- **Anzahl Waschküchen:** 2
- **Anzahl Ausschussvertreter:** 2

## 🔄 Version & Changelog

**Version 2.0** (2025-11-03)
- ✅ Automatische Berechtigung für alle Eigentümer
- ✅ Berechtigungsfeld für Mieter
- ✅ Verbesserte Fehlermeldungen
- ✅ Kontakt zu technischem Dienst Rosenweg
- ✅ Mehrere E-Mails pro Person unterstützt

**Version 1.0** (2025-10-13)
- Initiale Version

---

**Letzte Aktualisierung:** November 2025  
**Verantwortlich:** Technischer Dienst Rosenweg (Stefan Müller)  
**Verwaltung:** LangPartners Immobilien AG, Muttenz
