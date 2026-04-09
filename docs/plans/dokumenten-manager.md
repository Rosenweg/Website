# Dokumenten-Manager (OpenClaw)

## Ziel

Ein KI-gestützter Dokumenten-Manager der automatisch eingehende Dokumente verarbeitet, klassifiziert, benennt und einsortiert.

## Email-Adresse

`docs@rosenweg4303.ch` (oder `claw@rosenweg4303.ch`)

## Funktionen

### 1. Dokumenten-Eingang
- Email-Anhänge empfangen (PDF, JPG, PNG, DOCX)
- Scans-Ordner auf Fileserver überwachen
- Manuelle Uploads über die Website

### 2. Klassifizierung
Automatische Erkennung des Dokumenttyps:
- Kontaktdaten-Formular → Daten extrahieren, DB-Import
- Protokoll (Haussitzung, GV) → Datum, STWEG, Typ erkennen
- Rechnung/Abrechnung → Betrag, Periode, Lieferant
- Vertrag/Reglement → Art, STWEG, Version
- Urkunde → Typ (Begründung, Nutzungsordnung)
- Korrespondenz/Brief → Absender, Empfänger, Betreff
- Scan (allgemein) → Beschreibung generieren

### 3. Benennung
Einheitliches Namensschema:
```
YYYY-MM-DD-typ-beschreibung-stwegX.pdf
```
Beispiele:
- `2026-04-08-kontaktdaten-limbach-ingrid-rosenweg13-stweg2.pdf`
- `2026-03-15-protokoll-haussitzung-stweg3.pdf`
- `2026-01-01-jahresrechnung-2025-stweg3.pdf`
- `2025-06-17-protokoll-ordentliche-versammlung-stweg3.pdf`
- `urkunde-stockwerkeigentumsbegruendung-stweg1.pdf`

### 4. Einsortierung
Ordnerstruktur:
```
/srv/documents/
├── allgemein/
│   ├── anleitungen/
│   ├── logos/
│   ├── pflichtenheft/
│   ├── schilder/
│   └── urkunden/
├── archiv/                    ← nur temporär, wird vom Agent geleert
├── Scans/                     ← Eingang vom Scanner
├── stweg1/
│   ├── 01-stammdaten/
│   ├── 02-servicevertraege/
│   ├── 03-protokolle/
│   ├── 04-versicherungen/
│   ├── 05-abrechnungen/
│   └── 99-kontaktdaten/
├── stweg2/ ... stweg8/
└── (gleiche Struktur)
```

### 5. Daten-Extraktion
Bei Kontaktdaten-Formularen:
- Name, Adresse, Wohnung, STWEG
- Email, Telefon (Mobil + Festnetz)
- Einstellhallenplatz, Hobbyraum
- Vermietet ja/nein
- → Automatischer DB-Import via API

### 6. Qualitätskontrolle
- Seiten-Orientierung prüfen und korrigieren (180° gedreht)
- Duplikat-Erkennung (gleicher Name, ähnlicher Inhalt)
- Unsichere OCR-Ergebnisse markieren
- Zusammenfassung des Dokumentinhalts speichern

### 7. Website-Pflege
Bei relevanten Dokumenten automatisch die Website aktualisieren:
- **Protokolle**: Auf der STWEG-Seite verlinken (z.B. stweg3/index.html)
- **Neue Kontaktdaten**: Kontaktliste auf der Website aktualisieren
- **Reglemente/Verträge**: In der Dokumenten-Übersicht auf der Website anzeigen
- **Einladungen**: Auf der Startseite oder STWEG-Seite als Aktuell anzeigen
- Git Commit + Push + Deploy auslösen wenn Website-Dateien geändert werden

### 8. Benachrichtigungen
- Email-Bestätigung an Absender: "3 Dokumente verarbeitet"
- Wöchentliche Zusammenfassung an Technik: neue Dokumente
- Alert bei unbekannten Dokumenttypen

## Technische Umsetzung

### LXC Container
- **CT ID**: 113
- **Hostname**: claw-document-manager
- **IP**: 100.64.2.33
- **PVE Node**: pve3 (am wenigsten belastet)
- **Storage**: lxcs (Ceph)
- **RAM**: 2GB
- **Disk**: 8GB
- **Cores**: 2

### Software
- OpenClaw (https://openclaw.ai/)
- OpenRouter API für LLM-Zugriff (Vision + Text)
- pdftk für PDF-Manipulation
- Python für Glue-Code
- CIFS-Mount zum Fileserver

### Integration
- IMAP-Poller im API-Server erkennt `docs@rosenweg4303.ch`
- Leitet Anhänge an OpenClaw weiter (via HTTP API oder Filesystem)
- OpenClaw verarbeitet und meldet Ergebnis zurück
- API-Server importiert extrahierte Daten in DB

### Email-Flow
```
docs@rosenweg4303.ch
    → Cloudflare Email Routing → Gmail
    → IMAP Poller erkennt docs@
    → Anhänge auf Fileserver speichern (/srv/documents/Scans/)
    → OpenClaw benachrichtigen (Webhook oder Filesystem-Watch)
    → OpenClaw analysiert, benennt, einsortiert
    → API Call für DB-Import
    → Bestätigungs-Email an Absender
```

## Offene Fragen
- [ ] OpenRouter API Key
- [ ] OpenClaw Installation und Konfiguration
- [ ] Welches LLM-Modell für Vision? (Claude Sonnet, GPT-4o, etc.)
- [ ] Soll der Agent auch bestehende Dokumente nachträglich analysieren?
- [ ] Soll er auch auf WhatsApp erreichbar sein?
