# Bedienanleitung für Ausschuss und Verwaltung

Stand: 17.11.2026 (nach der Sicherheitsprüfung, PR #23). Diese Anleitung beschreibt
Schritt für Schritt, was Ausschuss-Mitglieder und die Verwaltung auf der Website
erledigen können, was dabei im Hintergrund passiert und welche Meldungen kommen
können. Aufgaben, die nur Technik oder Präsident ausführen dürfen, stehen in
[anleitung-technik.md](anleitung-technik.md). Die Sicherheitsregeln, auf denen die
Einschränkungen beruhen, sind in [sicherheit.md](sicherheit.md) zusammengefasst.
Die Felder und Knöpfe der Objektverwaltung im Einzelnen beschreibt
[verwaltung-anleitung.md](verwaltung-anleitung.md).

---

## 0. Wer darf was

Die Rechte hängen an den Authentik-Gruppen des Kontos.

| Gruppe | Bedeutung |
|---|---|
| `stweg1-ausschuss` … `stweg7-ausschuss`, `meg-ausschuss` | Ausschuss **dieser einen** STWEG (MEG = STWEG 8, Einstellhalle) |
| `stwegN-eigentuemer`, `stwegN-bewohner` | Eigentümer bzw. Bewohner der STWEG N. Ausnahmen bei den Namen: STWEG 3 heisst `r9-eigentuemer`/`r9-bewohner`, STWEG 6 heisst `r1-eigentuemer`/`r1-bewohner`, MEG `meg-eigentuemer`/`meg-bewohner` |
| `verwaltung` | externe Liegenschaftsverwaltung; wirkt nur in STWEGs, in denen das Konto zusätzlich eine Gruppe hat |
| `technik`, `Präsident` | volle Rechte über alle STWEGs |

Grundregel: **Ein Ausschuss verwaltet nur seine eigene STWEG.** Wer in STWEG 5 im
Ausschuss sitzt und in STWEG 3 wohnt, kann STWEG 3 ansehen, aber nicht ändern.

| Aufgabe | Ausschuss (eigene STWEG) | Verwaltung | nur Technik / Präsident |
|---|---|---|---|
| Wohnungen, Kontakte, Mieterwechsel | ja | ja, wenn das Konto eine Gruppe dieser STWEG hat | – |
| Personen bearbeiten / zusammenführen | ja, solange die Person ungeschützt ist (Abschnitt 2) | ja (gleiche Regel) | geschützte Personen |
| Benutzerkonto anlegen | ja, ohne Passwort, nur Bewohner-/Eigentümer-Gruppen der eigenen STWEG | nein | Konten mit anderen Gruppen, Passwort setzen |
| Gruppen ändern, Konto löschen | nein | nein | ja |
| Geplante Kontolöschungen ansehen/stoppen (`loeschungen.html`) | nein | nein | ja |
| Reklamationen, Melde-Orte, Auto-Zuweisung | ja, eigene STWEG + Meldungen ohne STWEG | – | Regeln/Orte „Alle STWEG“ |
| Auslagen prüfen, genehmigen, ablehnen | ja, eigene STWEG + STWEG-übergreifende; nie eigene | – | – |
| Auslage „ausbezahlt“ setzen | nein | ja | ja |
| Mail schreiben (Composer) | ja, geht in die Outbox | – | Outbox freigeben |
| ZEV-Rechnungen zuordnen | ja, nur unzugeordnete der eigenen STWEG | – | umhängen, Rechnungen ohne STWEG |
| Unterschriftenlisten, Rückläufe | ja | ja, mit Gruppe der STWEG | – |
| Vollmachten prüfen (KI) | ja, eigene STWEG | ja | – |
| Vollmacht „Papier aktivieren“ | nein | ja | ja |
| Dokumente hochladen | ja: `allgemein/`, `projekte/`, eigene STWEG-Ordner | – | gesperrte Unterordner |
| ISP-Freigaben (Mail-Relay, Weiterleitung, Proxy) | nein | nein | ja ([anleitung-technik.md](anleitung-technik.md), Abschnitt 6) |
| Doodle-Umfragen | ja (jedes Mitglied) | ja | – |

Fehlt ein Menüpunkt, fehlt meist das Recht dafür in der **Rechteverwaltung**
(`rechteverwaltung.html`, nur Technik). Standardmässig haben alle Ausschuss-Gruppen:
Wohnungsverwaltung (schreiben), Auslagen (schreiben), Auslagen-Stundensatz
(schreiben), Reklamationen (schreiben), Mail schreiben, Mail-Empfänger (lesen),
E-Mail-Archiv (lesen). Das Recht **Bewohner-Verwaltung** (für Abschnitt 3) wird nicht
automatisch vergeben; es muss in der Rechteverwaltung gesetzt sein.

---

## 1. Wohnungen und Kontakte pflegen

Seite: **Objektverwaltung** (`objektverwaltung.html`), Reiter **Wohnungen**.

### 1.1 STWEG wählen

1. Objektverwaltung öffnen. Oben erscheinen als Knöpfe nur die STWEGs, in denen das
   Konto eine Gruppe hat.
2. STWEG anklicken. Die Leiste darunter zeigt Anzahl Einheiten, Selbstbewohnt,
   Vermietet, Leer.
3. Im Suchfeld nach Bezeichnung, Stockwerk, Name oder E-Mail eines Kontakts suchen.

Wer in einer STWEG nur wohnt, sieht deren Wohnungen, kann aber nichts speichern. Der
Server antwortet dann mit **„Schreiben nur für den Ausschuss dieser STWEG“**.

### 1.2 Wohnung anlegen oder ändern

1. **„Neue Wohnung“** anklicken oder eine bestehende Wohnung in der Liste anklicken.
2. Felder ausfüllen (Bezeichnung ist Pflicht; Stockwerk, Zimmer, Fläche, Typ,
   Wertquote Zähler/Nenner, Besonderheiten, Bewohnung, Notizen).
3. **„Speichern“**.

Mögliche Meldungen:

| Meldung | Bedeutung, was tun |
|---|---|
| „Bezeichnung ist erforderlich“ | Bezeichnung ausfüllen |
| „Wohnung mit dieser Bezeichnung existiert bereits“ | andere Bezeichnung wählen; jede Bezeichnung nur einmal je STWEG |
| „Ungültige E-Mail-Adresse: …“ | Schreibweise der E-Mail in einer Kontaktkarte prüfen (keine Leerzeichen, Klammern, Kommas; höchstens 254 Zeichen) |
| „Schreiben nur für den Ausschuss dieser STWEG“ | falsche STWEG gewählt oder keine Schreibberechtigung |

Nach dem Speichern bekommt die Verwaltung eine Änderungsmeldung, aber nur bei
Änderungen, die sie betreffen (Typ, Stockwerk, Zimmer, Fläche, Bewohnung,
Waschküchen-Berechtigung, Wertquote, Eigentümer/Mieter mit Name, E-Mail, Telefon,
Adresse). Bezeichnung, Notizen und Besonderheiten lösen keine Meldung aus.

### 1.3 Kontaktkarten

Jede Wohnung hat beliebig viele Kontaktkarten (**„+ Kontakt hinzufügen“**). Je Karte:

- **Rolle:** Eigentümer, Mieter, Verwalter, Bewohner, Sonstige. „Verwalter“ ist auch
  für Angehörige gedacht, die sich um ältere Eigentümer kümmern.
- **Name, E-Mail, Telefon** (Schweizer Nummern werden beim Verlassen des Feldes zu
  `+41 79 123 45 67` formatiert), **Adresse** (mit Vorschlägen aus dem amtlichen
  Adressverzeichnis, ab 3 Zeichen).
- **Gültig ab:** Datum, ab dem der Kontakt gilt. Liegt es in der Zukunft, erscheint die
  Karte blass mit dem Hinweis „vorgemerkt ab …“.
- **„Ersetzt ab diesem Datum die bisherigen Kontakte dieser Rolle (Wechsel)“:** nur
  zusammen mit „Gültig ab“ wirksam, siehe 1.5.
- **Authentik-Zugang:** ob die Person ein Konto bekommt. Voreinstellung: an für
  Eigentümer und Verwalter, aus für Mieter und Bewohner.

Was beim Speichern zusätzlich passiert:

- **Konto:** Für jede Karte mit E-Mail und Authentik-Zugang legt der Server im
  Hintergrund ein Konto an, falls es zur Adresse noch keines gibt, und nimmt es in die
  passende Gruppe auf: Eigentümer und Verwalter in die Eigentümer-Gruppe der STWEG
  (bei „Selbstbewohnt“ zusätzlich in die Bewohner-Gruppe), Mieter und Bewohner in die
  Bewohner-Gruppe. Der Benutzername ist dabei der Teil der E-Mail vor dem `@`.
  Fehler dabei brechen das Speichern nicht ab; dann fehlt das Konto einfach (Technik
  fragen).
- **Ohne E-Mail und ohne Authentik-Zugang** bekommt die Karte eine technische
  Ersatzadresse `druckerr9+nachname.vorname@…`. Post an diese Person wird gedruckt und
  per Brief zugestellt. Für diese Adressen entsteht nie ein Konto.
- **Verwalter-Karte:** Der Server legt automatisch einen **Vollmacht-Entwurf**
  Eigentümer → Verwalter an, falls noch keiner besteht. Der Eigentümer muss ihn noch
  unterschreiben (Abschnitt 10).
- **Löschvormerkung zurücknehmen:** Steht eine Adresse wieder auf einer Karte, wird
  eine laufende Kontolöschung für diese Adresse automatisch gestoppt.

### 1.4 Kontakt entfernen

Das **×** oben rechts auf der Karte entfernt sie aus dem Formular. Nach
**„Speichern“** wird der Kontakt **archiviert**, nicht gelöscht. Archivierte Kontakte
zeigt der Knopf **„Historie“** unten im Fenster (sichtbar für Ausschuss, Verwaltung,
Technik, Präsident).

Ist die E-Mail des entfernten Kontakts danach an keiner anderen Wohnung mehr
eingetragen, wird das zugehörige Konto **nach 30 Tagen gelöscht** (Abschnitt 4).

### 1.5 Mieterwechsel Schritt für Schritt

**Variante A – Wechsel auf ein Datum (empfohlen, wenn das Datum feststeht):**

1. Wohnung öffnen.
2. **„+ Kontakt hinzufügen“**, Rolle **Mieter**, Name, E-Mail, Telefon des neuen
   Mieters eintragen.
3. **Gültig ab** = Einzugsdatum.
4. Häkchen **„Ersetzt ab diesem Datum die bisherigen Kontakte dieser Rolle
   (Wechsel)“** setzen.
5. Falls der neue Mieter ein Konto bekommen soll: **Authentik-Zugang** anhaken.
6. Bewohnung auf **Vermietet** lassen bzw. setzen, **„Speichern“**.

Am Stichtag archiviert ein täglicher Hintergrundlauf alle bisherigen Kontakte mit
derselben Rolle an dieser Wohnung, deren „Gültig ab“ älter ist. Danach wird die
Markierung gelöscht; ein später ergänzter zweiter Mieter wird also nicht noch einmal
„ersetzt“. Ohne Häkchen bleiben beide Kontakte nebeneinander bestehen (z. B. zwei
Miteigentümer).

Wichtig: Bei dieser Variante wird das Konto des alten Mieters **nicht** zur Löschung
vorgemerkt (der Hintergrundlauf archiviert nur). Soll das Konto weg, bitte die
Technik informieren.

**Variante B – Wechsel sofort:**

1. Wohnung öffnen.
2. Karte des alten Mieters mit **×** entfernen.
3. Neue Karte für den neuen Mieter anlegen (wie oben, ohne Datum).
4. **„Speichern“**. Der alte Kontakt ist archiviert; sein Konto wird nach 30 Tagen
   gelöscht, wenn die Bedingungen aus Abschnitt 4 erfüllt sind.

**Nicht empfohlen: Name und E-Mail in der bestehenden Karte überschreiben.** Die
Karte hängt an einem Personen-Stammsatz, und was dann passiert, hängt von der Person
ab:

| Fall | Ergebnis |
|---|---|
| Person ohne eigenes Konto und ohne Wohnungen in anderen STWEGs | Der Personen-Stammsatz wird überschrieben – auch an allen anderen Wohnungen dieser Person in der STWEG steht dann der neue Name. |
| Person mit eigenem Konto oder mit Wohnungen in anderen STWEGs, nur Name geändert | Abgelehnt: „Der Name von «…» gehört zu einer Person mit eigenem Konto oder Wohnungen in einer anderen STWEG und wird von ihr selbst (Profil) oder der Technik geändert. Für einen Wechsel der Person bitte eine neue Kontaktkarte anlegen.“ |
| Dieselbe Person, E-Mail geändert | Die Karte wird an eine eigene, neue Person gehängt; die alte Person bleibt unverändert. |
| Neue E-Mail gehört schon einem aktiven Konto | Abgelehnt: „Diese E-Mail-Adresse gehört zu einem bestehenden Konto. Bitte Technik kontaktieren.“ |

Telefon und Adresse einer geschützten Person ändern sich nur an dieser einen Karte,
nicht im gemeinsamen Personen-Stammsatz.

### 1.6 Eigentümerwechsel

Wie der Mieterwechsel, nur mit Rolle **Eigentümer**. Bei einem Verkauf auf ein Datum
Variante A verwenden. Hat der neue Eigentümer einen Verwalter, zusätzlich eine
Verwalter-Karte anlegen; der Vollmacht-Entwurf entsteht automatisch.

### 1.7 Exportieren, Importieren, Löschen

- **Excel / CSV:** exportiert die Wohnungen der gewählten STWEG.
- **Import:** las früher `stwegN/data/kontakte.json`. Diese Dateien wurden am
  17.11.2026 entfernt (sie waren öffentlich abrufbar); der Knopf meldet deshalb
  „kontakte.json nicht gefunden unter …“. Er wird nicht mehr gebraucht.
- **„Löschen“** (rot, unten links im Fenster) entfernt die Einheit endgültig. Für einen
  Auszug nie die Wohnung löschen, sondern die Kontaktkarte entfernen.

### 1.8 Reiter „Eigentümer & Verwalter“

Übersicht aller Eigentümer und Verwalter mit Wohnungen, Parkplätzen, sonstigen
Einheiten und Summe der Wertquoten. Filter nach STWEG und Rolle, Export als CSV und
Excel. Nur lesend.

---

## 2. Personen bearbeiten und zusammenführen

Seite: **Personen (Stammdaten)** (`personen.html`). Eine Person ist der gemeinsame
Stammsatz hinter allen Kontaktkarten derselben Person. Eine Änderung hier gilt für
**alle Wohnungen** der Person.

Sichtbar sind Personen mit einer Wohnung in einer eigenen STWEG und Personen ohne
jede Wohnung (frisch angelegt).

### 2.1 Person bearbeiten

1. In der Liste **„bearbeiten →“** anklicken.
2. Anrede, Vorname, Nachname, Anzeigename, E-Mail, Telefon, Mobile, Geburtsdatum,
   weitere Nummern, Adresse, Notiz ändern.
3. **„Speichern (propagiert auf alle Wohnungen)“**.

Bei Änderung von E-Mail, Telefon oder Adresse wird die Verwaltung jeder betroffenen
STWEG informiert.

### 2.2 Duplikate zusammenführen

1. **„🔍 Duplikate prüfen“**. Vorgeschlagen werden Personen mit gleichem Namen, mit
   vertauschtem Vor-/Nachnamen oder mit gleicher E-Mail und unterschiedlichem Namen
   (Letzteres sind oft Ehepaare – nicht zusammenführen).
2. Bei der Person, die **verschwinden** soll, **„in andere mergen…“** anklicken.
3. Die Person wählen, die **bleibt**, und **„Mergen“**.
4. Alle Wohnungen der verschwindenden Person werden umgehängt. Leere Felder der
   bleibenden Person werden aus der anderen ergänzt; vorhandene Werte bleiben. Die
   verschwindende Person wird gelöscht. Meldung: „Merge erfolgreich: N Kontakte
   umgehängt.“

### 2.3 Geschützte Personen – wann die Technik ran muss

Eine Person ist **geschützt**, wenn sie ein eigenes aktives Konto hat oder an einer
Wohnung in einer STWEG hängt, in der man nicht Ausschuss ist. Dann gilt:

| Vorgang | Meldung |
|---|---|
| Name, E-Mail, Telefon, Adresse ändern | „Diese Person hat ein eigenes Konto oder Wohnungen in einer anderen STWEG. Name und Kontaktdaten aendert sie selbst im Profil oder die Technik.“ |
| Zusammenführen | „Mindestens eine Person hat ein eigenes Konto oder Wohnungen in einer anderen STWEG - Zusammenfuehren nur durch die Technik.“ |
| Person liegt ganz ausserhalb der eigenen STWEG | „Diese Person gehört nicht zu einem STWEG für den du Ausschuss-Berechtigung hast“ bzw. „Mindestens eine Person gehört nicht zu deinem STWEG-Scope“ |
| E-Mail, die einer anderen Person oder einem Konto gehört | Ablehnung mit Hinweis auf die Kollision |

Was tun: Bewohner mit Konto ändern ihre Daten selbst im **Profil**. Sonst die
Technik bitten (Anleitung dort: [anleitung-technik.md](anleitung-technik.md),
Abschnitt 3).

---

## 3. Benutzerkonten anlegen

Seite: **Objektverwaltung**, Reiter **Bewohner**. Voraussetzung: Ausschuss-Gruppe
**und** das Recht „Bewohner-Verwaltung“ schreibend.

Im Normalfall entsteht das Konto automatisch über die Kontaktkarte (Abschnitt 1.3).
Der Weg hier ist für Fälle ohne Kontaktkarte.

### 3.1 Konto anlegen

1. **„Neuer Bewohner“**.
2. **Name** mit Vor- und Nachname (z. B. „Max Muster“), **E-Mail** (damit meldet sich
   die Person an).
3. Unter **Gruppen** nur die Bewohner- bzw. Eigentümer-Gruppe der eigenen STWEG
   anhaken (z. B. `stweg5-bewohner`). Die Auswahl „Rolle“ (Eigentümer/Mieter) im
   Formular hat keine Wirkung; massgebend sind die Gruppen.
4. **„Speichern“**.

Der Benutzername wird aus dem Namen gebildet: erstes und letztes Wort, klein, Umlaute
als ae/oe/ue, also `max.muster`. Es wird **kein Passwort** gesetzt und das Konto wird
nicht ins Active Directory übertragen. Die Person setzt ihr Passwort selbst über
**„Passwort vergessen“** auf der Anmeldeseite.

| Meldung | Bedeutung, was tun |
|---|---|
| „Bitte Name und E-Mail eingeben.“ | Pflichtfelder ausfüllen |
| „Bitte Vor- und Nachname eingeben.“ | Name besteht nur aus einem Wort |
| „Benutzername muss die Form vorname.nachname haben (nur a-z, 0-9)“ | Name enthält Zeichen, die nicht umgewandelt werden können |
| „Benutzername existiert bereits“ | Es gibt schon ein Konto `vorname.nachname` (auch mit anderer Gross-/Kleinschreibung). Technik fragen, z. B. bei Namensgleichheit in einer Familie. |
| „Für diese E-Mail gibt es bereits ein Konto“ | Die Person hat schon ein Konto; nicht doppelt anlegen. |
| „Nur Bewohner-/Eigentümer-Gruppen der eigenen STWEG vergebbar“ | eine fremde Gruppe (z. B. `technik`, ein Ausschuss, andere STWEG) angehakt |
| „Passwort kann nur Technik setzen“ | erscheint nur bei direktem API-Aufruf mit Passwort |

### 3.2 Bestehende Konten

- **Ändern (Stift):** Ausschuss darf nur den Namen ändern; E-Mail und Aktiv-Status nur
  Technik („E-Mail kann nur Technik ändern“, „Aktivierung kann nur Technik ändern“).
  Achtung: Das Formular schickt immer auch die Gruppenliste mit, und der Server lehnt
  das für den Ausschuss mit **„Gruppen können nur von Technik geändert werden“** ab.
  Namensänderungen am Konto daher zurzeit über die Technik.
- **Gruppen nachträglich ändern** (auch im Reiter **Gruppen**): nur Technik. Der
  Ausschuss bekommt „Fehler: HTTP 403“.
- **Entfernen (Papierkorb):** nur Technik. Der Server lehnt für den Ausschuss ab
  („Konten löschen kann nur Technik“); die Seite zeigt dabei keine Meldung, das Konto
  bleibt bestehen.
- Konten von Technik oder Präsident kann der Ausschuss gar nicht ändern („Dieses Konto
  kann nur Technik ändern“), Konten fremder STWEGs auch nicht („Benutzer gehört nicht
  zu deiner STWEG“).

Hinweis: In den STWEGs 1, 2, 4, 5, 7 und MEG kann die Bewohner-Liste für den
Ausschuss unvollständig erscheinen, weil die Seite dort nach Gruppennamen der Form
`r<Hausnummer>-…` filtert. Die Konten sind trotzdem vorhanden.

---

## 4. Kontolöschung nach Auszug

Konten werden nicht sofort gelöscht, sondern **vorgemerkt**:

1. Beim Speichern einer Wohnung, aus der ein Kontakt mit E-Mail entfernt wurde (oder
   deren E-Mail auf einer Karte geändert wurde), prüft der Server die alte Adresse.
2. Vorgemerkt wird nur, wenn
   - die Adresse an **keiner anderen Wohnung** als Kontakt steht (auch nicht als
     archivierter Kontakt),
   - das Konto **ausschliesslich** Bewohner- und/oder Eigentümer-Gruppen **dieser**
     STWEG hat (kein Ausschuss, keine Verwaltung, keine Technik, keine weitere STWEG,
     kein Superuser),
   - die Adresse keine Ersatzadresse `druckerr…+…` ist.
3. Löschtermin: **30 Tage** nach dem Speichern.
4. **7 Tage vorher** bekommt die Person eine E-Mail „Rosenweg: Ihr Konto wird in 7
   Tagen gelöscht“ mit dem Hinweis, sich bei einem Fehler an Verwaltung oder Technik zu
   wenden.
5. Am Termin prüft ein täglicher Lauf noch einmal: Steht die Adresse inzwischen wieder
   an einer Wohnung, oder hat das Konto inzwischen andere Gruppen, wird die Löschung
   storniert. Sonst wird das Konto in Authentik endgültig gelöscht; Sitzungen und
   persönliche Zugangstoken werden beendet.

Was der Ausschuss tun kann:

- **Versehentlich entfernt?** Kontakt wieder eintragen und speichern – die Vormerkung
  wird sofort storniert.
- **Konto soll früher weg oder hat weitere Gruppen?** Technik bitten.
- Die Liste der Vormerkungen (`loeschungen.html`) sehen nur Technik und Präsident.
  Ein Ausschuss-Konto sieht dort „Fehler: HTTP 403“.

---

## 5. Reklamationen

### 5.1 Liste und Bearbeitung (`reklamationen.html`)

Sichtbar sind Meldungen der eigenen STWEG(s) und Meldungen ohne STWEG. Meldungen
anderer STWEGs erscheinen nicht; ein direkter Aufruf ergibt „Nicht gefunden“.

1. Filter **Status** wählen (Voreinstellung „Aktiv (offen + weitergeleitet)“; „📦
   Archiviert“ zeigt ausgeblendete).
2. **„✏️ Bearbeiten“** öffnet die Meldung mit Foto.
3. Ändern:
   - **Status:** offen, weitergeleitet, erledigt, abgewiesen.
   - **Kategorie:** Aufzug, Heizung, Wasser, Tür/Schloss, Reinigung, Licht, Strom,
     Netzwerk, Salz, Sonstiges.
   - **Zuweisung:** ein Technik-Mitglied oder ein Handwerker aus dem
     Handwerker-Verzeichnis.
   - **Notiz (intern):** nur für Technik und Ausschuss, geht nie an die meldende Person.
   - **Nachricht an die meldende Person (optional):** erscheint erst, wenn der Status
     wechselt; der Text geht mit der Statusmeldung an die meldende Person und steht
     in ihrem Verlauf.
4. **„Speichern“**.
5. Arbeitsschritte dokumentieren: Text ins Feld beim Verlauf schreiben und **„+
   Schritt“** (oder Enter). Der Eintrag wird sofort mit Name und Zeit gespeichert.

Was dabei automatisch passiert:

| Aktion | Wirkung |
|---|---|
| Statuswechsel | Melder bekommt WhatsApp (falls angemeldet) und Push. Bei **erledigt** und **abgewiesen** zusätzlich eine E-Mail. Mit dabei ist nur die „Nachricht an die meldende Person“, nie die interne Notiz. |
| Statuswechsel mit ausgefüllter Notiz | **Die Notiz wird dem Melder als „Bemerkung“ mitgeschickt** – trotz der Bezeichnung „intern“. Vor einem Statuswechsel keine internen Vermerke in der Notiz lassen; interne Schritte über „+ Schritt“ festhalten. |
| „+ Schritt“ | Melder bekommt WhatsApp/Push (keine E-Mail). |
| Zuweisung an ein Technik-Mitglied | Diese Person bekommt WhatsApp und Push. |
| Status **erledigt** | Für die zugewiesene Person (sonst für den Bearbeiter) entsteht ein **Entwurf** in den Auslagen (Kategorie Arbeitszeit, Betrag 0), den sie ergänzen und einreichen kann. |
| **📦** (Archivieren) | Meldung verschwindet aus der Liste, der Melder wird **nicht** benachrichtigt. **↩** holt sie zurück. |

### 5.2 Automatische Zuweisung

1. **„⚙️ Auto-Zuweisung“**.
2. Oben die **STWEG** wählen. Der Ausschuss kann nur Regeln seiner eigenen STWEG
   speichern; „Alle STWEG (Standard)“ und andere STWEGs ändert nur die Technik.
   Änderungen dort werden beim Speichern ohne Meldung übergangen – die Anzeige „✓
   Gespeichert“ bezieht sich nur auf die eigenen Zeilen.
3. Je Kategorie ein Technik-Mitglied oder einen Handwerker wählen; „— nicht
   zugewiesen —“ löscht die Regel.
4. **„Speichern“**.

Neue, noch nicht zugewiesene Meldungen bekommen beim Eingang die Regel ihrer STWEG,
sonst die Standardregel. Technik-Mitglieder werden dabei per WhatsApp/Push
benachrichtigt.

### 5.3 Melde-Orte mit QR-Code (`melde-orte.html`)

Ein Melde-Ort ist ein fester Ort (z. B. „Aufzug Haus 9“) mit QR-Sticker. Wer ihn
scannt, landet im Meldeformular `pwa.rosenweg4303.ch/reparatur/?ort=<code>` mit
vorausgefülltem Ort.

1. Unter **„Neuen Ort anlegen“**: **Bezeichnung** (Pflicht), **Ort / STWEG**,
   **Kategorie (vorausgewählt)**.
2. **„+ Ort anlegen“**. Der Code (8 Zeichen) wird zufällig erzeugt.
3. In der Liste **„📱 QR“** → **„⬇ PNG“** oder **„🖨 Sticker drucken“**; oder oben
   **„🖨 Alle aktiven Sticker drucken“**.
4. **✏️** ändert Bezeichnung, STWEG, Kategorie und Aktiv-Status (inaktive Orte
   funktionieren beim Scannen nicht mehr). **🗑** löscht den Ort; vorhandene Sticker
   funktionieren dann nicht mehr.

Regeln: Der Ausschuss muss eine **eigene STWEG** wählen. „Allgemein / keiner“ und
fremde STWEGs ergeben „Keine Berechtigung für diese STWEG“ bzw. „Keine Berechtigung
für diesen Ort“. Die Liste zeigt die Orte aller STWEGs.

### 5.4 Meldungen von Bewohnern ohne Anmeldung

Zur Beantwortung von Rückfragen: Im Meldeformular kann man ohne Konto melden. Die
Person gibt ihre E-Mail ein; ist sie im Verzeichnis bekannt, kommt ein **8-stelliger
Code**, 10 Minuten gültig, höchstens 5 Fehlversuche. Die Seite antwortet immer
gleich („Falls die Adresse im Verzeichnis steht, ist der Code unterwegs.“) – auch
bei unbekannter Adresse. Kommt kein Code: Adresse steht nicht im Verzeichnis, oder
es wurden in 10 Minuten schon 3 Codes angefordert (höchstens 12 pro Tag). Mögliche
Meldungen beim Absenden: „Ungültiger Code“, „Der Code ist abgelaufen. Bitte einen
neuen anfordern.“, „Zu viele Fehlversuche. Bitte einen neuen Code anfordern.“ – dafür
gibt es den Knopf **„Neuen Code anfordern“**. Angemeldete Bewohner können höchstens
5 Meldungen in 10 Minuten absenden.

---

## 6. Auslagen prüfen und genehmigen

Seite: **Auslagen** (`auslagen.html`). Der Ausschuss sieht eigene Auslagen, alle
Auslagen der eigenen STWEG und STWEG-übergreifende Auslagen. **Entwürfe** sieht nur,
wer sie erstellt hat (und die Technik).

### 6.1 Prüfen

1. In der Liste **„prüfen“** anklicken (bei eigenen Auslagen erscheint dieser Knopf
   nicht).
2. Belege, Positionen, Betrag und IBAN kontrollieren.
3. Optional **Bemerkung** eintragen; sie geht an die einreichende Person.
4. **„Genehmigen“** oder **„Ablehnen“**.

Regeln:

| Regel | Meldung |
|---|---|
| Keine Selbstgenehmigung: eigene Auslagen genehmigt eine andere Person | „Eigene Auslagen müssen von einer anderen Person genehmigt werden“ |
| Entwürfe kann erst der Ersteller einreichen; vorher prüft, kommentiert oder löscht sie niemand | „Entwurf muss zuerst vom Ersteller eingereicht werden“, „Entwurf kann nur der Ersteller löschen“ |
| „Ausbezahlt“ setzen nur Verwaltung, Technik, Präsident – oder die einreichende Person als „Erhalt bestätigen“ nach Genehmigung | „"Ausbezahlt" dürfen nur Verwaltung, Technik, Präsident oder der einreichende Eigentümer (nach Genehmigung) setzen“ |
| Hat sich die Auslage seit dem Öffnen geändert (Betrag, IBAN, Status) | „Die Auslage wurde inzwischen geändert. Bitte neu laden und erneut prüfen.“ bzw. „… gleichzeitig geändert. Bitte neu laden.“ → **„Neu laden“**, erneut prüfen |
| Positionen sind nach der Genehmigung gesperrt | „Positionen nur bei eingereichter Auslage bzw. eigenem Entwurf editierbar (nicht nach Genehmigung)“ |

### 6.2 Was nach „Genehmigen“ passiert

Die Seite meldet eines davon:

- „Genehmigt. Auszahlungs-Mail wurde in die Verwaltungs-Mail-Outbox gestellt und
  wartet auf Freigabe durch Technik oder Präsident …“ – der Normalfall. Erst nach der
  Freigabe geht der Auszahlungsauftrag mit allen Belegen an die Verwaltung.
- „Genehmigt — ABER: für diesen STWEG ist keine aktive Verwaltung mit E-Mail
  hinterlegt …“ – die Mail ging an den Ausschuss. Verwaltung unter „Verwaltung“
  erfassen.
- „Genehmigt, aber Auszahlungs-Mail schlug fehl …“ – Verwaltung von Hand
  informieren, Technik melden.

Lehnt die Technik die Auszahlungs-Mail in der Outbox ab, bekommen Prüfer und
einreichende Person eine E-Mail und WhatsApp mit dem Grund.

Die einreichende Person bekommt bei jedem Statuswechsel E-Mail und WhatsApp.

### 6.3 Löschen, Belege

- Der Ausschuss kann Auslagen seiner STWEG in jedem Status löschen, ausser fremden
  Entwürfen. Bei bereits eingereichten Auslagen werden Ausschuss (bzw. Verwaltung, falls sie den Auftrag
  schon hatte) und die Technik informiert; offene Auszahlungs-Mails in der Outbox
  werden zurückgezogen.
- Belege: PDF, JPG, PNG, WEBP, HEIC, je höchstens 15 MB. Die KI-Belegerkennung ist
  auf 30 Scans pro Stunde und Person begrenzt.
- **Entwürfe aus Reklamationen** (Abschnitt 5.1) erscheinen bei der zugewiesenen
  Person als „ergänzen & einreichen“.

---

## 7. Mail schreiben und Freigabe-Outbox

### 7.1 Mail schreiben (`mail-compose.html`)

1. Optional **Empfänger aus Stammdaten** wählen (Filter nach STWEG möglich); An, CC
   und Reply-To werden dann vorbelegt. Sonst **An (To)** von Hand.
2. **Betreff** und **Text** (beides Pflicht), optional Anhänge (höchstens 20 MB je
   Datei).
3. **„In Outbox stellen“**.

Jede Mail geht in die **Outbox** und wartet auf Freigabe durch Technik oder
Präsident. Einzige Ausnahme: Der gewählte Stammempfänger ist für **Direktversand**
eingerichtet, und An, CC und Reply-To enthalten **nur** dessen hinterlegte Adressen.
Dann zeigt die Seite vorab „✓ Dieser Empfänger ist als Direktversand konfiguriert …“
und die Mail geht sofort hinaus („Mail wurde direkt versendet.“). Wird auch nur eine
Adresse ergänzt oder geändert, geht sie wieder in die Outbox.

Grenze: 50 Mails pro Stunde und Konto („Rate-Limit erreicht (max 50 Mails/h). Bitte N
Min warten.“).

### 7.2 Outbox (`verwaltung-mail-outbox.html`)

Die Outbox sehen, bearbeiten, freigeben und ablehnen nur Technik und Präsident
(Anleitung: [anleitung-technik.md](anleitung-technik.md), Abschnitt 7). Für den
Ausschuss zeigt die Seite „Kein Zugriff (nur Technik / Präsident)“. Nachfragen zum
Stand einer Mail also an die Technik.

---

## 8. ZEV-Rechnungen zuordnen

Seite: **ZEV / smart-me** (`stweg3/pages/zev-smartme.html`, zurzeit nur STWEG 3). Für
Verwaltung, Ausschuss und Technik.

Jede Wohnung hat einen Mail-Alias `zev.<bewohner>@<domain>`, an den smart-me die
Stromrechnung schickt. Die Rechnung wird dem aktuellen Bewohner zugeordnet und
weitergeleitet.

### 8.1 Nicht zugeordnete Rechnungen

Der Abschnitt **„⚠️ Nicht zugeordnete Rechnungen“** listet Rechnungen, deren Alias
keiner Wohnung zugeordnet werden konnte. Sie erscheinen in keiner Bewohner-Ansicht.

1. In der Zeile unter **„Zuordnen zu“** die Wohnung wählen.
2. Optional **„Re-Mail an Bewohner senden“** anhaken (schickt die Rechnung samt PDF
   an den Bewohner).
3. **„Zuordnen“**.

Empfänger ist automatisch der aktuelle Kontakt der Wohnung in der Reihenfolge Mieter,
Bewohner, Eigentümer.

| Meldung | Bedeutung |
|---|---|
| „Bitte eine Wohnung wählen.“ | Auswahl fehlt |
| „Rechnung ist bereits zugeordnet. Umhängen nur durch Technik.“ | bereits zugeordnete Rechnungen ändert nur die Technik |
| „Kein Zugriff auf diese STWEG“ | Wohnung oder Rechnung gehört zu einer anderen STWEG, oder die Rechnung hat keine STWEG (dann ordnet die Technik zu) |

### 8.2 Konfiguration und Aliase

- Konfiguration (Modul aktiv, Archiv-Postfach, Rechnungsadresse Verwaltung,
  Allgemeinzähler-Empfänger, Axova-Adresse, Notizen, Schalter „Eigentümer sieht auch
  die Online-Rechnungen vermieteter Wohnungen“) speichert der Ausschuss der STWEG.
  **Alias-Domain und Alias-Prefix** ändert nur Technik/Präsident; Änderungen des
  Ausschusses an diesen beiden Feldern werden ignoriert.
- **„⟳ Aliase nach Mailcow syncen“** schreibt die Aliase aller Wohnungen.
- Mieterwechsel: Ab dem „Gültig ab“-Datum in der Objektverwaltung wird ein neuer
  Alias aktiv; der alte bleibt 6 Monate für die Schlussabrechnung bestehen, und die
  Axova AG wird per Mail über die Freigabe-Outbox informiert.

---

## 9. Unterschriftenlisten und Rückläufe

### 9.1 Liste erstellen

Objektverwaltung, Reiter **„Unterschriftenlisten“**:

1. **STWEG** wählen, optional einzelne **Häuser**.
2. **Datum**, **Anlass-Titel**, **Zweck / Beschreibung**, **Rücksendung bis**,
   **Rücksendung an**.
3. Unter **Zeichnungsberechtigte** mit **„+ Person“** die Personen erfassen, die den
   Beschluss mitunterzeichnen; optional den Kollektiv-Text anpassen.
4. **„Vorschau“**, dann **„PDF herunterladen“**.

Erstellen darf nur, wer in dieser STWEG schreiben darf (Ausschuss dieser STWEG,
Verwaltung mit Gruppe der STWEG, Technik). Das PDF enthält alle Eigentümer mit
Wohnung, Wertquote und Verwalter, Seitenzahlen und einen Prüf-Hash. Unter **„Bisher
generierte Unterschriftenlisten“** stehen je Liste die Links **Ansehen**, **PDF** und
**Verify**.

Hinweis: Der PDF-Link einer erzeugten Liste ist ohne Anmeldung abrufbar, wenn man
den 12-stelligen Hash kennt. Links daher nicht öffentlich weitergeben.

### 9.2 Rückläufe erfassen (`unterschriftenliste-rueckläufe.html`)

Die Seite hat keinen Menüeintrag; Adresse direkt aufrufen.

1. Unter **„Generierte Liste auswählen“** die Liste wählen (es erscheinen nur Listen
   der eigenen STWEGs).
2. Je Brief **Vote** (✓ JA, ✗ NEIN, ~ Enthaltung), **Zurück am** und **Notiz**
   setzen. Gespeichert wird sofort; die Notiz eine halbe Sekunde nach der letzten
   Eingabe. Wird ein Vote ohne Datum gesetzt, trägt die Seite das heutige Datum ein.
3. Filter **Alle / Offen / Zurück / NEIN**, Fortschrittsbalken und Zähler oben;
   **„⬇ Excel“** exportiert die Tabelle.

Lesen dürfen alle mit einer Gruppe der STWEG; speichern nur, wer in der STWEG
schreiben darf. Sonst: „Speichern fehlgeschlagen“ bzw. „Kein Zugriff auf diese
STWEG“.

---

## 10. Vollmachten prüfen und aktivieren

Seite: **Vollmachten** (`vollmachten.html`). Der Ausschuss sieht unter **„Alle
(Admin)“** alle Vollmachten seiner STWEG(s) sowie die eigenen.

Ablauf einer Vollmacht:

1. **Entwurf**: über „+ Neue Vollmacht erteilen“ oder automatisch bei einer
   Verwalter-Kontaktkarte. Bewohner können Vollmachten nur für eigene Wohnungen bzw.
   STWEGs erfassen; Verwaltung, Technik und Präsident auch für Dritte.
2. **Unterschreiben**, je Vollmachtgeber:
   - **„✓ Digital signieren“** – unter dem bestätigten Namen des Kontos, mit Zeit, IP
     und Konto im Dokument. Fehlt ein bestätigter Name: „Für dein Konto ist kein
     bestätigter Name hinterlegt — bitte die Verwaltung kontaktieren oder auf Papier
     unterschreiben“.
   - oder **„📤 Signierte PDF hochladen“** – die eigene unterschriebene Seite (nur
     PDF, höchstens 20 MB). Ein Geber zeichnet damit nur seine eigene Zeile.
3. Haben **alle** Vollmachtgeber unterschrieben, wird die Vollmacht **aktiv**.
   Sobald einer unterschrieben hat, ist der Inhalt gesperrt („Bereits teilweise
   signiert — Änderungen nicht mehr möglich. Entwurf löschen und neu erfassen.“).

Aufgaben für Ausschuss und Verwaltung:

- **„🤖 KI-Prüfung“** (sichtbar, sobald die Vollmacht eine Gesamt-PDF hat, also nach
  einem Admin-Upload oder wenn alle Geber auf Papier unterschrieben haben): prüft, ob Dokument-Hash,
  Namen und Unterschriften im PDF erkennbar sind. Erlaubt für Vollmachtgeber,
  Ausschuss der STWEG, Verwaltung, Technik, Präsident; höchstens 10 Prüfungen pro
  Stunde („Zu viele KI-Prüfungen — bitte in Ns erneut“). Das Ergebnis ist eine
  Hilfe, keine Rechtsprüfung – die Unterschriften selbst ansehen.
- **„📄 Papier aktivieren“** (nur **Verwaltung**, Technik, Präsident): aktiviert einen
  Entwurf ohne Upload, wenn das unterschriebene Original aller Vollmachtgeber vorliegt
  (z. B. bei der Verwaltung). Der Ausschuss kann das nicht („Nur Admin — Vollmachtgeber
  laden die unterschriebene PDF hoch“).
- **„📤 PDF aller Geber hochladen (Admin)“**: nur Technik/Präsident
  ([anleitung-technik.md](anleitung-technik.md), Abschnitt 5).
- **Widerrufen** dürfen nur Vollmachtgeber selbst oder Technik/Präsident.

---

## 11. Dokumente und gesperrte Ordner

Dokumente liegen im Bereich **Dokumente** der Startseite. Lesen darf jedes Mitglied
`allgemein/`, `scans/` und die Ordner seiner STWEG(s); `projekte/` alle Eigentümer.

Hochladen, Ordner anlegen, Umbenennen/Verschieben und Löschen dürfen Ausschuss,
Technik und Präsident. Der Ausschuss darf in `allgemein/`, `projekte/` und in den
STWEG-Ordnern schreiben, in denen er eine Gruppe hat.

- Erlaubte Dateitypen: pdf, png, jpg, jpeg, gif, txt, csv, doc, docx, xls, xlsx,
  ppt, pptx, odt, ods, odp, dotx, zip, tif, tiff, bmp. Sonst: „Dateityp .xyz nicht
  erlaubt“.
- Verschieben geht nur für Dateien (nicht Ordner), die Zieldatei braucht eine erlaubte
  Endung und darf nicht schon existieren („Zieldatei existiert bereits“).
- Eine ganze oberste Ebene (z. B. den Ordner `stweg5` selbst) kann nur die Technik
  verschieben oder ersetzen.

**Gesperrte Unterordner** – über die Dokumenten-Ablage nur für Technik/Präsident, weil
sie eigene Seiten mit eigener Rechteprüfung haben:

| Unterordner | Inhalt | Zugriff stattdessen über |
|---|---|---|
| `auslagen/` | Belege | Auslagen |
| `reklamationen/` | Fotos der Meldungen | Reklamationen |
| `unterschriftenlisten/` | erzeugte Listen | Objektverwaltung, Unterschriftenlisten |
| `anzeigen/` | Aushänge der Anzeigen | Stationen (Technik) |
| `grundbuch-bilder/` | Grundbuchauszüge | Grundbuch |
| `fotos_von_versendeten_briefen/` | Fotos mit Empfängeradressen | nicht gesperrt, aber nur für Ausschuss (lesen und ablegen), Technik, Präsident |

Wer in einem gesperrten Ordner etwas ablegen will, bekommt „Kein Schreibzugriff auf
diesen Ordner“.

---

## 12. ISP-Freigaben

Mail-Relays, Weiterleitungen und Reverse-Proxy-Routen von Bewohnern gibt nur die
Technik (bzw. der Präsident) in `isp-admin.html` frei. Der Ausschuss hat dort keinen
Zugang („Nur für Technik/Präsident.“). Anleitung: [anleitung-technik.md](anleitung-technik.md),
Abschnitt 6.

---

## 13. Doodle-Umfragen (`sitzungs-doodle.html`)

1. **„+ Neue Terminumfrage“**: Titel, Beschreibung, Ort, Terminvorschläge, optional
   Frist, „Teilnehmer dürfen eigene Vorschläge ergänzen“ und externe Einladungen.
2. Mitglieder stimmen mit Ja / Vielleicht / Nein und **„Stimme speichern“**.
3. **„📧 Externe einladen“**: E-Mail eintragen, **„Einladen“**. Externe melden sich mit
   einem 8-stelligen Code an, der per E-Mail kommt (gleiche Regeln wie in 5.4).
4. **„📞 Telefonische Rückmeldung erfassen“** für Personen ohne Internet.
5. **„Umfrage schliessen“**: Die Seite schlägt die Option mit den meisten Zusagen als
   Termin vor (Teilnehmer werden per E-Mail informiert); ohne Bestätigung wird ohne
   Termin geschlossen. Bei einer geschlossenen Umfrage lässt sich mit **„als Termin
   wählen“** eine andere Option festlegen, mit **„wieder öffnen“** die Umfrage erneut
   öffnen. Ein festgelegter Termin erscheint automatisch unter „Nächste Termine“ der
   STWEG.

Ändern, schliessen, löschen und einladen dürfen nur die Erstellerin bzw. der
Ersteller sowie Technik und Präsident („Nur Ersteller:in oder Admin“).

**Einladungs-Grenzen:**

| Grenze | Meldung |
|---|---|
| höchstens **50 Einladungen je Umfrage** | „Höchstens 50 Einladungen je Umfrage“ |
| höchstens **100 Einladungen pro Tag und Konto** (über alle Umfragen) | „Zu viele Einladungen heute — bitte morgen weiter.“ |

Der Tageszähler liegt im Arbeitsspeicher der API und beginnt nach einem Neustart neu.
