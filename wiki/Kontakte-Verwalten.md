# Kontakte verwalten

Anleitung für Ausschussvertreter zum Verwalten von Berechtigungen für die STWEG 3 Kontaktliste.

## 📋 Übersicht: Wer hat Zugriff?

### ✅ Automatisch berechtigt

Diese Personen haben **automatisch** Zugriff auf die Kontaktliste:

- **Alle Eigentümer** aller Wohnungen (EG.1-3, 1OG.1-3, 2OG.1-3)
- **Hobbyraum-Eigentümer**
- **Ausschussvertreter** der STWEG 3
- **Hausverwaltung** (alle E-Mails von @langpartners.ch)

### ⚠️ Manuelle Berechtigung erforderlich

- **Mieter** - müssen vom Ausschuss freigegeben werden

## 🎯 Mieter berechtigen

### Option A: Admin-Bereich (empfohlen)

Die einfachste Methode ist über den [Admin-Bereich](STWEG3-Admin):

1. Öffne [admin.html](https://rosenweg4303.ch/stweg3/admin.html)
2. Authentifiziere dich mit deiner Ausschuss-E-Mail
3. Wähle die Wohnung mit dem Mieter
4. Bearbeite die Mieter-Daten im Formular
5. Setze **☑️ Mieter hat Zugriff auf Kontaktliste**
6. Klicke auf "Änderungen speichern"
7. Klicke auf "JSON speichern"

✅ **Fertig!** Der Mieter kann sich sofort mit seiner E-Mail einloggen.

### Option B: Manuell per JSON

Falls du direkt in der `kontakte.json` arbeiten möchtest:

#### 1. Datei öffnen

Öffne `stweg3/kontakte.json` in einem Editor.

#### 2. Mieter finden

Suche die entsprechende Wohnung:

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
    "name": "[Name Mieter]",
    "email": "mieter2@beispiel.invalid",
    "telefon": "+41 79 XXX XX XX",
    "typ": "mieter",
    "berechtigt": false    ← HIER
  }
}
```

#### 3. Berechtigung erteilen

Ändere `"berechtigt": false` zu `"berechtigt": true`:

```json
"mieter": {
  "name": "Maria Muster",
  "email": "maria.muster@gmail.com",
  "telefon": "+41 79 345 67 89",
  "typ": "mieter",
  "berechtigt": true    ← Berechtigung erteilt!
}
```

#### 4. Kontaktdaten aktualisieren

Ersetze die Platzhalter mit echten Daten:

```json
"mieter": {
  "name": "Maria Muster",              ← Echter Name
  "email": "maria.muster@gmail.com",   ← Echte E-Mail
  "telefon": "+41 79 345 67 89",       ← Echte Telefonnummer
  "typ": "mieter",
  "berechtigt": true
}
```

#### 5. Datum aktualisieren

```json
"metadaten": {
  "letzte_änderung": "2025-11-04"    ← Heutiges Datum
}
```

#### 6. Speichern

- Über **Admin-Bereich**: Automatisch gespeichert
- Über **Git**: Commit & Push erforderlich

## ⛔ Berechtigung entziehen

### Über Admin-Bereich

1. Öffne [Admin-Bereich](https://rosenweg4303.ch/stweg3/admin.html)
2. Wähle die Wohnung
3. Entferne Häkchen bei **☑️ Mieter hat Zugriff auf Kontaktliste**
4. Speichern

### Manuell

Setze `"berechtigt": false`:

```json
"mieter": {
  "name": "Hans Meier",
  "email": "hans.meier@beispiel.ch",
  "telefon": "+41 79 234 56 78",
  "typ": "mieter",
  "berechtigt": false    ← Zugriff entzogen
}
```

## 📊 Aktueller Status prüfen

### Über Admin-Bereich

Im Admin-Bereich siehst du alle Wohnungen auf einen Blick:
- Welche Wohnungen Mieter haben
- Ob Mieter berechtigt sind

### Manuell

Durchsuche `kontakte.json` nach `"berechtigt": true`.

## 🔄 Häufige Änderungen

### Mieter zieht aus

**Option A - Admin-Bereich:**
1. Wohnung bearbeiten
2. Mieter-Daten auf Platzhalter setzen:
   - Name: `[Name Mieter]`
   - E-Mail: `mieter-XX@beispiel.invalid`
   - Telefon: `+41 79 XXX XX XX`
3. **Berechtigung entfernen** (Häkchen raus)
4. Speichern

**Option B - JSON:**
```json
"mieter": {
  "name": "[Name Mieter]",
  "email": "mieter-eg2@beispiel.invalid",
  "telefon": "+41 79 XXX XX XX",
  "typ": "mieter",
  "berechtigt": false
}
```

**Option C - Mieter komplett entfernen:**
```json
"mieter": null
```

### Mieter zieht ein

1. Kontaktdaten vom Eigentümer/Verwaltung anfordern
2. Über Admin-Bereich eintragen
3. Ausschuss entscheidet über Berechtigung
4. Bei Zustimmung: Berechtigung erteilen
5. Mieter informieren

### Eigentümerwechsel

**Wichtig**: Eigentümer sind **immer** automatisch berechtigt!

1. Eigentümer-Daten aktualisieren
2. Falls Mieter vorhanden: Prüfen, ob berechtigt bleiben soll
3. Datum aktualisieren

```json
"eigentümer": {
  "name": "Neuer Eigentümer",
  "email": "neu@beispiel.ch",
  "telefon": "+41 79 999 88 77",
  "typ": "eigentümer"
}
```

### Mehrere E-Mail-Adressen

Du kannst mehrere E-Mails kommagetrennt angeben:

```json
"mieter": {
  "name": "Max Muster",
  "email": "max@privat.ch,max@firma.ch",
  "telefon": "+41 79 123 45 67",
  "typ": "mieter",
  "berechtigt": true
}
```

Beide E-Mails haben dann Zugriff!

## 📝 Mieter-Antrag bearbeiten

### Antrag-Vorlage für Mieter

Wenn ein Mieter Zugriff beantragt:

```
Betreff: Antrag auf Zugriff zur Kontaktliste STWEG 3

Sehr geehrte Ausschussvertreter,

ich bin Mieter der Wohnung [Wohnungsbezeichnung] und möchte
um Zugriff auf die geschützte Kontaktliste der STWEG 3 bitten.

Meine Kontaktdaten:
- Name: [Vollständiger Name]
- E-Mail: [E-Mail-Adresse]
- Telefon: [Telefonnummer]
- Wohnung: [z.B. EG.2]
- Eingezogen am: [Datum]

Mit freundlichen Grüßen
[Name]
```

### Antrag bearbeiten

1. **Prüfung**: Ist der Mieter tatsächlich eingezogen?
2. **Ausschussbeschluss**: Abstimmung (z.B. per E-Mail)
3. **Bei Zustimmung**:
   - Berechtigung erteilen (siehe oben)
   - Mieter informieren
   - Test durchführen lassen
4. **Bei Ablehnung**:
   - Mieter informieren mit Begründung

## ✅ Checkliste: Neue Mieter berechtigen

- [ ] Mieter-Kontaktdaten erhalten (Name, E-Mail, Telefon)
- [ ] Ausschussbeschluss einholen
- [ ] [Admin-Bereich](https://rosenweg4303.ch/stweg3/admin.html) öffnen
- [ ] Mit Ausschuss-E-Mail anmelden
- [ ] Wohnung auswählen
- [ ] Mieter-Daten eintragen
- [ ] Berechtigung erteilen (Häkchen setzen)
- [ ] Änderungen speichern
- [ ] JSON speichern
- [ ] Mieter informieren und Link senden
- [ ] Mieter testen lassen

## 🤔 Häufige Fragen

### Warum haben Mieter nicht automatisch Zugriff?

**Datenschutz**: Die Kontaktliste enthält sensible Daten aller Bewohner (Namen, E-Mails, Telefonnummern). Der Ausschuss entscheidet im Einzelfall, welche Mieter Zugriff erhalten sollen.

### Kann ich mehreren Mietern gleichzeitig Zugriff geben?

Ja, bearbeite einfach jede Wohnung einzeln im Admin-Bereich. Die Änderungen werden zusammen gespeichert.

### Was passiert, wenn ich versehentlich einen Fehler mache?

Keine Sorge! Alle Änderungen werden in Git versioniert:
- Du kannst ältere Versionen wiederherstellen
- Kontaktiere den technischen Dienst im Notfall

### Wie schnell sind Änderungen sichtbar?

- **Über Admin-Bereich**: Sofort nach Speichern
- **Über Git**: Nach Push (GitHub Actions braucht ~2 Minuten)

### Kann ich auch Ausschussvertreter ändern?

Ja, aber **vorsichtig**! Ausschussvertreter sind im Bereich `ausschuss` definiert und haben Admin-Zugang. Änderungen sollten nur nach offiziellem Beschluss erfolgen.

## 🔒 Datenschutz & Sicherheit

### Was wird protokolliert?

Alle Änderungen über den Admin-Bereich:
- Wer hat geändert (E-Mail-Adresse)
- Wann wurde geändert (Zeitstempel)
- Was wurde geändert (Git-Diff)

### Wer sieht die Protokolle?

Nur Personen mit Zugriff aufs Git-Repository.

### Platzhalter-E-Mails

**Wichtig**: Platzhalter **müssen** `.invalid` Domain verwenden:

```
mieter-eg1@beispiel.invalid
eigentuemer-placeholder@beispiel.invalid
```

Diese werden automatisch vom OTP-System gefiltert und erhalten keine E-Mails.

## 📚 Weiterführende Links

- **[STWEG3 Admin-Bereich](STWEG3-Admin)** - Admin-Anleitung
- **[STWEG3 Kontaktliste](STWEG3-Kontaktliste)** - Für Bewohner
- **[n8n OTP-Setup](n8n-OTP-Setup)** - Technische Details

## 📞 Support

Bei Problemen:

**Technischer Dienst Rosenweg**
- Stefan Müller
- E-Mail: stefan+rosenweg@juroct.ch
- Telefon: +41 76 519 99 70
