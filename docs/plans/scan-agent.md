# Scan Processing Agent

## Ziel

Automatische Verarbeitung von gescannten Kontaktdaten-Formularen:
- Neue PDFs im Scans-Ordner erkennen
- Seiten-Orientierung korrigieren (Rückseiten 180° drehen)
- Formulare pro Person aufteilen (je 2 Seiten)
- Sinnvoll benennen: `kontaktdaten-nachname-vorname-rosenwegX-stwegY.pdf`
- In den richtigen `stweg*/99-kontaktdaten/` Ordner verschieben
- Kontaktdaten in die Datenbank importieren

## Architektur

```
Fileserver (/srv/documents/Scans/)
    │
    ▼ inotifywait / Polling (alle 60s)
Scan Agent (LXC oder Docker)
    │
    ├── 1. PDF analysieren (Seitenanzahl, Orientierung)
    ├── 2. OCR / Vision API (Formular-Daten extrahieren)
    ├── 3. pdftk: Seiten drehen + aufteilen
    ├── 4. Dateien umbenennen + in STWEG-Ordner verschieben
    └── 5. API Call → Daten in DB importieren
```

## Agent-Prompt (für Claude API / LLM)

```
Du bist ein Dokumenten-Verarbeitungs-Agent für die STWEG-Kooperation Rosenweg.

### Aufgabe
Verarbeite gescannte PDF-Formulare im Ordner /srv/documents/Scans/.
Jedes Formular ist ein "Kontaktdaten Eigentümer"-Formular mit 2 Seiten:
- Seite 1 (Vorderseite): Persönliche Angaben, Adresse
- Seite 2 (Rückseite): Kontaktdaten, Bemerkungen, Unterschrift

### Regeln für die Verarbeitung

1. **Orientierung erkennen**:
   - Vorderseiten sind aufrecht (Logo oben, "STWEG-Kooperation Rosenweg" Überschrift)
   - Rückseiten sind oft um 180° gedreht (Text auf dem Kopf)
   - Wenn eine Seite auf dem Kopf steht, drehe sie um 180°

2. **Formulare trennen**:
   - Ein PDF kann mehrere Formulare enthalten (jeweils 2 Seiten)
   - Trenne nach Personen: jede Person bekommt ein eigenes 2-Seiten-PDF
   - Manchmal ist die Reihenfolge vertauscht (Rückseite vor Vorderseite)

3. **Daten extrahieren** (aus den handschriftlichen Einträgen):
   - Vorname, Nachname
   - Rosenweg Nr. (Hausnummer)
   - STWEG Nr.
   - Wohnung/Einheit (z.B. "2. Stock links", "Parterre rechts")
   - Einstellhallenplatz (Nummer)
   - Hobbyräume
   - Vermietet (Ja/Nein)
   - E-Mail-Adresse
   - Telefon (Mobil)
   - Telefon (Festnetz)
   - Bemerkungen

4. **Datei benennen**:
   Format: `kontaktdaten-nachname-vorname-rosenwegX-stwegY.pdf`
   - Nachname kleingeschrieben, Umlaute: ü→ue, ö→oe, ä→ae
   - Bei Doppelnamen: `kontaktdaten-weber-egger-rose-marie-rosenweg8-stweg5.pdf`
   - Bei Paaren: `kontaktdaten-mueller-hans-maria-rosenweg9-stweg3.pdf`

5. **STWEG-Zuordnung** (Rosenweg Nr. → STWEG):
   - RW1 → STWEG 6
   - RW2 → STWEG 7
   - RW4 → STWEG 7
   - RW5 → STWEG 5
   - RW6 → STWEG 5
   - RW8 → STWEG 5
   - RW9 → STWEG 3
   - RW10 → STWEG 4
   - RW12 → STWEG 4
   - RW13 → STWEG 2
   - RW14 → STWEG 2
   - RW16 → STWEG 2
   - RW17 → STWEG 1
   - RW18 → STWEG 1

6. **Zielordner**: `/srv/documents/stweg{N}/99-kontaktdaten/`

7. **Datenbank-Import**: POST an die API mit den extrahierten Daten
```

## Technische Umsetzung

### Option A: Claude API Agent (empfohlen)

LXC Container mit Python-Script das:
1. `/srv/documents/Scans/` per inotify oder Polling überwacht
2. Neue `BRW*.pdf` Dateien erkennt
3. Jede Seite als Bild rendert (pdf2image/poppler)
4. Bilder an Claude Vision API sendet zur Analyse
5. Basierend auf der Antwort: pdftk für Rotation/Split
6. Dateien verschiebt und API aufruft

```python
# Pseudo-Code
import anthropic
from pdf2image import convert_from_path
import subprocess, json, requests

client = anthropic.Anthropic(api_key="...")

def process_scan(pdf_path):
    # 1. Render pages as images
    images = convert_from_path(pdf_path)
    
    # 2. Send to Claude Vision
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=4096,
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": AGENT_PROMPT},
                *[{"type": "image", "source": {"type": "base64", "data": img_to_base64(img)}} for img in images]
            ]
        }]
    )
    
    # 3. Parse response (JSON with page analysis + contact data)
    result = json.loads(response.content[0].text)
    
    # 4. Process PDFs based on analysis
    for form in result["forms"]:
        # Rotate pages, split, rename, move
        ...
    
    # 5. Import to DB
    for contact in result["contacts"]:
        requests.post("http://api:3000/api/users", json=contact, headers=...)
```

### Option B: Lokaler OCR + Regelbasiert

Ohne Cloud-API, aber weniger genau bei Handschrift:
1. Tesseract OCR für Texterkennung
2. Regelbasierte Extraktion (Positionen der Felder sind bekannt)
3. Orientierung über Logo-Erkennung (OpenCV)

### Option C: n8n Workflow

n8n auf bestehendem LXC:
1. File Trigger auf Scans-Ordner
2. HTTP Request an Claude API
3. Code Node für pdftk-Verarbeitung
4. HTTP Request an Rosenweg API

## Ressourcen

### LXC Container
- **CT ID**: 112
- **Hostname**: scan-agent
- **IP**: 100.64.2.33
- **RAM**: 1GB
- **Disk**: 4GB (lxcs Storage)
- **Pakete**: python3, python3-pip, pdftk, poppler-utils
- **Python**: anthropic, pdf2image, requests, inotify

### API Endpoints (bestehend)
- `POST /api/users` — Benutzer erstellen/aktualisieren
- Authentik API Token für Auth

### Kosten (Option A)
- Claude Sonnet: ~$0.003 pro Formular-Seite (Vision)
- ~$0.05 pro Scan-Batch (14 Seiten)
- Bei 50 Formularen/Monat: ~$2.50/Monat

## Erweiterungsmöglichkeiten

- **Andere Dokumenttypen**: Nicht nur Kontaktdaten, auch Protokolle, Rechnungen etc.
- **Automatische Klassifizierung**: Agent erkennt Dokumenttyp und verarbeitet entsprechend
- **Email-Benachrichtigung**: Zusammenfassung der verarbeiteten Formulare per Mail
- **Qualitätskontrolle**: Agent markiert unsichere OCR-Ergebnisse zur manuellen Prüfung
- **Duplikat-Erkennung**: Prüft ob Person schon existiert und mergt Daten
