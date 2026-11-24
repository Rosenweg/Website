# Plan: Nummernplan, persönliche Nummern und Rosenweg Telefon mit eigenem SIP

Stand 24.11.2026. Entscheide von Stefan in diesem Gespräch.

## Nummernplan (intern)

| Bereich | Wer | Beispiel |
|---|---|---|
| **2000er** | Rosenweg-eigene Dienste, auch der Hauswart und die geteilten Telefone | 2002 Rosenweg Smartphone 2 |
| **3000er** | Personen: `3 HH WW P` (6 Stellen) | 309011 = Haus 9, Wohnung 01, Person 1 |
| **4000er** | Hausverwaltung, heute Immosense: 4000 Hauptnummer, 4001 … Mitarbeiter | 4000 Immosense |

2000er unterteilt (Entscheid 24.11.): **2000–2099 Dienste** (Hauswart, Technik …; dahinter ein
Gerät oder eine Gruppe), **2100–2199 Geräte** (geteilte Telefone, Testgeräte). Die heutigen
2000–2003 ziehen in Schritt 2 auf 2100–2103 um.

### 3000er: `3 HH WW P`

- `HH`: Hausnummer zweistellig (01–18).
- `WW`: Wohnung im Haus (01–10; Haus 17 hat 10). Gibt es schon eine Nummer nach dem Muster
  Haus + zweistellig (`1305`, `1402`, `1601`), wird sie übernommen. Sonst wird einmalig fest
  durchnummeriert und gespeichert. Die Zuordnung wird nicht zur Laufzeit erraten (siehe
  `api/lib/haeuser.js`).
- `P`: Person in der Wohnung (1–9). Zuerst die Eigentümer, dann die Bewohner und Mieter,
  jeweils in der Reihenfolge der Eingabe (`wohnungen_kontakte.sort_order`/`created_at`).
- **Eigentümer, die am Rosenweg wohnen:** Nummer aus der eigenen Wohnung. In ihren übrigen
  Wohnungen bekommen sie keine weitere.
- **Vermieter**, die nicht am Rosenweg wohnen: Nummer aus ihrer (ersten) vermieteten Wohnung.
  Als Eigentümer sind sie dort P = 1, die Mieter folgen.
- Grundlage: `wohnungen` und `wohnungen_kontakte` (Postgres auf CT 128), 102 Wohnungen, 125 Personen
  mit E-Mail, höchstens 4 Personen pro Wohnung.
- Wer umzieht, bekommt eine neue Nummer. Das ist bei diesem Schema so gewollt.
- `WW` aus der Bezeichnung, wo sie eine Nummer trägt: `1305` → 05, `RW1-03` → 03. Sonst einmalig
  nach Stockwerk durchnummeriert (`9.EG.1` …).
- Firmen und Körperschaften als Eigentümer (AG, GmbH, Gemeinde …) bekommen keine persönliche Nummer.
- Personen ohne E-Mail bekommen keine Nummer, weil sie sich nicht anmelden können.
- Entwurf 24.11.: 118 Personen in 97 Wohnungen, davon 19 Vermieter. Erzeugt mit `nummernplan.py`.
  Liste nicht im Repo, weil sie Personendaten enthält.
- **4000er:** 4000 = Immosense AG (+41 61 225 45 50). Nur Festnetznummern (Entscheid);
  Mitarbeiter mit Festnetz gibt es im Telefonbuch derzeit keine, Cyril Welti nur mobil.

## Persönliche Nummer: was sie kann

- **Erreichbar, egal wo:** Ein Anruf auf 3HHWWP klingelt gleichzeitig
  - an jedem geteilten Telefon, an dem die Person angemeldet ist (`telefon_sitzungen`),
  - am privaten Handy, wenn dort Rosenweg Telefon mit dieser Nummer eingerichtet ist,
  - danach die Weiterleitung aus „Mein Profil“, sonst die persönliche Voicemail.
- **Abgehend:** Wer an einem geteilten Telefon angemeldet ist, ruft intern mit seiner
  3000er-Nummer an (Rückruf erreicht die Person, nicht das Gerät).
- **Name mitschicken (Entscheid 24.11.):** Bei ausgehenden Anrufen setzt die Anlage den Namen
  der Person als Anrufer-Namen (`CALLERID(name)`), intern also z.B. „Stefan Müller“ mit 309093.
  Nach außen nur, soweit der Anbieter den Namen weitergibt (meist nur die Nummer).
- **Weiterleitung nach außen:** für alle erlaubt, standardmäßig aus.
- Die öffentliche Nummer und die Klingelgruppen der STWEG bleiben unverändert. Notrufe sind
  nicht betroffen.

## „Mein Profil“ (Web und Rosenweg Telefon, gespeichert auf der Anlage)

- Weiterleitung: aus / immer / wenn nicht erreichbar nach X Sekunden, Zielnummer
- persönliche Voicemail an/aus, Ansage
- später: Nicht stören, Zeiten
- Einstellungen der Telefon-App pro Person (Regel 7, Entscheid: auf der Anlage statt Nextcloud)

## Rosenweg Telefon wird ein eigenes SIP-Telefon

- Der SIP-Kern (sipdroid mit ConnectionService, heute in der Geräte-App `android-sip-rosenweg`)
  kommt in Rosenweg Telefon (`ch.rosenweg4303.phone`).
- **Geteiltes Telefon:** Die Geräte-App richtet Rosenweg Telefon ein. Sie übergibt
  Nebenstelle, Passwort und Server über einen Weg, den nur Rosenweg-signierte Apps nutzen
  können. Die Geräte-App behält Kiosk, Sitzung, Katalog und Abgleich, macht aber kein SIP mehr.
- **Privates Handy:** Einrichtung per QR-Code (`/prov/<token>`, wie heute bei Linphone).
  Die Person meldet sich einmal an, die Sitzung bleibt.
- **Daten aus der Anlage (Regel 6):** Rosenweg Telefon fragt die Anlage direkt mit Nebenstelle
  und Passwort (HTTP Basic). Die Person kommt aus der Sitzung bzw. der 3000er-Nummer.
  - Verlauf: Anrufe der Person über alle Geräte, mit Voicemail-Zusammenfassung
  - Voicemail anhören
  - Einstellungen pro Person

## Anlage (pbx-api auf CT 220)

1. `calls` bekommt `ext` und `person` (E-Mail zur Zeit des Anrufs) und füllt sie in
   `call-event`/`cdr`.
2. Tabelle `personen_nummern` (Nummer, E-Mail, Name, Wohnung-ID, Weiterleitung, Voicemail …),
   erzeugt aus `wohnungen`/`wohnungen_kontakte`; Abgleich wie beim Telefonbuch.
3. Tabelle `verwaltung_nummern` (4000er) und Dienste (2000er) im Admin pflegbar.
4. Dialplan: 3XXXXX → Lookup bei der pbx-api (wo ist die Person?) → Dial an Geräte mit Sitzung
   + persönliches Endgerät, dann Weiterleitung bzw. Voicemail. 4XXX → externe Nummer.
5. Schnittstellen: `/api/telefon/anrufliste`, `/api/telefon/voicemail/<id>`,
   `/api/telefon/einstellungen`, `/api/telefon/profil` (Weiterleitung). Anmeldung mit
   Nebenstelle und Passwort für alle `android-sip`-Nebenstellen, nicht nur `geteilt`.

**Ausrollen:** `/opt/pbx-api` auf CT 220 ist kein Git-Checkout. Vorher `app.py.vor-<thema>`
sichern, Dateien per `pct push` einspielen, `systemctl restart pbx-api`. So war es bisher.

## Reihenfolge

1. ✓ 24.11.: Anlage: `calls.ext/person/ziel_ext/ziel_person` (bestehende Anrufe ueber `telefon_log`
   nachgetragen), `GET /api/telefon/anrufliste`, `GET|PUT /api/telefon/einstellungen?paket=`,
   Anmeldung mit Nebenstelle und Passwort fuer jede aktive Nebenstelle (`_nebenstelle()`).
   Ausgerollt auf CT 220 (Sicherungen `*.vor-anrufliste`, auch die SQLite-Datei), getestet ueber 2002.
2. Nummernplan: `personen_nummern` erzeugen und prüfen (Stefan sieht die Liste, bevor sie gilt),
   4000er für Immosense, Dialplan für 3/4.
3. Rosenweg Telefon: Verlauf/Voicemail/Einstellungen aus der Anlage (zunächst über die
   heutige SIP-Anbindung der Geräte-App).
4. SIP-Kern in Rosenweg Telefon, Einrichtung durch die Geräte-App bzw. per QR-Code.
5. Geräte-App ohne eigenes SIP. Umstellung auf dem A15, Test nur mit internen Anrufen,
   **nie mit Notrufen**.
6. „Mein Profil“ im Web.
