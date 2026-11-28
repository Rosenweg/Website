# Konto-Löschung

Stand 28.11.2026. Klärung Personen, Funde F2 („Löschung unvollständig“) und F3
(„Anlage-Schritte ohne Wiederholung“). Entscheid Stefan: **vor dem Bau beheben**.

Code: `api/lib/kontoloeschung.js` (Regeln, Nachlauf, Aufräumlauf), `api/server.js`
(`trackRemovedKontakte`, `processAuthentiKDeletions`, `lokalesKontoNachLoeschung`,
`nachlauf*`, `personenAufraeumen`, Routen `/api/admin/pending-deletions*`),
`pbx/api/app.py` (`/api/pbx/person/loeschen`), `nextcloud/nc-token/nc_token.py`
(`/konto-loeschen`), Seite `loeschungen.html`.

## 1. Ablauf

1. **Vormerkung.** Wird eine Adresse aus der letzten aktiven Wohnung entfernt, entsteht
   eine Vormerkung mit **30 Tagen** Frist. Die Person bekommt am **Tag 23** (7 Tage
   vorher) eine Erinnerung.
2. **Manuell zu prüfen.** Konten, die nicht ausschliesslich in Bewohner-/Eigentümergruppen
   dieser STWEG sind (Ausschuss, Verwaltung, Technik, weitere Gruppen), werden **nie
   automatisch** gelöscht. Sie stehen auf der Seite in der Liste „Manuell zu prüfen“
   (`manuell_pruefen = true`), ohne Erinnerung. Ändern sich die Gruppen während der
   Frist, wechselt die Vormerkung beim Löschlauf ebenfalls in diese Liste.
3. **Löschen** (täglich 02:00): Konto in Authentik hart löschen, dann
   `lokalesKontoNachLoeschung`: lokale Zeile deaktivieren, Sitzungen und Token beenden,
   VPN sperren, **Nachlauf** anlegen.
4. **Nachlauf** (Tabelle `konto_loeschung_nachlauf`, ein Eintrag je Bereich). Nur wenn
   kein anderes Authentik-Konto mit derselben Adresse besteht – sonst gehören die Daten
   dem verbleibenden Konto.

   | Bereich | Was | Wie |
   |---|---|---|
   | `anlage` | Telefonanlage CT 220: abmelden, Nextcloud-App-Passwörter widerrufen, **Nextcloud-Konto löschen** (`nextcloud_konto`), SIP, Combox, Nummer, Einstellungen/PIN/Ausweise/Hintergrund, Anrufe und Protokoll anonymisieren | `POST /api/pbx/person/loeschen` mit `schritte` und `nummern`; das Nextcloud-Konto löscht die Anlage über nc-token auf CT 104 (`POST /konto-loeschen`, alle Konten der Adresse, nie ein Mitglied von `admin`) |
   | `mailbox` | Mailcow-Mailboxen, die der Person **zugeordnet** sind (`mailbox_requests.assigned_user_email`, Status `approved`). Geteilte Mailboxen (ohne Zuordnung) bleiben. | `mailboxAnfrageLoeschen` (dieselbe Funktion wie ISP-Admin → Mailbox löschen) |
   | `karten` | Rosenweg-Karten (NFC in UniFi Access) der Person entziehen; Zusatzadressen (`person_email_alias`) entfernen | UniFi Access `PUT /users/:id/nfc_cards/delete`, Kartenprotokoll `entziehen` durch „Konto-Löschung“. Die Karte bleibt im Bestand. |

   Jeder Versuch steht im `admin_protokoll` (Bereich `loeschungen`, Aktion
   `nachlauf-<bereich>`) und damit im Verlauf der Seite. Ein gescheiterter Schritt bleibt
   vorgemerkt und wird mit **Backoff** wiederholt: 15 min, 30 min, 1 h, 2 h … höchstens
   24 h, ohne Ende. Bei der Anlage werden nur die offenen Schritte wiederholt; die
   Nummern aus dem ersten Versuch gehen mit (die Anrufe werden auch dann noch
   anonymisiert, wenn die Nummer schon freigegeben ist).
   Ab **3 Fehlversuchen** (`KONTO_NACHLAUF_SICHTBAR_AB`) erscheint der Eintrag oben auf
   der Seite „Nach der Löschung noch offen“, mit „Jetzt versuchen“.
5. **Aufräumlauf** (täglich 02:30, `personenAufraeumen`), **3 Monate** nach dem Auszug
   bzw. der Löschung:
   - **Personen-Stammdaten** (`personen`): Personen ohne aktiven Wohnungskontakt, ohne
     aktives Konto und ohne offene Vormerkung, deren letzter Auszug (`archiviert_am`)
     bzw. Konto-Löschung 3 Monate zurückliegt. Ohne Verweise aus anderen Bereichen
     werden sie **gelöscht**. Verweist noch ein anderer Bereich auf sie (WhatsApp,
     Vollmachten, Reklamationen, Rufgruppen …), werden sie **anonymisiert** (Name
     `gelöscht #<id>`, alle anderen Felder leer), damit der spätere Ablauf dieses
     Bereichs sie noch findet. Nie verknüpfte Personen (frisch angelegt) bleiben.
   - **Archivierte Wohnungskontakte**: anonymisiert nach dem Muster der Anlage
     (Anrufliste, Protokoll): die Zeile bleibt für die Geschichte der Wohnung (Rolle,
     gültig ab, archiviert am), Name wird `gelöscht`, E-Mail, Telefon, Mobile, Adresse
     und Personen-Verweis werden leer. Wer im Haus umzieht oder noch ein Konto hat,
     bleibt unverändert.
   - **Erledigte Nachläufe**: E-Mail und Name werden ebenfalls entfernt.

## 2. Rechte

| Aktion | Wer |
|---|---|
| Liste und Verlauf sehen | Recht `loeschungen` lesen; Ausschuss/Verwaltung nur die eigene STWEG |
| Stoppen, Timer +30 Tage | Recht `loeschungen` schreiben: Technik, Präsident und (seit 28.11.2026 vorgegeben, Migration `2026-11-28-loeschungen-ausschuss-verwaltung-write`) Ausschuss und Verwaltung **der eigenen STWEG** |
| Eintrag entfernen | nur **Technik** |
| Sofort löschen | nur **Technik und Präsident**, nur mit **frischer Konto-Anmeldung** (Website oder App, höchstens 15 Minuten alt), nie mit Karte, QR, Anlage-Token, persönlichem Token oder MCP. Nie für Technik-, Präsident- oder Superuser-Konten (die nur über Konten). Steht im Verlauf. |
| Nachlauf „Jetzt versuchen“ | Recht `loeschungen` schreiben, eigene STWEG |

## 3. Noch offen: eigene Abläufe je Bereich (TODO)

Diese Bereiche werden bei der Konto-Löschung **nicht** angefasst. Jeder bekommt später
einen eigenen Ablauf. Vorher ist je Bereich die Aufbewahrungsfrage zu klären.

- [ ] **Mail-Archiv** (`email-archiv`, IMAP-Archiv, `email_log`): Mails von und an die
      Person, Löschanträge mit 4-Augen-Prinzip.
      *Frage:* Gehören Mails an die Verwaltung/den Ausschuss zur Geschäftskorrespondenz der
      STWEG (Aufbewahrung 10 Jahre, OR 958f) oder sind sie nach Erledigung zu löschen?
      Reicht das bestehende Löschantrags-Verfahren, oder braucht es eine Löschung „alle
      Mails dieser Adresse“?
- [ ] **WhatsApp** (`whatsapp_messages` mit `person_id`, Telefonnummer und Text,
      Outbox, Opt-in in `personen`).
      *Frage:* Wie lange bleiben Nachrichten? Vorschlag: Inhalt nach 3 Monaten löschen,
      Zeile anonymisieren (Telefon → `gelöscht`), wie die Anrufliste. Gibt es Nachrichten
      mit Belegcharakter (Reklamations-Bestätigungen)?
- [ ] **Reklamationen** (`reklamationen.person_id`, Melder-Name/-Kontakt als Text, Fotos).
      *Frage:* Reklamation bleibt als Vorgang der STWEG (Gewährleistung, Versicherung).
      Melder nach Abschluss anonymisieren? Ab wann (Abschluss + x Jahre)?
- [ ] **Vollmachten** (`vollmachten`, Geber und Bevollmächtigter, Namen als Text,
      signierte PDFs).
      *Frage:* Vollmachten sind Belege einer Versammlung (Protokoll, Beschlüsse) und
      gehören zur Aufbewahrungspflicht; Anonymisieren unmöglich. Frist ab Versammlung?
      Was geschieht mit nicht genutzten Vollmachten?
- [ ] **Auslagen** (`auslagen`, Belege, IBAN, Name).
      *Frage:* Buchhaltungsbelege, 10 Jahre (OR 958f). Nach Ablauf löschen; IBAN früher
      entfernen (nach Auszahlung)?

Ebenfalls nicht angefasst, zu prüfen:

- [ ] **UniFi-Access-Benutzer** selbst (Name, E-Mail, Kennzeichen); entfernt werden nur
      die Karten. *Frage:* Benutzer löschen oder deaktivieren?
- [ ] **Mailcow-Aliasse**, die auf die Person zeigen (nur die zugeordnete Mailbox wird
      gelöscht).
- [ ] **Protokolle mit E-Mail** (`admin_protokoll`, `access_karten_protokoll`): bleiben
      als Nachweis. *Frage:* Nach welcher Frist anonymisieren?
- [ ] **Alte Wohnungsspalten** (`wohnungen.eigentuemer_*`, `mieter_*`, vor der
      Kontakte-Tabelle): prüfen, ob noch befüllt.
- [ ] **Dokumente, Beschlüsse, Rechnungen** bleiben gemäss Aufbewahrungspflicht mit Namen
      (Entscheid E3e).

## 4. Inbetriebnahme

Reihenfolge, damit kein Schritt ins Leere läuft:

1. **CT 104** nc-token aktualisieren (`/konto-loeschen`); sonst bleibt `nextcloud_konto`
   offen und wird wiederholt (sichtbar nach 3 Versuchen).
2. **CT 220** pbx-api (`schritte`, `nummern`, `nextcloud_konto`). Eine alte Anlage
   ignoriert `schritte` und meldet `nextcloud_konto` nicht: der Schritt bleibt offen,
   bis sie aktualisiert ist.
3. **Haupt-API** (CT 128). Die Spalten und die Tabelle legt `initDB` bzw.
   `kontoLoeschung.bereit` an; die Rechte-Migration läuft einmal beim Start.

Umgebungsvariable: `KONTO_NACHLAUF_SICHTBAR_AB` (Standard 3, 1–50).
