# Beispielmappe – Dokumente der Rosenweg-Plattform

Erzeugt `docs/beispielmappe/Beispielmappe-Rosenweg.pdf`: eine PDF-Mappe für die
Liegenschaftsverwaltung mit allen Dokumenten, die die Plattform erzeugt. Die Mappe
hat ein Deckblatt, eine Einleitung, ein Inhaltsverzeichnis und ein Kapitel pro
Dokumentart (Steckbrief plus Muster).

**Alle Personen- und Wohnungsdaten sind frei erfunden** und stehen in
`musterdaten.json`. E-Mail-Adressen nutzen die reservierte Endung `.example`;
IP-Adressen stammen aus Dokumentationsbereichen (RFC 3849 / RFC 5737).

## Aufruf

```bash
pip install pypdf qrcode pillow   # einmalig
python3 scripts/beispielmappe/build.py
```

Voraussetzungen:
- Python 3.10 oder neuer.
- Chromium oder Chrome. Wird automatisch gesucht; sonst die Umgebungsvariable
  `CHROMIUM=/pfad/zu/chromium` setzen.
- Beim ersten Lauf Internetzugang. Damit werden die Schriften Inter und Noto
  Color Emoji nach `.cache/fonts/` geladen; der Ordner ist nicht im Repo. Für
  den Screenshot der Echtheitsprüfung lädt die Seite zudem Tailwind vom CDN.

Node.js und eine Datenbank sind nicht nötig.

## Wie die Muster entstehen

| Kapitel | Quelle | Verfahren |
|---|---|---|
| Vollmachten (generell, spezifisch, Auskunft) | `buildVollmachtHtml()` in `api/server.js` | Funktion wird als Quelltext extrahiert und in Chromium ausgeführt |
| Unterschriftenliste | `buildUnterschriftenlisteHTML()` | Replay-Pfad mit erfundenem Snapshot; Muster-Hash = SHA-256 über den Snapshot (12 Zeichen) |
| Echtheitsprüfung | `echtheitspruefung.html` | Screenshot über einen lokalen Webserver; die Antwort von `/api/unterschriftenliste/verify-json` wird mit den Musterdaten nachgebildet |
| Deckblatt Druckauftrag | Vorlage `coverHtml` im IMAP-Druckablauf | Code-Block wird extrahiert, Variablen aus `musterdaten.json` |
| Mail-Vorlagen | `renderTemplate()` + `MAIL_TEMPLATE_DEFAULTS` | Rendern der Standardvorlagen, Darstellung als Mail-Ansicht |
| Aushang | `aushang-verwaltungswechsel.html` | Direkt gedruckt; Firmen und Kontakte durch Musterwerte ersetzt |
| Türschilder | `door-signs/*.html` | Direkt gedruckt |
| Waschküche-Poster | `stweg3/pages/waschkueche-poster-a4.html` | Auf eine lange Seite gedruckt (Inhalt ca. 405 mm), dann auf A4 verkleinert |
| Excel / vCard | `objektverwaltung.html` (`exportXLSX`), `buildVCard` in `api/server.js` | Kleiner Ausschnitt; die vCard wird in Python nach demselben Schema erzeugt |

Externe Abhängigkeiten werden beim Rendern ersetzt:
- Logo-URL → `logo-rosenweg.png` als data-URI, verkleinert auf 420 px.
- Google Fonts → lokale Inter-Schrift.
- `api.qrserver.com` → lokal erzeugter QR-Code mit identischem Inhalt.

`api/server.js` wird nur gelesen, nie verändert. Ändert sich eine Vorlage im
Server, zeigt ein neuer Lauf automatisch den neuen Stand.

Zum Schluss werden alle Seiten auf A4 gebracht, Seitenzahlen ergänzt und die
Musterseiten mit dem Schriftzug «MUSTER» überlagert.

## Datenschutz-Prüfung vor dem Einchecken

```bash
python3 -c "from pypdf import PdfReader; print('\n'.join(p.extract_text() for p in PdfReader('docs/beispielmappe/Beispielmappe-Rosenweg.pdf').pages))" \
  | grep -oiE '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}' | sort -u
```

Erlaubt sind nur:
- Adressen auf `.example`.
- Rollenadressen der Plattform: `noreply@`, `ausschuss@` und `technik@` sowie `druckerr9+…`.
