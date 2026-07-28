# Schlüssel-Management Rosenweg

> **Ziel:** Nach dem chaotischen Verwaltungswechsel soll dauerhaft sichergestellt sein,
> dass die Schlüssel — und vor allem das *Wissen* über die Schlüssel — **im Rosenweg
> verbleiben**. Die Eigentümergemeinschaft besitzt und kontrolliert das Register, nicht
> die jeweilige Verwaltung.
>
> **Status:** Konzept (noch kein Code). Baut auf bestehender Infrastruktur auf
> (DB `rosenweg` mit Audit-Trigger, Authentik-Gruppen, WhatsApp-Bot, Mail).
>
> **Entschieden:** Es wird ein **eigenes, kooperationsweites Modul** gebaut — *nicht*
> ein Ausbau von `access.html`. Grund: `access.html` ist ein **Eigenbau von/für
> Rosenweg 9 (STWEG 3)** und bleibt dessen Zutrittsverwaltung. Das Schlüsselregister
> muss dagegen **alle 7 STWEG + Tiefgarage** abdecken und der ganzen Kooperation gehören.
> Der physische Schlüsselkasten am R9 wurde bereits mit einem **UniFi Access Ultra zum
> elektronischen Schloss umgebaut** — dieser existierende Kasten ist der Startpunkt für
> Ebene 2, wird aber künftig für die Kooperation genutzt.

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

Damit auch die Metallstücke bleiben, nicht nur die Daten. Standort ist bereits vorhanden
und bereits elektronisch: der **Schlüsselkasten R9 UG**, den du mit einem **UniFi Access
Ultra zum elektronischen Schloss umgebaut** hast. Jeder Kasten-Zugriff wird also schon
heute über UniFi Access authentifiziert und protokolliert.

**Ausbaustufen:**

- **Vorhanden (heute):** elektronisch verriegelter Schlüsselkasten R9 UG, Öffnung über
  UniFi-Access-NFC → Depot-Zugriff landet im Zutritts-Log. Schlüssel liegen physisch am
  Objekt, Zugriff ist protokolliert. *Offen: Ausweitung/Widmung des Kastens von R9 auf die
  Kooperation (Berechtigungen, ggf. zweiter Kasten je nach Menge/Wege).*
- **Kooperations-Schrank mit Einzelschlüssel-Nachweis (geplant, Eigenbau):** modularer
  intelligenter Schlüsselschrank, der **jede einzelne Entnahme/Rückgabe pro Person**
  protokolliert — nicht nur „wer den Schrank geöffnet hat". Details siehe **Anhang A**.
- **Notfall getrennt:** separater **Feuerwehr-Schlüsseldepot (FSD)** / Notfallkasten,
  physisch getrennt vom Alltagsdepot, nur für Blaulicht/Notdienst.

**Grundregel:** Schlüssel werden nicht mehr „mitgenommen", sondern gegen Register-Eintrag
aus dem Depot entnommen und dorthin zurückgegeben.

**Warum ein eigener Kooperations-Schrank (Klasse B), nicht nur der Access-Ultra-Kasten:**
Der vorhandene R9-Kasten (Klasse A) sichert *wer den Schrank öffnet* — sobald er offen
ist, kann aber jeder jeden Schlüssel nehmen, ohne Spur *welcher* fehlt. Genau diese Lücke
hat den Verwaltungswechsel chaotisch gemacht. Ein Klasse-B-Schrank verfolgt **jeden
einzelnen Schlüssel** (RFID-/iButton-Anhänger je Bund) und schließt die Lücke.

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
| Frontend | **eigenes** PWA-Modul `pwa/schluessel/` (kooperationsweit; *nicht* `access.html`, das ist R9-Eigenbau) |
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

- ~~Eigenes Modul vs. Tab in `access.html`~~ → **entschieden: eigenes, kooperationsweites
  Modul** (`access.html` bleibt R9-Zutritt).
- Depot: reicht der vorhandene Access-Ultra-Kasten R9 UG für alle 7 STWEG + TG, oder
  braucht es einen zweiten Standort (Wege/Menge)? Berechtigungen von R9 auf Kooperation
  ausweiten.
- Umfang: alle Anlagen erfassen oder nur Gemeinschaft (Wohnungsschlüssel bleiben bei
  Eigentümern)?
- ~~Fertigsystem vs. Eigenbau~~ → **entschieden: integrierter Eigenbau** (siehe Anhang A).
- Menge der Schlüssel(bünde) → **erst nach Bestandsaufnahme (Phase 0)**; Schrank deshalb
  **modular** planen (in Blöcken erweiterbar).
- Verriegelungs-Variante des Eigenbaus: **nur-Erkennung** (einfach, empfohlen) vs.
  **Einzelfach-Verriegelung** (max. Sicherheit, mehr Elektromechanik) — siehe Anhang A.

---

## Anhang A — Eigenbau intelligenter Schlüsselschrank (integriert)

> **Entschieden:** integrierter Eigenbau statt Fertigsystem. Ziel: **jeder einzelne
> Schlüssel** wird protokolliert, Daten fließen in **euer eigenes System** (DB `rosenweg`,
> MQTT, API) statt in fremde Hersteller-Software. Menge noch offen → **modular** bauen.

### A.1 Grundprinzip

- Jeder Schlüssel(bund) hängt an einem **eindeutigen elektronischen Anhänger** — empfohlen
  **1-Wire iButton (DS1990A)**: ~1–2 CHF/Stück, robust, jede ID weltweit eindeutig,
  trivial auszulesen. (Alternative: RFID-Tag + Reader je Position — teurer.)
- Die **Schranktür** bleibt über den vorhandenen **UniFi Access Ultra** verriegelt →
  authentifiziert die **Person** und liefert das Öffnungs-Event.
- Ein **ESP32 je Modul** liest die iButton-Positionen und meldet Änderungen an euer
  System. Ihr habt MQTT bereits (`mqtt.html`) → ESP32 publiziert auf MQTT, API abonniert.

### A.2 Zwei Bau-Varianten

**Variante 1 — „nur Erkennung" (empfohlen, einfach):**
- Jede Hakenposition ist ein **iButton-Lesekontakt** (kein Riegel pro Fach).
- Der Schrank erkennt permanent, **welche iButtons hängen / fehlen**.
- Öffnet jemand die Tür (UniFi Access → Person bekannt), wird die **Differenz** der
  gehängten iButtons dieser Person zugeordnet → Entnahme/Rückgabe automatisch geloggt.
- **Verhindert** eine unberechtigte Entnahme nicht physisch, **protokolliert** sie aber
  lückenlos. Für eine STWEG i.d.R. völlig ausreichend — Ziel ist Nachvollziehbarkeit.
- Wenig Hardware: Reader-Kontakte + I/O-Expander (MCP23017) + ESP32. Kein Netzteil für
  Riegel, keine bewegten Teile.

**Variante 2 — „Einzelfach-Verriegelung" (max. Sicherheit):**
- Zusätzlich **Solenoid/Servo-Riegel je Position**; der Schrank gibt **nur die
  berechtigten Schlüssel** frei (wie Traka/Creone).
- Braucht Treiber (MOSFET/ULN2803) + kräftigeres Netzteil, deutlich mehr Verdrahtung
  und Mechanik pro Fach.
- Nur nötig, wenn einzelne Schlüssel *physisch* gesperrt werden müssen (z.B. TG-General,
  Technikräume) — lässt sich auch **nur für einige Fächer** nachrüsten (Hybrid).

### A.3 Ablauf (Variante 1)

```
1. Person hält NFC an UniFi Access Ultra  → Tür entriegelt
2. UniFi-Access-Event (Person + Zeit)     → Webhook → api/routes/schluessel.js
3. Person entnimmt/hängt Schlüssel         → iButton verschwindet/erscheint an Position P
4. ESP32 meldet Änderung (Position P, iButton-ID, ab/anwesend) → MQTT → api
5. api verknüpft iButton-ID ↔ schluessel_exemplar und Person aus Schritt 2
   → schreibt schluessel_ausgabe (Audit-Trail automatisch)
6. Tür zu → Abgleich; Überfälligkeit/Unstimmigkeit → WhatsApp/Mail an Ausschuss
```

### A.4 Stückliste (grob, pro Modul)

| Teil | Zweck |
|------|-------|
| ESP32 (WLAN, in eurem Netz / Netbird) | Steuerung + MQTT-Anbindung |
| 1-Wire-Bus + DS1990A iButtons | eindeutiger Anhänger je Schlüsselbund |
| iButton-Sockel je Position | Lesekontakt am Haken |
| MCP23017 I/O-Expander | viele Positionen an wenige Pins |
| *(Var. 2)* Solenoid/Servo + MOSFET/ULN2803 + Netzteil | Einzelfach-Riegel |
| abschließbarer Metallschrank, Tür mit UniFi Access Ultra | Gehäuse (Ultra vorhanden) |
| optional OLED/Touch | Rückmeldung „Schlüssel #7 entnommen" |

### A.5 Modularität (weil Menge offen)

- In **Blöcken à z.B. 16 Positionen** bauen, jeder Block = 1 ESP32 + 1 I/O-Expander.
- Start mit 1–2 Blöcken nach der Bestandsaufnahme, später **einfach Blöcke ergänzen**
  ohne die bestehenden zu ändern (jeder Block meldet eigenständig auf MQTT).

### A.6 Integration in euren Stack

| Baustein | Anbindung |
|----------|-----------|
| ESP32 → System | **MQTT** (vorhanden) oder HTTP an `api/routes/schluessel.js` |
| Person ↔ Entnahme | **UniFi Access Event/Webhook** → api (Person aus Türöffnung) |
| Zuordnung iButton ↔ Schlüssel | Feld `qr_token`/`ibutton_id` an `schluessel_exemplar` |
| Protokoll | `schluessel_ausgabe` + DB-Audit (`app.user_email`) |
| Alarme | WhatsApp-Bot + Mail (Überfällig, Ist>Soll, Verlust) |

### A.7 Reihenfolge (fügt sich in Roadmap Phase 3)

1. **Bestandsaufnahme** (Phase 0) → Menge → Blockzahl festlegen.
2. **Register-MVP** (Phase 1) muss stehen — der Schrank meldet dorthin.
3. Ein **Block als Prototyp** (Variante 1) am R9-Standort, iButtons an bestehende
   Schlüssel, Tür über den vorhandenen Access Ultra.
4. Test, dann **Blöcke bis zum Bedarf** ergänzen; einzelne Fächer bei Bedarf auf
   Variante 2 (Riegel) aufrüsten.

### A.8 Konkrete Stückliste (Hybrid) — Vorschlag

> **Entscheidung Hybrid:** Erkennung an **allen** Haken (1-Wire), Riegel nur an **wenigen
> kritischen** Fächern. Preise ca., **vor Kauf prüfen**. Mengen hängen an Phase 0.

**Kern-Trick Erkennung:** alle Haken an **einen gemeinsamen 1-Wire-Bus**. Der ESP32 liest
per „Search-ROM" alle anwesenden iButton-IDs → kein Reader/Controller pro Fach nötig, nur
ein Kontakt pro Haken. Riegel-Elektromechanik nur an den kritischen Fächern.

| # | Artikel | Zweck | Menge | ca. Preis | Bezug (CH/EU) |
|---|---------|-------|-------|-----------|----------------|
| 1 | **Metall-Schlüsselschrank abschliessbar**, z.B. Rieffel (50/100 Haken) | Gehäuse | 1 | CHF 170–450 | officeworld.ch, rottner-tresor.ch, gonser.ch |
| 2 | **iButton DS1990A** (TM-Anhänger) | eind. ID je Schlüsselbund | 1× je Bund | ~0.5–2.–/Stk (Bulk) | ibuttonshop.com, AliExpress, eBay |
| 3 | **DS9092 Probe / TM-Sockel** (mit LED) | Kontakt je Haken | 1× je Haken | ~1–3.–/Stk (10er) | AliExpress, eBay, ibuttonshop.com |
| 4 | **ESP32 DevKit** (WLAN) | Steuerung + MQTT | 1 je Block | CHF 8–15 | bastelgarten.ch, play-zone.ch, pi-shop.ch, distrelec.ch, BerryBase |
| 5 | 4.7 kΩ Widerstand (1-Wire Pull-up); optional **DS2482-100** (I²C→1-Wire-Master) | Bus | 1 je Bus | <1.– / ~5.– | distrelec.ch, bastelgarten.ch |
| 6 | **12 V Solenoid-Schrankschloss** (Mini, „normally closed") | Riegel je krit. Fach | nur krit. Fächer | CHF 8–15/Stk | amazon.de, AliExpress |
| 7 | **ULN2803A** Darlington-Array **oder** MOSFET-Treiber-Modul | schaltet Solenoide | 1 pro 8 Riegel | CHF 1–8 | distrelec.ch, bastelgarten.ch |
| 8 | **MCP23017** I²C-Portexpander | viele Riegel an wenig Pins | nach Riegel-Zahl | CHF 2–4 | distrelec.ch, bastelgarten.ch |
| 9 | **Netzteil 12 V / 5 A** | Versorgung Solenoide | 1 | CHF 15–25 | distrelec.ch, bastelgarten.ch |
| 10 | optional **OLED 0.96"** + Piezo-Buzzer | Rückmeldung „#7 entnommen" | 1 je Block | CHF 5–10 | bastelgarten.ch, play-zone.ch |
| 11 | **Schranktür-Reader** — siehe A.9 (neuer G3-Pro **oder** vorhandener Ultra) | Person-Auth + Event | 1 | siehe A.9 | store.ui.com, Brack, Digitec |

**Hinweise:**
- Positionen 6–9 (Riegel-Strang) entfallen für die reinen Erkennungs-Fächer — nur für die
  kritischen (z.B. TG-General, Technikräume) beschaffen. Hybrid = klein anfangen.
- iButton statt RFID gewählt: billiger, robuster, Multidrop-Bus trivial. RFID nur falls
  „ohne Einstecken" gewünscht (teurer, Reader je Position).
- ESP32 meldet via **MQTT** (vorhandene Infra) an `api/routes/schluessel.js`; Türöffnung
  kommt als **UniFi-Access-Event** dazu → Person ↔ bewegte iButtons verknüpft.
- Neues DB-Feld `ibutton_id` an `schluessel_exemplar` (Mapping iButton ↔ Schlüssel).

### A.9 Türreader für den neuen Schrank — UniFi Access

Zwei Wege, je nach gewünschtem Methodenumfang an der **Schranktür**:

**Variante „alle Methoden" (gewählt) — UniFi Access G3 Reader Pro:**
- Unterstützt **NFC-Karte/Keyfob · Apple/Google Wallet (Touch Pass) · Mobile/BLE · PIN
  (Touchscreen, gemischte Ziffern) · QR-Code · Gesichtserkennung · Wave-to-Exit** +
  Kamera/Intercom/Klingel. Pro Tür einzeln aktivierbar, welche Methoden gelten.
- **Braucht zwingend einen UniFi Access „Door Hub"** (Adoption via PoE-Port, Türrelais,
  **12 V/1 A-Lock-Ausgang** → kann das Solenoid-Schloss direkt versorgen).
- **Empfehlung: Starter Kit `UA-G3-SK-PRO`** — enthält Door Hub + G3 Reader Pro + einfachen
  G3 Reader + Keyfobs in einem Kauf. ~CHF 450–550. Alternativ einzeln `UA-G3-Pro`
  (~CHF 200–260) + Door Hub (~CHF 190–230).
- Praktischer Mehrwert für den Schrank v.a. **PIN + QR**: Handwerker/Verwaltung erhalten
  einen **zeitlich begrenzten PIN/QR** statt einer Karte.

**Sparvariante — zweiter UniFi Access Ultra:**
- Standalone (kein Hub nötig), integriertes Relais, ~CHF 130–160. Aber **nur NFC/Wallet/
  Mobile**, **kein PIN/QR/Face**. Sinnvoll, wenn Karte + Handy genügen.

**Entschieden:** G3-Pro-Weg (alle Methoden), Hub wird mitbestellt (Starter Kit Pro).

---

## Anhang B — MQTT-Schema

> Konvention wie bestehend: Broker Mosquitto **CT105 `mqtt://100.64.2.51:1883`**,
> Auth über `mosquitto-go-auth` + Tabelle `mqtt_service_users` (topic_filter + can_write).
> Domain = `schluessel`, Ort = Schrank-ID (`<schrank>`, z.B. `r9ug`), passend zu
> `energy/r9/…` / `control/r9/…`.

### B.1 Topics — Gerät → Broker (ESP32 publiziert)

| Topic | Retain | QoS | Zweck |
|-------|:------:|:---:|-------|
| `schluessel/<schrank>/status` | ✓ | 1 | Heartbeat/online, fw, uptime, rssi, Blockzahl. **LWT** setzt hier `{"online":false}` |
| `schluessel/<schrank>/block/<b>/status` | ✓ | 1 | Bus-Gesundheit je Block (erkannt, CRC-Fehler) |
| `schluessel/<schrank>/inventory` | ✓ | 1 | **Momentaufnahme** aller anwesenden iButton-IDs (Abgleich/Recovery) |
| `schluessel/<schrank>/event` | ✗ | 1 | Einzelnes Entnahme-/Rückgabe-Ereignis |
| `schluessel/<schrank>/lock/<fach>/state` | ✓ | 1 | Riegel-Zustand je Fach (`locked`/`unlocked`/`unknown`) |
| `schluessel/<schrank>/ack` | ✗ | 1 | Quittung auf ein Kommando (`cmd_id`) |

### B.2 Topics — Broker → Gerät (API publiziert, ESP32 abonniert)

| Topic | QoS | Zweck |
|-------|:---:|-------|
| `schluessel/<schrank>/cmd/unlock` | 1 | Riegel-Fach/Fächer freigeben |
| `schluessel/<schrank>/cmd/relock` | 1 | Wieder verriegeln |
| `schluessel/<schrank>/cmd/scan` | 1 | Sofort vollständigen Inventory-Scan + publish |
| `schluessel/<schrank>/cmd/ui` | 1 | OLED-Text / Buzzer / LED (Feedback) |

### B.3 Payloads (JSON)

```jsonc
// status (retained)
{ "online": true, "fw": "1.0.3", "uptime_s": 84213, "rssi": -61,
  "blocks": 2, "ts": 1753699200, "seq": 10432 }
// LWT-Payload:  { "online": false }

// event (nicht retained, QoS1)
{ "ts": 1753699231, "seq": 10433, "block": 1, "position": 7,
  "ibutton": "01:A3:9F:22:00:00:00:5C",
  "action": "taken",            // taken | returned
  "door_open": true }           // war die Tür in dem Moment offen? (Plausibilität)

// inventory (retained Snapshot)
{ "ts": 1753699200, "seq": 10432, "count": 42,
  "present": [ {"block":1,"position":3,"ibutton":"01:.."}, ... ] }

// lock/<fach>/state (retained)
{ "fach": 5, "state": "locked", "sense": true, "ts": 1753699200 }

// cmd/unlock  (API → Gerät)
{ "cmd_id": "u-9f3a", "fach": [5,12], "timeout_s": 30, "reason": "grant:handwerker" }
// ack (Gerät → API)
{ "cmd_id": "u-9f3a", "ok": true, "ts": 1753699233 }
```

### B.4 Semantik & Zuverlässigkeit

- **Retained** für `status`, `inventory`, `lock/*/state` → jeder Subscriber kennt nach
  Reconnect sofort den Ist-Zustand.
- `event` **nicht retained**, QoS 1: ESP32 puffert bei Offline in NVS/Flash und sendet mit
  steigender `seq` nach → **kein Ereignis geht verloren**; die API **dedupliziert per
  `(schrank, seq)`** und erkennt Lücken.
- `seq` streng monoton je Gerät (persistent über Reboot).
- `ts` = Unix-Epoch aus **NTP**; ohne NTP Fallback auf `uptime` + Server-Empfangszeit.

### B.5 Auth-Modell — Maschinen vs. Menschen

> **Grundsatz:** Interaktiver Login (Authentik/OIDC → 12-h-Token, `server.js:14082`) ist
> **nur für Menschen** im MQTT-Browser gedacht. **MQTT-Clients (ESP32, API, Integrationen)
> bekommen keine Authentik-Identität** — kein Browser-Flow, das 12-h-Token ist headless
> nicht erneuerbar, und Token-User sind per Default read-only (`server.js:14185`), der
> ESP32 muss aber schreiben. Maschinen laufen deshalb über **Service-User**
> (`mqtt_service_users`, persistentes Secret, nur im Broker).

| | Menschen | Maschinen (Clients) |
|---|---|---|
| Identität | Authentik (OIDC) | **Service-User je Gerät** |
| Credential | kurzlebiges Token (12 h) | **persistentes Secret**, einmal provisioniert |
| Erneuerung | interaktiv beim Login | keine; **einzeln widerrufbar** |
| Rechte | read-only, außer Topic-Regel | least-privilege `topic_filter` + gezielt `can_write` |

**Konkret fürs Modul:**
- **Gerät:** eigener Service-User **je Schrank**, nicht geteilt — z.B. `schrank-<id>`,
  `topic_filter = schluessel/<schrank>/#`, `can_write = true`; `cmd/#` nur lesen
  (optionale zweite Regel). Secret liegt im NVS (Anhang C.6). Vorteil: einzeln
  widerrufbar + im Broker-Log identifizierbar.
- **API:** publiziert `cmd/#` über ihren Publish-User (`collector`, `server.js:14214`).
- **Menschen (Ausschuss):** lesen über Authentik + **`mqtt_topic_rules`**-Regel
  (`topic_filter = 'schluessel/#'`, `group_name = 'schluessel-admin'` bzw. `technik`,
  `can_read = true`). Ohne solche Regel → `aclcheck` verweigert (`server.js:14188`);
  nur `technik` ist Superuser.

**Upgrade-Pfad:** mosquitto **mTLS / Client-Zertifikate** je Gerät (kein Secret im
Klartext, Widerruf per CRL) — sauberste Maschinen-Auth, mehr Infra. Für den Start genügt
Service-User + Secret über TLS-Transport.

### B.6 Server-Korrelation Person ↔ Schlüssel (der Kern)

1. **UniFi-Access-Webhook**: Tür `<schrank>` um `t0` von Person **P** geöffnet.
2. API öffnet **Korrelationsfenster** `[t0, t_close]` (Tür-Zu-Event; Fallback 90 s).
3. Alle `event` mit `ts` im Fenster werden **P** zugeordnet.
4. `taken` → offener `schluessel_ausgabe`-Datensatz; `returned` → schließt den offenen.
5. Mehrere Personen im Fenster (Tür aufgehalten) → **Konflikt-Flag** → Ausschuss-Review.

---

## Anhang C — ESP32-Firmware-Struktur

> Ziel: robust, offline-fest, OTA-fähig (Wandschrank ohne USB-Zugriff). Sprache
> Arduino-C++ oder ESP-IDF; unten framework-neutral als Module/Tasks.

### C.1 Module

| Modul | Aufgabe |
|-------|---------|
| `config` | Schrank-ID, Block-Layout (OneWire-GPIO je Block, Fach-Mapping), Broker, Timeouts — aus **NVS** überschreibbar (Provisionierung ohne Reflash) |
| `net` | WLAN (Reconnect + Backoff), **NTP/SNTP**-Zeitsync |
| `mqttc` | MQTT-Client, **LWT** auf `status`, Reconnect, `cmd/#` abonnieren, Publish-Wrapper mit `seq` |
| `owbus` | je Block ein OneWire-Bus; `scan()` = Search-ROM → Menge von IDs **inkl. CRC8-Prüfung** |
| `diff` | neue Menge ⇄ letzte Menge → `taken`/`returned`-Events; **Entprellung** |
| `store` | Ring-Puffer der Events in NVS/LittleFS; persistenter `seq`; Flush bei MQTT-Connect |
| `locks` | MCP23017 (I²C) → Treiber; `unlock(fach,timeout)`, Auto-Relock, optional Sense; state publish |
| `ui` | OLED/Buzzer/LED (optional) |
| `ota` | ArduinoOTA / HTTP-OTA |

### C.2 Tasks (FreeRTOS)

- **Task Scan** (~alle 250 ms): `owbus.scan()` je Block → `diff` → Event in `store` +
  publish (falls online). Läuft **immer**, auch offline.
- **Task Net/MQTT**: Verbindung halten, LWT, `cmd`-Handler, `store` flushen, Heartbeat
  `status` alle 30 s.
- **Task Locks**: `cmd/unlock` ausführen, Auto-Relock-Timer, `lock/*/state` publizieren.
- Hardware-**Watchdog**.

### C.3 Geräte-State-Machine

```
BOOT → WIFI_CONNECTING → NTP_SYNC → MQTT_CONNECTING → ONLINE  ⇄  OFFLINE_BUFFERING
```
Scannen ist **von ONLINE entkoppelt** — Events werden offline gepuffert und nachgesendet.

### C.4 Entprell-Logik (gegen Wackelkontakt)

- iButton gilt erst als **entfernt** nach `absent_confirm` (z.B. 3) aufeinanderfolgenden
  Scans ohne die ID; erst als **neu** nach ebenso vielen mit ID.
- Reads mit **CRC-Fehler verwerfen**, nicht als „entfernt" werten (sonst Fehl-Events).
- Nach ESP32-Neustart: `inventory` (retained) vs. DB-Sollzustand → Server korrigiert Drift.

### C.5 Kommando-Ablauf (Riegel)

```
cmd/unlock  → locks.unlock(fach, timeout) → ack
            → Entnahme erkannt (diff) ODER Timeout → relock → lock/<fach>/state
```

### C.6 Beispiel-Konfiguration (NVS/JSON)

```json
{ "schrank": "r9ug",
  "blocks": [ { "id": 1, "ow_gpio": 16 }, { "id": 2, "ow_gpio": 17 } ],
  "locks":  { "mcp_addr": "0x20", "fach_map": { "5": 0, "12": 1 } },
  "broker": "mqtt://100.64.2.51:1883",
  "heartbeat_s": 30, "scan_ms": 250, "absent_confirm": 3 }
```
