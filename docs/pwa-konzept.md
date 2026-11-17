# Konzept: 3 spezialisierte PWAs

Konzept vom 2026-06-23 (Ist-Stand vom 17.11.2026 direkt unten). Entscheidungen: Reparatur → **Reklamationen-System**, Arbeitserfassung → **Auslagen/Stundensatz**, erst **alle 3 durchplanen**, dann gebündelt bauen.

## Ist-Stand (17.11.2026)

Das Konzept unten ist umgesetzt und erweitert. Die PWAs liegen im Repository unter
`pwa/` und werden auf **`pwa.rosenweg4303.ch`** ausgeliefert (Frontend-LXC `fe-pwa`,
CT 130, 100.64.2.54; nginx-Konfiguration `frontends-lxc/nginx/pwa.conf`, Ausrollen mit
`frontends-lxc/deploy.sh`). Die Startseite `/` ist ein Launcher. Kurzadressen auf der
Hauptseite: `/reparatur`, `/defekt-melden` → `pwa.rosenweg4303.ch/reparatur/`,
`/pwa` → Launcher.

| App | Pfad | Zweck |
|---|---|---|
| Reparatur melden | `/reparatur/` | Schaden melden, „Meine Meldungen“ mit Verlauf; auch **ohne Konto** per E-Mail-Code; QR-Melde-Orte mit `?ort=<code>` |
| Arbeitserfassung | `/arbeit/` | Stoppuhr/Manuell, Quittung mit KI-Scan → Auslage (siehe [aufwand-erfassung-konzept.md](aufwand-erfassung-konzept.md)) |
| Technik-Cockpit | `/technik/` | Triage der Reklamationen, Push-Ziel bei neuen Meldungen und Zuweisungen |
| Meine Daten | `/daten/` | eigene Daten, MQTT-Zugang und App-Passwörter |
| Terminumfragen | `/doodle/` | Sitzungs-Doodle |
| Mein Zähler, Solaranlage, Wetter | `/zaehler/`, `/solar/`, `/wetter/` | Anzeigen |
| MQTT-Browser | `/mqtt/` | Topics ansehen |
| Zutritt | `/zutritt/` | Türöffnung (höchstens 10 Öffnungen in 10 Minuten, jede protokolliert) |

Entschiedene Detailfragen aus „Offene Detailfragen“ unten:

- **Reparatur ohne Login:** ja. Die Person gibt ihre E-Mail ein; ist sie im
  Verzeichnis bekannt, kommt ein **8-stelliger Code**, 10 Minuten gültig, höchstens 5
  Fehlversuche, danach verbraucht. Die Antwort auf die Code-Anforderung ist immer
  gleich, auch bei unbekannter Adresse. Grenzen: 20 Anforderungen je IP (IPv6 je
  /64) in 10 Minuten, 3 Codes in 10 Minuten und 12 pro Tag je Adresse. Bei „Zu viele
  Fehlversuche“ oder abgelaufenem Code zeigt die App den Knopf **„Neuen Code
  anfordern“**, ohne das Formular zu verlieren. Angemeldet: höchstens 5 Meldungen in
  10 Minuten je Person. Hintergrund: Angriff vom 17.11.2026, siehe
  [sicherheit.md](sicherheit.md), Abschnitte 1.2 und 4.2.
- **Foto:** optional; nur JPEG, PNG, WebP, HEIC (am Inhalt erkannt, sonst verworfen).
- **Kategorien:** aufzug, heizung, wasser, tuer, reinigung, licht, strom, netzwerk,
  salz, sonstige.
- **Arbeit:** Zeit und Material/Quittung im selben Eintrag; Genehmigung durch den
  Ausschuss wie bei Auslagen, nie durch die einreichende Person selbst.

Offline-Warteschlange (Reparatur, Arbeit): Einträge werden mit dem Besitzer
gespeichert; gesendet werden nur eigene Einträge, und nur wenn jemand angemeldet ist.
Bei 401 (Sitzung abgelaufen) und 5xx bleibt der Eintrag liegen; nur andere 4xx-Fehler
verwerfen ihn. Abmelden löscht die Warteschlange nicht mehr (die Anmeldung meldet bei
abgelaufenem Token auch selbst ab); fremde Einträge werden nach dem Login verworfen.
Service Worker löschen beim Aktualisieren nur ihre eigenen Cache-Präfixe
(`rosenweg-<app>-…`), weil sich alle Apps den Cache-Speicher der Origin teilen; der
Launcher-Service-Worker gilt nur für `/` und seine eigenen Dateien. Antworten der API
werden nicht zwischengespeichert.

## 0. Gemeinsame PWA-Shell (einmal bauen, 3× nutzen)
- **Installierbar:** je App ein `manifest.webmanifest` (eigener `name`, `short_name`, `start_url`, `scope`, `display:standalone`, `theme_color`, Icons 192/512 aus Logo). 3 getrennte Scopes → 3 getrennte Home-Screen-Icons.
- **Service Worker** (`/pwa/sw.js`, einer mit scope-Param): App-Shell + statische Assets cachen (cache-first), API **network-first** mit Offline-Fallback. Versionierter Cache-Bust.
- **Offline-Queue** (wichtig — Keller/Tiefgarage ohne Signal): Einreichungen (inkl. Fotos als Blob) in **IndexedDB** puffern → bei Reconnect via Background-Sync/Retry senden. UI zeigt „wird gesendet/ausstehend".
- **Auth:** `authentik-auth.js` (Login erforderlich). Token-Refresh beachten bei reaktivierter App.
- **UI:** mobile-first Tailwind, grosse Touch-Targets, Kamera-Input (`<input capture>`), je App **eine klare Aufgabe** (kein überladenes Menü).
- **Hosting:** ursprünglich geplant unter `/pwa/<app>/` über das www-Frontend; umgesetzt als eigene Subdomain `pwa.rosenweg4303.ch` (CT 130), siehe Ist-Stand. Eigene `<base>`/`__NAV_*`-Behandlung (PWAs ohne die grosse Nav).

## 1. Reparatur-Melder  *(alle Bewohner)*
**Zweck:** niederschwellig einen Schaden/Reparaturbedarf melden — auch von Gästen/wenig-technischen Bewohnern.

**Flow:** Login → Formular: Kategorie (aufzug/heizung/wasser/tür/reinigung/sonstige — wie `reklamationen.kategorie`), Beschreibung, **Foto** (Kamera), Standort/Objekt (vorbelegt aus Wohnung/STWEG des Users) → Absenden → Bestätigung. „Meine Meldungen" mit Status-Verfolgung (offen/weitergeleitet/erledigt).

**Andocken:** erzeugt einen **`reklamationen`**-Eintrag: `eingang_kanal='web'`, `status='offen'`, `person_id` aus Login, `stweg` aus User, Foto → DOCS-Volume (`bild_pfad`).
**Umgesetzt:** `POST /api/reklamationen` (Web-Kanal, Foto als Base64, nur eigene Person; 5 Meldungen / 10 Min), dazu ohne Konto `POST /api/reklamationen/code` und `POST /api/reklamationen/oeffentlich`. Plus `GET /api/reklamationen/meine` (eigene Meldungen, ohne die Technik-`reklamationen`-Permission).
**Berechtigung:** jeder eingeloggte Bewohner darf **eigene** melden + sehen. Triage (PUT, Handwerker zuweisen) bleibt Technik (bestehende Permission) → im Technik-Cockpit.

## 2. Arbeits-/Zeiterfassung  *(Allgemeinheit, vergütet)*
**Zweck:** für die Gemeinschaft geleistete Arbeit + Zeit erfassen → vergütet über den Stundensatz.

**Zwei Erfassungs-Modi:**
- **Live-Timer (Stoppuhr):** „▶ Start" bei Arbeitsbeginn → „⏸ Pause"/„⏹ Stop". Die Zeit wird aus einem **gespeicherten Start-Zeitstempel** berechnet (Anzeige = jetzt − Start + akkumulierte Segmente), **nicht** über einen JS-Interval — so läuft sie korrekt weiter trotz App-Hintergrund, Bildschirmsperre oder App-Neustart. Laufender Timer in IndexedDB → beim Wieder-Öffnen zeigt die App „läuft seit …". Stop → Stunden = Summe der Segmente, in die Maske vorausgefüllt. Mehrere Tätigkeiten parallel sind nicht nötig (1 laufender Timer; Wechsel = stoppen + neu).
- **Manuell:** Stunden direkt eintragen (für nachträgliche/vergessene Erfassung). Rundung konfigurierbar (z.B. auf die Minute; Anzeige `h:mm`, gespeichert als Dezimalstunden).

**Flow:** Login → Timer ODER manuell → Datum, STWEG/Objekt, Tätigkeit/Beschreibung, **Stunden** (aus Timer oder manuell) → Stundensatz wird geladen (`auslagen_stundensatz` für STWEG bzw. übergreifend) → Live-Vorschau Betrag (Std × Satz) → Absenden. „Meine Arbeitseinträge" mit Status (eingereicht/genehmigt/ausbezahlt).

**Andocken:** erzeugt eine **`auslagen`**-Auslage mit einer **`auslagen_positionen`-Zeile `position_typ='arbeitszeit'`** (menge=Stunden, einheit='h', einzelpreis_chf=Satz, gesamt_chf=Std×Satz; `auslagen.betrag_chf`=Summe, `kategorie='arbeitszeit'`). IBAN aus User-Profil. Reuse **`POST /api/auslagen`** + bestehender Genehmigungs-Flow (Ausschuss → genehmigt → ausbezahlt) + die Auslagen-Mails (jetzt Templates!).
**Berechtigung:** `auslagen`-Permission (wer Auslagen einreichen darf).

## 3. Technik-Cockpit  *(Technik, mobil)*
**Zweck:** die wichtigsten Technik-Aufgaben vom Smartphone — ohne die grossen Desktop-Seiten.

**Inhalt (Vorschlag, im Bau zu verfeinern):**
- **Reparatur-/Reklamations-Triage:** offene Meldungen (Liste + Foto), Status setzen, **Handwerker zuweisen** (`handwerker`-Stamm), Notiz. (nutzt PUT `/api/reklamationen/:id`)
- **Technik-Alert-Feed:** die Auto-Alerts (ISP/Infra, die sonst nur per WhatsApp kommen) als Verlauf + „gesehen/erledigt".
- **Infra-Status-Snapshot:** Energie/Solar live, Schlüssel-Services up/down, MQTT-Schnellblick.
- **Schnell-Genehmigung:** offene Arbeits-/Auslagen-Einträge (falls Technik mitgenehmigt) — sonst weglassen.
- **Deep-Links:** zu Proxmox / Zählerverwaltung / MQTT für tiefe Tasks.
**Berechtigung:** Technik-Gruppe.

## Bau-Reihenfolge (nach Konzept-Freigabe)
1. **PWA-Shell** (manifest/sw/icons/offline-queue) + `POST /api/reklamationen` + `POST`-Pfad für Arbeitszeit-Auslage prüfen.
2. **Reparatur-Melder** (am eigenständigsten, höchster Breitennutzen).
3. **Arbeits-/Zeiterfassung**.
4. **Technik-Cockpit** (iterativ).

## Offene Detailfragen
- **Reparatur:** Foto Pflicht oder optional? Auch ohne Login (öffentlicher QR-Code im Treppenhaus) — oder immer Login?
- **Arbeit:** nur Arbeitszeit, oder auch Material (= dann faktisch die volle Auslagen-Maske)? Wer genehmigt (Ausschuss wie bei Auslagen)?
- **Technik-Cockpit:** welche Alert-Quellen + welche Status-Kacheln genau?
- **Icons/Branding:** eigenes Icon je PWA oder einheitliches Rosenweg-Logo?
