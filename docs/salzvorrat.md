# Salzvorrat der Enthärtungsanlagen

Lager: **Rosenweg 2, Rosenweg 4, Rosenweg 9, Rosenweg Kooperation** (Lager im Rosenweg 10) — je ein eigener
Bestand an Säcken. Gebucht wird mit der App **Rosenweg Salz** (Barcode-Scanner,
Android zuerst); die Seite [`salz.html`](../salz.html) zeigt Bestand, Verlauf
und Sorten und stellt die Schwellen ein.

Code: `api/routes/salz.js` (Routen, Schema, Meldelauf), `api/lib/salz.js`
(Rechnung, getestet mit `node --test api/test/`). Die Anmeldung der App
(Authentik `rosenweg-apps`) prüft `authMiddleware` selbst.

## Datenmodell

| Tabelle | Inhalt |
|---|---|
| `salz_lager` | ein Eintrag je Lager (`haus2`, `haus4`, `haus9`, `kooperation`; Kooperation ohne Hausnummer, `ort` = „Lager im Rosenweg 10“). Einstellungen `schwelle_wochen` (4), `mindest_saecke` (4), `wiederholung_tage` (7), `hauswart_emails`, `bewohner_gruppen`; Meldezustand `meldung_seit`, `meldung_zuletzt`. |
| `salz_sorten` | Barcode → Bezeichnung, Gewicht je Sack (kg). Wird beim ersten Scan eines unbekannten Barcodes in der App erfasst. |
| `salz_buchungen` | `anlieferung` (+n), `eingefuellt` (−1), `korrektur` (gezählter Bestand, ± Differenz); mit `kg_je_sack` zum Buchungszeitpunkt, `client_id` gegen Doppelbuchungen, Storno statt Löschen. |

Bestand = Summe der nicht stornierten Buchungen (Säcke bzw. Säcke × kg).
Einfüllen unter null wird abgewiesen (409, „zuerst Anlieferung buchen“).

## Reichweite und Meldung

1. **Zusammenfassen**: Buchungen „Sack eingefüllt“, die höchstens 6 Stunden
   nach der vorherigen kommen, sind *eine* Einfüllung (kg zusammengezählt) —
   wer 10 Säcke auf einmal einfüllt und einzeln scannt, hat einmal eingefüllt.
2. **Datenlücken** zählen nicht: Ein Abstand zwischen zwei Einfüllungen ist
   eine Lücke, wenn er länger ist als 3 × üblich (Median der Abstände, bei
   einer grossen Einfüllung mindestens deren kg × Median der Tage je kg —
   10 Säcke halten zu Recht länger), oder länger als 90 Tage je 25 kg der
   vorherigen Einfüllung (gilt auch, wenn es für den Median noch keine 3
   Abstände gibt). Die Lücken teilen den Verlauf in Abschnitte.
3. **Verbrauch** aus dem jüngsten Abschnitt mit genug Daten — darin
   bevorzugt die letzten 26 Wochen, sonst der ganze Abschnitt. Reicht der
   jüngste nicht (etwa die erste Einfüllung nach einer Lücke), der letzte gute
   Abschnitt davor. Eine Einfüllung reicht bis zur nächsten; die Einfüllungen
   1…n−1 decken die Zeit von der ersten bis zur letzten:
   `kg/Woche = kg(1…n−1) / Wochen(t_n − t_1)`. Die API nennt die Grundlage
   (`verbrauch_grundlage`: von, bis, Anzahl, `aktuell`).
4. **Genug Daten** = mindestens 3 (zusammengefasste) Einfüllungen, die
   mindestens 14 Tage auseinanderliegen. Dann `Reichweite = Bestand kg / kg pro Woche`;
   knapp, wenn sie unter `schwelle_wochen` liegt.
5. **Sonst Mindestbestand**: knapp bei `Bestand ≤ mindest_saecke`.
   Ein leeres Lager ist immer knapp — aber erst, wenn darin je gebucht wurde
   (ein Lager ohne Buchungen ist „noch nicht in Betrieb“ und meldet nichts).
6. **Mail** an `SALZ_MELDUNG_AN` (Vorgabe `technik@rosenweg4303.ch`) und an die
   Hauswart-Adressen des Lagers (im Portal je Lager), einmal je
   Unterschreitung. Bleibt es knapp, eine **Erinnerung** nach
   `wiederholung_tage`, gezählt ab der letzten Mail oder der letzten
   Anlieferung (was später ist). Reicht der Vorrat wieder, endet die
   Unterschreitung still.

Geprüft wird nach jeder Buchung und stündlich (Erinnerungen nur 7–20 Uhr).

## Nächster Sack

Je Lager: **letzte (zusammengefasste) Einfüllung + ein Sack (`kg_je_sack`) ÷
kg pro Woche**, auf den Tag (Zürich) — dann ist in der Anlage wieder Platz für
einen Sack (Präzisierung Stefan 27.11.2026). Auch nach 10 Säcken auf einmal
zählt nur ein Sack; wie lange alles reicht, steht separat in
`inhalt_reicht_bis`. Angezeigt als „Nächster Sack etwa am …“ (eine Schätzung)
in der App und auf `salz.html`. Ohne genug Daten kein Termin, sondern
`naechster_sack_hinweis` (z. B. „Noch zu wenig Daten für eine Schätzung …“).
Nach jeder Einfüllung wird neu ab dieser gerechnet; wer eine Einfüllung
rückgängig macht, holt den alten Termin zurück.

Ab dem Tag davor um 8 Uhr (geprüft alle 15 Minuten, Mails nur 8–20 Uhr) geht
**einmal je Fälligkeit** — also einmal seit der letzten Einfüllung,
gemerkt in `einfuellen_gemeldet_am` — eine Mail über denselben Weg wie die
Nachbestell-Meldung (`loggedSendMail`, Mailcow-Gateway) an die
Hauswart-Adressen des Lagers, ohne Hauswart an `SALZ_MELDUNG_AN`. Verschiebt
sich der geschätzte Tag danach noch, kommt keine zweite Mail. Dazu Web-Push
(`lib/webpush.js`, dieselben Abos wie die Rosenweg-PWA) an die Hauswart-Konten.
War der Server weg, wird bis 2 Tage nach dem Tag nachgeholt; ältere
Fälligkeiten (z. B. aus importierten Listen) lösen nichts aus. Je Lager
abschaltbar (`erinnerung_einfuellen`, Portal). `einfuellen_gemeldet_fuer`
zeigt den Tag der letzten Erinnerung.

## API (`/api/salz`)

Anmeldung: `authMiddleware` — Token der Authentik-Anwendung `rosenweg-apps`
(App) oder normale Portal-Anmeldung.

| Wer | darf |
|---|---|
| Technik, Präsident | alles: alle Lager buchen, Bestand setzen, Schwellen, Sorten, Hauswart-Adressen, Bewohnergruppen |
| Gruppen aus `SALZ_GRUPPEN` | in allen Lagern buchen, neue Sorten beim Scan erfassen |
| Bewohner (`bewohner_gruppen` des Lagers, auch über Obergruppen) | nur im eigenen Lager: Anlieferung, Sack eingefüllt, eigene Buchung innert 24 h rückgängig; sehen nur dieses Lager und nur die eigenen Namen im Verlauf |

Bewohnergruppen zu Beginn (aus `STWEG_GROUPS` über das STWEG des Hauses — es
gibt keine Gruppe je Haus): Rosenweg 2 und 4 → `stweg7-bewohner` (beide
STWEG 7, also dürfen Bewohner von 2 auch in 4 buchen und umgekehrt),
Rosenweg 9 → `r9-bewohner`, Kooperation (Rosenweg 10, STWEG 4) →
`stweg4-bewohner`. Im Portal je Lager änderbar.

Menü und Stationen: Der Eintrag „Salzvorrat“ in `js/nav.js` steht für
Technik, Präsident und die drei Bewohnergruppen oben. Die Stationen zeigen den
Starter der App Rosenweg Salz (os-stationen, `pakete/rosenweg-salz`) genau den
Gruppen aus `/api/stations/<id>/apps` für die Seite `rosenweg-salz`: die aus
nav.js plus `buchungsGruppen()` — `SALZ_GRUPPEN` und die `bewohner_gruppen`
der aktiven Lager, wie sie im Portal stehen (`api/lib/stationapps.js`,
`ZUSATZ_GRUPPEN`). Wer im Portal eine Gruppe dazunimmt, sieht den Starter nach
dem nächsten Lauf von install.sh auf der Station.
Grenzen je Konto: 600 Lese- und 120 Schreibanfragen pro Stunde (429 mit
`Retry-After`).

| | |
|---|---|
| `GET /ich` | `{name, darf_buchen, darf_einstellen, darf_sorten_erfassen, lager_ids}` |
| `GET /lager` | die Lager, in denen man buchen darf, mit Ort, Bestand, Verbrauch (`verbrauch_kg_woche`, `verbrauch_grundlage`), Reichweite, `knapp`, `naechster_sack` (YYYY-MM-DD, Schätzung) bzw. `naechster_sack_hinweis`, `inhalt_reicht_bis`, `letzte_einfuellung_zusammen` (Hauswart/Gruppen nur für Technik) |
| `GET /lager/:id/verlauf?anzahl=50` | Buchungen |
| `PUT /lager/:id` | `{schwelle_wochen, mindest_saecke, wiederholung_tage, hauswart_emails, bewohner_gruppen, erinnerung_einfuellen}` |
| `POST /lager/:id/inventur` | `{saecke}` gezählter Bestand |
| `GET /sorten`, `GET /sorten/:barcode` | 404 `{unbekannt:true}` für neue Barcodes |
| `POST /sorten` | `{barcode, bezeichnung, gewicht_kg}` (nicht Bewohner) |
| `PUT /sorten/:barcode` | ändern (Technik) |
| `POST /buchungen` | `{lager_id, art: anlieferung\|eingefuellt, barcode, saecke, client_id}` |
| `DELETE /buchungen/:id` | rückgängig: eigene innert 24 h, Technik immer |

## Einrichtung

Variablen in der API-`.env` (alle optional):

- `SALZ_MELDUNG_AN` — Empfänger der Meldung (Vorgabe `technik@rosenweg4303.ch`)
- `SALZ_GRUPPEN` — weitere Authentik-Gruppen, die buchen dürfen, kommagetrennt
- `SALZ_PORTAL_URL` — Link in der Mail (Vorgabe `https://rosenweg4303.ch/salz.html`)

Authentik, Anwendung `rosenweg-apps`: Weiterleitungs-URI (Strikt)
`ch.rosenweg4303.salz:/anmeldung` für die App ergänzen.
