# 🔐 Berechtigungen für die Kontaktliste verwalten

**Anleitung für Ausschussvertreter der STWEG 3**

---

## 📋 Übersicht: Wer hat Zugriff?

### ✅ Automatisch berechtigt (keine Aktion nötig):
- **Alle Eigentümer** aller Wohnungen (EG.1-3, 1OG.1-3, 2OG.1-3)
- **Hobbyraum-Eigentümer**
- **Ausschussvertreter** (Stefan Müller, Basil Fersztand)

### ⚠️ Manuelle Berechtigung erforderlich:
- **Mieter** - müssen vom Ausschuss freigegeben werden

---

## 🎯 Schritt-für-Schritt: Mieter berechtigen

### Schritt 1: Datei öffnen

Öffne die Datei `kontakte.json` in einem Texteditor.

### Schritt 2: Mieter finden

Suche nach der entsprechenden Wohnung und dem Mieter-Eintrag.

**Beispiel - EG.2:**
```json
{
  "bezeichnung": "EG.2",
  "eigentümer": {
    "name": "Besim Neziri",
    "email": "besim.neziri@icloud.com",
    "telefon": "+41 79 234 56 78",
    "typ": "eigentümer"
  },
  "mieter": {
    "name": "[Name des Mieters]",
    "email": "mieter@beispiel.ch",
    "telefon": "+41 79 345 67 89",
    "typ": "mieter",
    "berechtigt": false    ← HIER
  }
}
```

### Schritt 3: Berechtigung erteilen

Ändere `"berechtigt": false` zu `"berechtigt": true`:

```json
"mieter": {
  "name": "Maria Muster",
  "email": "maria.muster@gmail.com",
  "telefon": "+41 79 345 67 89",
  "typ": "mieter",
  "berechtigt": true    ← Jetzt berechtigt!
}
```

### Schritt 4: Kontaktdaten aktualisieren

Füge die echten Kontaktdaten des Mieters ein:

```json
"mieter": {
  "name": "Maria Muster",                    ← Echter Name
  "email": "maria.muster@gmail.com",         ← Echte E-Mail
  "telefon": "+41 79 345 67 89",             ← Echte Telefonnummer
  "typ": "mieter",
  "berechtigt": true
}
```

### Schritt 5: Datum aktualisieren

Aktualisiere das Datum der letzten Änderung:

```json
"stweg": {
  "letzte_aktualisierung": "2025-11-03"    ← Heutiges Datum
}
```

### Schritt 6: Datei speichern & hochladen

1. Speichere `kontakte.json`
2. Lade die Datei auf GitHub hoch
3. Nach 1-2 Minuten ist die Änderung live

---

## ⛔ Berechtigung entziehen

### Schritt 1: Datei öffnen

Öffne `kontakte.json`

### Schritt 2: Mieter finden und ändern

Setze `"berechtigt": false` oder entferne die Zeile komplett:

```json
"mieter": {
  "name": "Hans Meier",
  "email": "hans.meier@beispiel.ch",
  "telefon": "+41 79 234 56 78",
  "typ": "mieter",
  "berechtigt": false    ← Zugriff entzogen
}
```

### Schritt 3: Speichern & hochladen

Wie in Schritt 6 oben.

---

## 📊 Aktueller Status (Beispiel)

### Berechtigte Bewohner STWEG 3:

| Wohnung | Eigentümer | Berechtigt | Mieter | Berechtigt |
|---------|-----------|-----------|--------|-----------|
| EG.1    | Basil Fersztand | ✅ Automatisch | - | - |
| EG.2    | Besim Neziri | ✅ Automatisch | [Name] | ❌ Nicht berechtigt |
| EG.3    | Elisabeth Müller | ✅ Automatisch | - | - |
| 1OG.1   | Yves Wyss | ✅ Automatisch | - | - |
| 1OG.2   | [Name] | ✅ Automatisch | - | - |
| 1OG.3   | Bülent Aytac | ✅ Automatisch | [Name] | ✅ **Berechtigt** |
| 2OG.1   | Slavica Ilic | ✅ Automatisch | - | - |
| 2OG.2   | Ajradin Emini | ✅ Automatisch | - | - |
| 2OG.3   | Rolf & Stefan Müller | ✅ Automatisch | - | - |

**Legende:**
- ✅ = Automatisch oder manuell berechtigt
- ❌ = Nicht berechtigt (Standard für Mieter)
- `-` = Keine Mieter vorhanden

---

## 🤔 Häufige Fragen

### Warum haben Mieter nicht automatisch Zugriff?

**Datenschutz:** Die Kontaktliste enthält sensible Daten aller Bewohner. Der Ausschuss entscheidet, welche Mieter Zugriff erhalten.

### Was passiert, wenn ein Mieter auszieht?

1. Setze `"berechtigt": false`
2. Optional: Ändere die Kontaktdaten auf Platzhalter

### Kann ein Mieter mehrere E-Mail-Adressen haben?

Ja! Trenne sie mit Komma:

```json
"mieter": {
  "name": "Max Muster",
  "email": "max@privat.ch,max@firma.ch",
  "telefon": "+41 79 123 45 67",
  "typ": "mieter",
  "berechtigt": true
}
```

### Was passiert bei einem Eigentümerwechsel?

1. Ändere die Eigentümer-Kontaktdaten
2. Entferne den alten Mieter (falls vorhanden)
3. Aktualisiere das Datum

```json
"eigentümer": {
  "name": "Neuer Eigentümer",
  "email": "neu@beispiel.ch",
  "telefon": "+41 79 999 88 77",
  "typ": "eigentümer"
}
```

---

## ✅ Checkliste: Neue Mieter berechtigen

- [ ] Mieter-Kontaktdaten erhalten (Name, E-Mail, Telefon)
- [ ] `kontakte.json` öffnen
- [ ] Wohnung finden
- [ ] Mieter-Daten eintragen
- [ ] `"berechtigt": true` setzen
- [ ] Datum aktualisieren
- [ ] Datei speichern
- [ ] Auf GitHub hochladen
- [ ] Mieter informieren
- [ ] Testen: Mieter probiert Zugriff

---

## 🆘 Bei Problemen

**Kontakt:**  
**Stefan Müller** (Technischer Dienst Rosenweg)  
📧 stefan+rosenweg@juroct.ch  
📱 +41 76 519 99 70

---

## 📝 Beispiel-Antrag (für Mieter)

Wenn ein Mieter Zugriff auf die Kontaktliste beantragt:

**Vorlage für E-Mail an Ausschussvertreter:**

```
Betreff: Antrag auf Zugriff zur Kontaktliste STWEG 3

Sehr geehrte Ausschussvertreter,

ich bin Mieter der Wohnung [Wohnungsbezeichnung] und möchte 
höflich um Zugriff auf die geschützte Kontaktliste der STWEG 3 bitten.

Meine Kontaktdaten:
- Name: [Vollständiger Name]
- E-Mail: [E-Mail-Adresse]
- Telefon: [Telefonnummer]
- Wohnung: [z.B. EG.2]
- Eingezogen am: [Datum]

Vielen Dank für die Prüfung meines Antrags.

Mit freundlichen Grüßen
[Name]
```

**Entscheidung durch Ausschuss:**
- Prüfung des Antrags
- Beschluss (z.B. per E-Mail-Abstimmung)
- Bei Zustimmung: Berechtigung in `kontakte.json` setzen
- Mieter informieren

---

**Version:** 1.0  
**Erstellt:** November 2025  
**Verantwortlich:** Ausschuss STWEG 3
