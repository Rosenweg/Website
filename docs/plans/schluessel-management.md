# Schlüssel-Management Rosenweg

> **Ziel:** Nach dem chaotischen Verwaltungswechsel soll dauerhaft sichergestellt sein,
> dass die Schlüssel — und vor allem das *Wissen* über die Schlüssel — **im Rosenweg
> verbleiben**. Die Eigentümergemeinschaft besitzt und kontrolliert das Register, nicht
> die jeweilige Verwaltung.
>
> **Status:** Konzept (noch kein Code). Baut auf bestehender Infrastruktur auf
> (`access.html`, UniFi Access / UA Ultra, Schlüsselkasten R9 UG, DB `rosenweg` mit
> Audit-Trigger, Authentik-Gruppen, WhatsApp-Bot, Mail).

---

## 1. Problemanalyse — drei getrennte Ebenen

Das Chaos beim Verwaltungswechsel war *nicht primär* der physische Schlüssel, sondern
dass niemand mehr wusste, **welche Schlüssel existieren, wie viele Kopien es gibt und wer
sie hält**. Dieses Wissen ging mit der alten Verwaltung verloren. „Schlüssel im Rosenweg
verbleiben" hat deshalb drei Ebenen, die getrennt gelöst werden müssen:

| Ebene | Frage | Lösung |
|-------|-------|--------|
| **1. Wissen (Governance)** | Welche Schlüssel gibt es, wer hat sie? | Digitaler Schlüsselkataster (Kern) |
| **2. Physisch** | Wo liegen die Metallstücke? | Schlüsseldepot am Objekt |
| **3. Entkopplung** | Braucht es überhaupt Metallschlüssel? | Elektronische Zutritte |

Der wichtigste Hebel ist **Ebene 1**: solange das Register der Gemeinschaft gehört und
scoped an die Verwaltung vergeben wird, kann kein Wechsel mehr Wissen mitnehmen.

---

## 2. Ebene 1 — Digitaler Schlüsselkataster (Herzstück)

### 2.1 Prinzip

- Das Register ist **Eigentum der STWEG-Kooperation**, technisch in DB `rosenweg`.
- Die Verwaltung erhält nur **scoped Schreibzugriff** über eine Authentik-Gruppe
  (analog zu `*-ausschuss`). Wechsel = Gruppe entziehen, Daten bleiben.
- **Vollständiger Audit-Trail** ist über die bestehenden DB-Trigger
  (`app.user_email`) automatisch gegeben.
- Jeder physische Schlüssel trägt einen **QR-Anhänger**, der auf seinen Register-Eintrag
  verlinkt → jeder Schlüssel ist selbsterklärend rückverfolgbar.

### 2.2 Datenmodell (Entwurf)

```
schliessanlage            -- eine Schließanlage / ein Schließplan pro Gebäude/Bereich
├─ id
├─ stweg_nr               -- FK auf site-config stwegen[].nr (1..7 / TG)
├─ bezeichnung            -- "STWEG 3 Haupteingang", "Tiefgarage", "Waschküche R9"
├─ hersteller             -- z.B. Kaba, SimonsVoss, Dom
├─ anlagen_nr             -- Schließanlagen-Nummer des Herstellers
├─ typ                    -- mechanisch | mechatronisch | elektronisch
├─ nachbestellung         -- Sicherungskarte-Nr / Bezugsberechtigung
└─ notizen

zylinder                  -- einzelne Türen/Schlösser innerhalb einer Anlage
├─ id
├─ schliessanlage_id      -- FK
├─ tuer_bezeichnung       -- "Haustür", "Keller 3.02", "Technikraum"
├─ standort               -- Gebäude/Stockwerk
└─ status                 -- aktiv | ausgebaut | defekt

schluessel                -- ein physischer Schlüssel-*Typ* (Schließberechtigung)
├─ id
├─ schliessanlage_id      -- FK
├─ schluessel_nr          -- Prägung / laufende Nr am Schlüssel
├─ bezeichnung            -- "Generalhauptschlüssel", "Wohnungsschlüssel Whg 3.2"
├─ schliesst_zylinder[]   -- welche Zylinder dieser Schlüssel öffnet (n:m)
├─ soll_anzahl            -- wie viele Kopien DÜRFEN existieren
├─ ist_anzahl             -- wie viele existieren tatsächlich (abgeleitet)
├─ sicherheitsstufe       -- normal | erhöht (nur gegen Sicherungskarte kopierbar)
└─ notizen

schluessel_exemplar       -- ein konkretes Metallstück (eine Kopie)
├─ id
├─ schluessel_id          -- FK
├─ laufnr                 -- "3 von 5"
├─ qr_token               -- eindeutiger Token für QR-Anhänger
└─ status                 -- im_depot | ausgegeben | verloren | eingezogen | zerstoert

schluessel_ausgabe        -- Ausgabe-/Rücknahme-Vorgänge (Historie)
├─ id
├─ exemplar_id            -- FK
├─ halter_typ             -- eigentuemer | mieter | verwaltung | handwerker | ausschuss | extern
├─ halter_person_id       -- FK auf personen (falls im System)
├─ halter_name            -- Freitext-Fallback
├─ ausgegeben_am
├─ ausgegeben_von         -- User-Email (Audit)
├─ quittung               -- digitale Unterschrift / bestätigt-am
├─ rueckgabe_faellig_am   -- optional, für Handwerker (Erinnerung)
├─ zurueck_am             -- NULL = noch draußen
├─ zurueck_an             -- User-Email
└─ notizen
```

Ableitungen: `ist_anzahl` = Anzahl `schluessel_exemplar` mit Status ≠ verloren/zerstört;
**Alarm wenn `ist_anzahl > soll_anzahl`** (unkontrollierte Kopie) oder wenn ein Exemplar
als `verloren` markiert ist, das eine sicherheitsrelevante Anlage öffnet → Empfehlung
Schließanlagen-Tausch.

### 2.3 Kern-Funktionen

- **Schlüssel ausgeben** (an Mieter/Handwerker/Eigentümer) mit digitaler Quittung
- **Schlüssel zurücknehmen** — schließt den offenen Ausgabe-Vorgang
- **Wer-hat-was-Übersicht** — pro Person / pro Anlage / „alle offenen Ausgaben"
- **Soll/Ist-Abgleich** — rote Flags bei Überzahl oder Verlust
- **Historie pro Schlüssel** — lückenlos, wer wann für wie lange
- **QR-Anhänger-Druck** — Bogen mit QR + Nr (Prinzip wie `door-signs/`)

---

## 3. Ebene 2 — Physisches Schlüsseldepot am Objekt

Damit auch die Metallstücke bleiben, nicht nur die Daten. Standort ist bereits vorhanden:
**Schlüsselkasten R9 UG**.

**Ausbaustufen:**

- **Pragmatisch (heute):** elektronischer Schlüsselkasten/-tresor mit PIN oder — besser —
  Öffnung über die **bestehende UniFi-Access-NFC**, damit jeder Depot-Zugriff im
  Zutritts-Log landet. Schlüssel liegen physisch am Objekt, Zugriff ist protokolliert.
- **Professionell (später):** elektronisches Schlüsselschrank-System mit Einzelfach-
  Verriegelung (z.B. Deister keyBox, Traka) — jeder Schlüssel einzeln freigegeben und
  geloggt, direkte Kopplung an das Register aus Ebene 1.
- **Notfall getrennt:** separater **Feuerwehr-Schlüsseldepot (FSD)** / Notfallkasten,
  physisch getrennt vom Alltagsdepot, nur für Blaulicht/Notdienst.

**Grundregel:** Schlüssel werden nicht mehr „mitgenommen", sondern gegen Register-Eintrag
aus dem Depot entnommen und dorthin zurückgegeben.

---

## 4. Ebene 3 — Entkopplung durch elektronische Zutritte

Der stärkste Langzeit-Hebel: wo kein Metallschlüssel existiert, kann keiner verloren gehen
oder mitgenommen werden. Ihr habt mit **UniFi Access (UA Ultra, NFC)** bereits die Basis.

**Strategie:** Gemeinschaftsbereiche schrittweise auf elektronische Zutritte umstellen —
Priorität nach Häufigkeit der Nutzung/Wechsel:

1. Waschküche, Tiefgarage, Technik-/Heizräume, Müll/Entsorgung
2. Hauseingänge
3. (Wohnungstüren bleiben Sache der Eigentümer)

Danach ist ein Verwaltungswechsel auf diesen Türen ein **Software-Vorgang**: alte Karten
sperren, neue ausgeben — kein Schlüssel wechselt je den Besitzer. Metallschlüssel werden
zum reinen Notfall-Fallback im Depot (Ebene 2).

Technologie-Optionen: UniFi Access (bereits vorhanden, bevorzugt) · Nuki (Nachrüst-
Zylinder) · mechatronische Systeme (SimonsVoss, dormakaba evolo) für Bereiche ohne
Stromanschluss.

---

## 5. Governance & Prozesse

### 5.1 Eigentumsverhältnisse (der eigentliche Schutz)

- **Register + Schließanlagen-Sicherungskarten gehören der STWEG-Kooperation.**
  Die Bezugsberechtigung für Nachbestellungen (Sicherungskarte) liegt beim Ausschuss/
  Präsidenten, **nie** allein bei der externen Verwaltung.
- Verwaltung erhält Authentik-Gruppe `schluessel-verwaltung` mit Schreibrecht,
  Ausschuss/Technik `schluessel-admin`. Bewohner sehen nur ihre eigenen Ausgaben.

### 5.2 Schlüsselübergabe-Protokoll (bei jedem Verwaltungswechsel)

1. **Vollständigkeits-Check** gegen das Register (Soll/Ist je Anlage).
2. Alte Verwaltung gibt alle gehaltenen Exemplare zurück → Rücknahme im System, Quittung.
3. Fehlende Exemplare werden als `verloren` markiert → Risikobewertung je Anlage.
4. Bei sicherheitskritischem Verlust: Schließanlagen-Tausch beschließen.
5. Neue Verwaltung erhält nur die tatsächlich benötigten Exemplare, dokumentiert.
6. NFC-Karten der alten Verwaltung in UniFi Access sperren.

Dieser Ablauf wird durch das Register erzwungen — er lässt sich nicht mehr „vergessen".

### 5.3 Laufender Betrieb

- Handwerker-Ausgaben mit **Rückgabe-Frist** → automatische Erinnerung (WhatsApp/Mail)
  bei Überfälligkeit.
- Quartals-Report „offene Ausgaben" an den Ausschuss.
- Jede Mutation im Audit-Log (User-Email, Zeitstempel) — bereits vorhanden.

---

## 6. Integration in bestehende Infrastruktur

| Baustein | Wiederverwendung |
|----------|------------------|
| Datenbank | DB `rosenweg`, Audit-Trigger `app.user_email` (schon da) |
| Auth | Authentik-Gruppen, Muster wie `*-ausschuss` |
| API | neue Route `api/routes/schluessel.js` (analog `meg.js`, `grundbuch.js`) |
| Frontend | PWA `pwa/schluessel/` **oder** neuer Tab in `access.html` |
| Personen | Verknüpfung `halter_person_id` → `personen.html` |
| Objekte | `schliessanlage.stweg_nr` → `site-config.json` / `objektverwaltung.html` |
| Benachrichtigung | WhatsApp-Bot + Mail (Ausgabe, Überfälligkeit, Verlust) |
| QR-Druck | Muster aus `door-signs/` |
| Zutritts-Log | UniFi Access `/api/access` für Depot-Zugriffe |

---

## 7. Umsetzungs-Roadmap

- **Phase 0 — Bestandsaufnahme (organisatorisch, sofort):**
  Alle vorhandenen Schlüssel physisch sammeln, zählen, den Anlagen zuordnen.
  Sicherungskarten/Bezugsberechtigungen einsammeln und beim Ausschuss hinterlegen.
  *(Ohne diesen Schritt hat auch die beste Software keine Ausgangsdaten.)*
- **Phase 1 — Register-MVP:** Tabellen + einfache Erfass-/Ausgabe-Seite. Wer-hat-was,
  Historie, Soll/Ist. Schreibt sofort Wert, auch ohne Automatik.
- **Phase 2 — Komfort:** QR-Anhänger, WhatsApp/Mail-Benachrichtigungen, Reports,
  Verknüpfung Personen/Objekte.
- **Phase 3 — Physisch:** Depot-Zugriff über UniFi Access loggen; ggf. elektronischer
  Schlüsselschrank.
- **Phase 4 — Entkopplung:** Gemeinschaftstüren schrittweise auf elektronische Zutritte,
  Metallschlüssel als Fallback ins Depot.

---

## 8. Offene Entscheidungen

- Standort Depot bestätigen (R9 UG ausreichend zentral für alle 7 STWEG + TG?).
- Eigenes PWA-Modul vs. Tab in `access.html` — sauberer Schnitt vs. „alles Zutritt an
  einem Ort".
- Umfang Sicherheitsstufen: Sollen alle Anlagen erfasst werden oder nur Gemeinschaft
  (Wohnungsschlüssel bleiben bei Eigentümern)?
- Budget/Bereitschaft für elektronischen Schlüsselschrank (Phase 3) vs. einfacher Tresor.
