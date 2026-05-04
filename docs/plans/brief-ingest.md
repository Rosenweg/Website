# Brief-Ingest — Email-basiertes Erfassen versendeter Briefe

## Ziel

Versendete Briefe (vor allem A-Post Plus mit Tracking) per Foto erfassen, Inhalte
automatisch auslesen, sauber benennen und auf dem Fileserver ablegen. Der
Versand der Fotos erfolgt **per Mail an eine eigene Adresse** — Workflow ist
mobiltauglich (Foto → Mail → fertig).

Die spätere Sendungsverfolgung baut auf dem hier extrahierten Tracking-Code auf
(siehe Phase 4); die eigentliche Track-&-Trace-Anzeige ist bewusst ausgelagert.

## Architektur

```
Smartphone (Foto vom Brief)
    │
    ▼ Mail an briefe@rosenweg4303.ch
Cloudflare Email Routing
    │
    ▼ Catch-All
Gmail rosenweg4303@gmail.com
    │
    ▼ IMAP Polling (60s, bestehender API-Poller)
API Server  (api/server.js)
    ├── Filter: To: enthält "briefe@" oder Plus-Tag "+briefe"
    ├── Anhänge extrahieren (JPEG/PNG/HEIC/PDF)
    ├── PDF → JPEG (eine Seite = ein JPEG, ImageMagick/poppler)
    ├── HEIC → JPEG (libheif)
    ├── Claude Vision API: Empfänger / Absender / Tracking / Versandart
    ├── Validierung (Tracking-Regex, Pflichtfelder)
    ├── Datei umbenennen + ablegen unter
    │   //100.64.2.28/dokumente/allgemein/fotos_von_versendeten_briefen/
    ├── Eintrag in DB-Tabelle  brief_versand
    └── Bestätigungsmail zurück an Absender (mit Tracking-Link)
```

## Email-Adresse

- **Neu:** `briefe@rosenweg4303.ch`
- **Routing:** läuft über bestehende Cloudflare-Catch-All → Gmail. Keine neue
  Cloudflare-Route nötig.
- **Erkennung im Poller:** zusätzlicher Branch in der bestehenden Plus-Tag-Logik
  (`rosenweg4303+briefe@gmail.com` ODER `To: briefe@rosenweg4303.ch`).
- **Berechtigung:** Sender-Adresse muss in der Gruppe `ausschuss` oder
  `verwaltung` sein. Andere Sender → Reject-Mail mit kurzem Hinweis.

## Eingangsformate

| Format         | Behandlung                                                      |
|----------------|------------------------------------------------------------------|
| JPEG / JPG     | direkt verwenden                                                 |
| PNG            | nach JPEG (qualität 92, sRGB) konvertieren                       |
| HEIC / HEIF    | via `libheif` → JPEG                                             |
| PDF (1 Seite)  | via `pdftoppm -jpeg -r 200` → JPEG                               |
| PDF (>1 Seite) | jede Seite einzeln → JPEG, jede Seite einzeln durch Vision-Pipe |

**Output ist immer JPEG.** Keine PDFs auf dem Fileserver (Wunsch User
2026-05-04). Originale aus dem Mail-Anhang werden nach erfolgreicher
Konvertierung verworfen — die rekonstruierten JPEGs sind die Quelle der
Wahrheit.

## Vision-API (Claude)

**Modell:** `claude-haiku-4-5-20251001` (günstig genug für Volumen, ausreichend
für gedruckte Etiketten + handschriftliche Adressen).

**Prompt-Skelett:**

```
Analysiere das Foto eines versendeten Briefes (Schweizer Post).
Extrahiere als JSON:

{
  "empfaenger": { "name": "...", "strasse": "...", "plz": "...", "ort": "..." },
  "absender":   { "name": "...", "strasse": "...", "plz": "...", "ort": "..." },
  "tracking":   "98.xx.xxxxxx.xxxxxxxx",
  "versandart": "A-Post Plus" | "A-Post" | "B-Post" | "Einschreiben" | "unbekannt",
  "webstamp_code": "...",          // optional, falls "WebStamp" sichtbar
  "porto_chf":     null | 2.90,    // optional
  "datum_sichtbar": null | "YYYY-MM-DD",   // falls Datum erkennbar
  "qualitaet":     "ok" | "unscharf" | "abgeschnitten" | "kein_brief",
  "notiz":         "..."           // freier Text bei Auffälligkeiten
}

Trackingnummer-Format: "98." + 2 Ziffern + "." + 6 Ziffern + "." + 8 Ziffern.
Wenn nicht eindeutig lesbar → null. Nicht raten.
```

**Validierung nach der Antwort:**

- Tracking-Regex `^98\.\d{2}\.\d{6}\.\d{8}$` erzwingen.
- Empfänger-PLZ Schweizer Format (4 Ziffern) ODER ausländisch akzeptiert.
- `qualitaet != "ok"` → Datei landet in `_zur_pruefung/` statt im Hauptordner;
  Bestätigungsmail meldet "konnte nicht zuverlässig erkannt werden".

## Datei-Benennung

Schema: `YYYY-MM-DD_<empfaenger-slug>_<tracking>.jpeg`

Beispiele:
- `2026-05-03_roland-britt_98.01.018499.70589372.jpeg`
- `2026-05-03_andrea-henzi_98.01.018499.70589401.jpeg`

Regeln für `<empfaenger-slug>`:
- Klein, ASCII, Bindestrich-getrennt.
- Umlaute: `ä→ae`, `ö→oe`, `ü→ue`, `ß→ss`.
- Bei Eheleuten / Doppelnamen: max. 40 Zeichen, ggf. abschneiden.
- Bei fehlendem Tracking: `_no-tracking_<hash8>` anstelle der Nummer.

Datum = Versanddatum, ermittelt in dieser Reihenfolge:
1. Aus Bild erkennbares Datum (`datum_sichtbar`)
2. Mail-Datum des eingehenden Mails (Header `Date:`)
3. Heutiges Datum

## Speicherort

Hauptordner (bestehend):
`\\100.64.2.28\dokumente\allgemein\fotos_von_versendeten_briefen\`

Neue Unterordner:
- `_zur_pruefung/` — unscharf / nicht erkannt
- `_archiv-original-mail/<YYYY-MM>/` — komplette EML der Eingangsmail (für
  Nachvollziehbarkeit, kein Web-Zugriff)

## Datenbank

Neue Tabelle (Postgres, Schema `rosenweg`):

```sql
CREATE TABLE brief_versand (
    id              SERIAL PRIMARY KEY,
    versand_datum   DATE NOT NULL,
    empfaenger_name TEXT NOT NULL,
    empfaenger_adresse TEXT,
    absender_name   TEXT,
    tracking        TEXT UNIQUE,
    versandart      TEXT,
    porto_chf       NUMERIC(6,2),
    bild_pfad       TEXT NOT NULL,        -- relativ zu /allgemein/...
    eingang_email   TEXT,                 -- Sender der Mail
    qualitaet       TEXT,
    raw_json        JSONB,                -- volle Vision-Antwort
    erstellt_am     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX brief_versand_tracking_idx ON brief_versand(tracking);
CREATE INDEX brief_versand_datum_idx    ON brief_versand(versand_datum DESC);
```

## Bestätigungsmail

Geht nach Verarbeitung an den Mail-Sender (innerhalb ~2 Min). Beispieltext:

```
Hoi,

3 Briefe verarbeitet:

  ✓  Roland Britt, 6332 Hagendorn      98.01.018499.70589372
     → https://service.post.ch/EasyTrack/submitParcelData.do?formattedParcelCodes=98.01.018499.70589372
  ✓  Andrea Henzi, 5400 Baden          98.01.018499.70589401
     → ...
  ⚠  1 Bild war unscharf (IMG_5023.jpeg) — bitte erneut zusenden.

Liebs Grüessli, Brief-Ingest
```

## Phasen

| Phase | Inhalt                                                               | Status   |
|-------|----------------------------------------------------------------------|----------|
| 1     | Plan (dieses Dokument)                                               | erledigt |
| 2     | Bestand-Backfill: bestehende ~36 Bilder lokal benennen               | offen    |
| 3     | Email-Adresse + IMAP-Branch + Vision-Pipeline + DB-Tabelle           | offen    |
| 4     | Webseite `briefe.html` mit Tabelle + Tracking-Links (EasyTrack)      | offen    |
| 5     | Optional: echte Track-&-Trace-API der Post (OAuth, Live-Status)      | später   |

Phase 2 ist ein einmaliges Script (lokal auf dem Windows-PC, da `B:\` schon
gemountet ist) — kein Service nötig. Phase 3 läuft im bestehenden API-Container.

## Offene Punkte

- **HEIC-Support im API-Container:** Image `node:20-alpine` hat kein libheif —
  entweder Image wechseln oder HEIC im Cloudflare-Worker bereits konvertieren.
- **Sender-Validierung:** Soll auch `verwaltung@rosenweg4303.ch`-Mitglieder
  (statt nur Ausschuss) Briefe einreichen dürfen? Default vorerst: ja.
- **Mehrere Briefe in einem Foto:** Vorerst nicht unterstützt — ein Foto = ein
  Brief. Vision-Antwort `qualitaet: "kein_brief"` fängt grobe Fälle ab.
- **Kosten Claude Haiku Vision:** Schätzung ~0.005 CHF pro Bild → bei 200
  Briefen/Jahr vernachlässigbar.
