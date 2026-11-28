# Plan: Alle Portal-Funktionen als Flutter-Apps

Stand 27.11.2026 (ergänzt: eigene Logos je App, gebündelte Web-Seiten bleiben) · Grundlage: `Rosenweg/Website` origin/main (dd604cc), GitHub-Org Rosenweg · nur Plan, nichts geändert

Feste Entscheide (hier nicht neu diskutiert): eine App je Portal-Funktion mit eigenem Repo, **eigenes Logo je App** im Stil A2 (Turm + Rose, Weg wo lesbar, Zeichen je Fachgebiet), gebündelte Web-Seiten bleiben bestehen, auch Admin wird Flutter, immer Linux/macOS/Windows/Android/iOS, alles Gemeinsame in `rosenweg_basis`, Updater (aus nur auf Stationen und mit Rosenweg Gerät), Download auf /apps, Auto-Release bei Merge auf main, Karten-App ersetzt die Java-App.

---

## 0. Ausgangslage in Kürze

**Web-Portal (origin/main):** 110 HTML-Seiten, davon rund 75 echte Funktionen (Rest: Info-Seiten, STWEG-Kopien, Anzeigen). Sie liegen flach im Repo-Wurzelordner (`*.html`), dazu `pwa/<name>/` (pwa.rosenweg4303.ch), `stweg1…7/`, `meg/`, `pbx/web/` (pbx.rosenweg4303.ch), `whatsapp-bot/public/`, ISP-Seiten (isp.rosenweg4303.ch). Navigation: `js/nav.js` (Mega-Menü mit `perm`/`permAny`, Zielgruppen-Leiste admin/ausschuss). API: `api/server.js` (30 725 Zeilen, ~530 Routen, ~425 mit `authMiddleware`) plus `api/routes/*.js` (14 Router). Grösste Bereiche: `isp` (83 Routen), `access` (43), `mqtt` (26), `pbx` (22), `wasch` (20), `vollmachten` (19), `me` (19).

**Flutter-Bestand (GitHub Rosenweg):**

| Repo | Stand | Bemerkung |
|---|---|---|
| `rosenweg-basis` | 0.3.0 in `pubspec`, README nennt 0.1.0 veröffentlicht; offene PRs #11 (0.5.0 Updater, aus auf Stationen) und #12 (iOS MainActor); Zweig `desktop-geruest-auf-v0.2.0` | hat: Anmeldung (Konto/PKCE, Karte NFC + PC/SC, QR, Kerberos/GSS-API/SSPI, stille Anmeldung, Geräteschlüssel), API-Client mit Fehlertypen, Haus-Erkennung, geteilte Telefone (Anfragen über Rosenweg Gerät), Farben, Bausteine, Gerüst, Logo-Baukasten. **Fehlt noch:** Updater (erst PR), Listen/Formulare/Upload/PDF/Diagramme/Push, Release-Vorlage |
| `rosenweg-salz` | v1.0.1 veröffentlicht, CI Android/Linux/macOS/Windows; PRs #16 (Updater), #14 (Desktop-Layout) offen | Vorbild für „Fachgebiet mit Rollen in einer App“; Kamera-Scan nur auf Telefonen, Desktop: Tippen/USB-Scanner |
| `rosenweg-profil` | keine CI und kein Release auf main; PRs #1 (alle Plattformen, CI) und #3 (Updater) offen | README noch „Haupt-API muss rosenweg-apps-Tokens annehmen (in Arbeit)“ – ist inzwischen erledigt (siehe 4.1) |
| `rosenweg-vm` | v1.0.1, CI inkl. **iOS** (einzige); PRs #27 (Anmeldeschirm wie Salz/Profil, Karten-Tokens, Updater), #26 (Desktop-Gerüst) | hat noch eigene Kopien von `anmeldung/`, `netz/` – sollen mit #27 auf die Basis |
| `rosenweg-karten` | Java/Android, nur Android | wird Flutter-Neubau (Welle 1) |
| `rosenweg-tv-kiosk` | Kotlin, Google TV | bleibt nativ (Startseiten-App, kein Portal-Bestandteil) |
| Fossify-Forks (`*-rosenweg`, 16 Repos) | Kotlin, Android | nicht Teil dieses Plans; Überschneidungen unten vermerkt (Telefon, Kontakte, Dokumente, Messenger) |

**/apps-Seite:** liest `https://pbx.rosenweg4303.ch/api/apps/index.json`; Flutter-Apps stehen fest in `APPS_REGISTER` in `pbx/api/app.py` (vm, salz, kiosk, profil). Releases kommen per CI (`POST /api/apps/release`, GitHub-OIDC, Action `Rosenweg/Website/.github/actions/apps-release`). Bei ~40 Apps muss dieses Register aus dem Code heraus (siehe 4.7).

---

## 1. Bestandsliste aller Web-Funktionen → geplante App

Spalte **Web-Seite** (Entscheid Stefan 27.11.2026): **wird abgelöst** = die Seite entspricht 1:1 einer App und durchläuft Abschnitt 6; **bleibt (gebündelt)** = mehrere Web-Seiten gehen in eine App, die Web-Seiten bleiben trotzdem bestehen.

Legende Besonderheiten: **Kam** Kamera/Foto · **QR** QR scannen · **QR+** QR/Schild erzeugen · **NFC** · **Up** Datei-Upload · **PDF** PDF anzeigen/erzeugen · **Dia** Diagramme · **RT** Echtzeit (MQTT/Polling) · **Tel** PBX · **Druck** · **Off** Offline-Bedarf · **Pub** auch ohne Anmeldung nutzbar.
Grösse = Umfang der Web-Seite (Zeilen) als Anhaltspunkt.

### 1a. Bewohner, Eigentümer (alle Angemeldeten)

| Web-Seite(n) | Zweck | Rolle | API | Besonderheiten | Grösse | → App (Repo) | Web-Seite |
|---|---|---|---|---|---|---|---|
| `profil.html`, `pwa/daten/` | eigene Angaben, Telefone, E-Mails, Passwort, Tokens, Passkeys, MQTT-App-Passwörter, Mutation melden | alle | `/api/auth/me`, `/auth/profile`, `/auth/avatar`, `/me/*`, `/change-password`, `/me/tokens`, `/me/passkeys`, `/mqtt/my-app-passwords`, `/apps/sitzungen` | Up (Avatar); heikle Aktionen | 1588 + 821 | **Rosenweg Profil** (`rosenweg-profil`, besteht) – Passkeys/MQTT-Passwörter/App-Sitzungen aus `pwa/daten` und `meine-geraete.js` nachziehen | bleibt (gebündelt) |
| `pwa/reparatur/` | Schaden melden (Foto), eigene Meldungen, Melde-Ort per QR | alle, **Pub** per Melde-Ort-Code | `/api/reklamationen`, `/reklamationen/meine`, `/oeffentlich`, `/code`, `/melde-ort/:code`, `/push/*` | Kam, QR, Up, Push | 1308 | **Rosenweg Reparatur** (`rosenweg-reparatur`) | bleibt (gebündelt) |
| `stweg1…7/pages/reklamationen.html`, `meg/pages/reklamationen.html` | Übersicht der Meldungen je STWEG | Bewohner der STWEG | `/api/reklamationen/uebersicht` | – | 7×219 (Kopien) | → Rosenweg Reparatur (Ansicht „Meine STWEG“) | bleibt (gebündelt) |
| `reklamationen.html` | Meldungen bearbeiten, zuweisen, Handwerker | Technik, `reklamationen` | `/api/reklamationen`, `/auto-assign`, `/technik/mitglieder`, `/handwerker` | Push an Zugewiesene | 416 | → Rosenweg Reparatur (Bereich „Bearbeiten“) | bleibt (gebündelt) |
| `waschkueche.html`, `stweg3/pages/waschkueche-reservierung.html` | Waschküche reservieren | Bewohner mit Waschküche | `/api/wasch/rooms`, `/reservations`, `/my` | Kalender-Raster, Erinnerung | 876 + 839 | **Rosenweg Waschküche** (`rosenweg-waschkueche`) | bleibt (gebündelt) |
| `stweg3/pages/waschkueche-admin.html`, `…-management-info.html` | Räume, Regeln, Sperrzeiten | Ausschuss STWEG 3 | `/api/wasch/admin`, `/settings` | – | 619 + 297 | → Rosenweg Waschküche (Bereich „Verwalten“) | bleibt (gebündelt) |
| `pwa/zutritt/` | Türen öffnen, meine Karten, meine Kennzeichen | Bewohner | `/api/access/*` | RT (Türstatus), Off nein (Tür muss online sein) | 207 | **Rosenweg Zutritt** (`rosenweg-zutritt`) | bleibt (gebündelt) |
| `access.html` | Türen, Zutritts-Log, Access-Benutzer | Technik | `/api/access/*` (43 Routen) | Log lang → Pagination | 622 | → Rosenweg Zutritt (Bereich „Technik“) | bleibt (gebündelt) |
| *(Java-App)* `rosenweg-karten` | NFC-Karte lesen, zuordnen, entziehen, löschen | Technik/Präsident | PBX-API `/api/pbx/karte…` | **NFC** (Handy), PC/SC (Station) | – | **Rosenweg Karten** (`rosenweg-karten`, Flutter-Neubau im selben Repo) | Java-App wird abgelöst |
| `telefonbuch.html` | Siedlungs-Telefonbuch | alle | `/api/telefonbuch` | Tel (Anrufen), Off (Cache sinnvoll) | 197 | **Rosenweg Telefonbuch** (`rosenweg-telefonbuch`) | **wird abgelöst** |
| `mein-telefon.html`, `pbx/web/telefon.html`, Teil „eigenes Handy“ von `smartphones.html` | persönliche Nummer, Geräte, Erreichbarkeit, Gruppen, Telefon an-/abmelden, App-QR fürs eigene Handy, private SIP-Zugänge | alle mit Nummer | `/api/telefon/ich`, `/telefon/ich/erreichbarkeit`, `/telefon/meine`, `/telefon/ausweis`, `/telefon/privat`, `/pbx/sip-privat`, `/apps/qr-ausweis`, `/messenger/zugaenge` | QR+ (Anmelde-QR), Tel | 272 + 195 + Teil 475 | **Rosenweg Mein Telefon** (`rosenweg-mein-telefon`) – Abgrenzung: *Rosenweg Telefon* (Fossify) telefoniert, diese App stellt ein | bleibt (gebündelt) |
| `energie-monitor.html`, `pwa/zaehler/`, `pwa/solar/`, `stweg3/pages/solaranlage-live.html`, `zaehler.html` (Info) | Verbrauch, Tarife, Verlauf, Solar live | Personen mit Zähler, `energie-monitor` | `/api/energy/*`, `/energy/live`, `/energy/solar-live`, `/energie/meine-zaehler` | **Dia**, RT | 1416 + 531 + 351 + 252 | **Rosenweg Energie** (`rosenweg-energie`) | bleibt (gebündelt) |
| `energie-config.html`, `stweg3/pages/zaehler-technik.html` | Zählerverwaltung, Zuordnung | Technik, `energie-config` | `/api/energie-admin`, `/zaehler-technik`, `/admin/users` | – | 704 + 221 | → Rosenweg Energie (Bereich „Zähler verwalten“) | bleibt (gebündelt) |
| `stweg3/pages/zev-meine-rechnungen.html` | eigene ZEV-Stromrechnungen | Bewohner R9 | `/api/zev/meine-rechnungen`, `/zev/rechnung` | **PDF** | 293 | **Rosenweg ZEV** (`rosenweg-zev`) | bleibt (gebündelt) |
| `stweg3/pages/zev-smartme.html` | Abrechnung, smart-me-Abgleich, Zuordnung | ZEV-Verantwortliche | `/api/zev/config`, `/sync`, `/unzugeordnet`, `/wohnungen` | PDF | 303 | → Rosenweg ZEV (Bereich „Abrechnen“) | bleibt (gebündelt) |
| `wetter.html`, `pwa/wetter/` | Wetterstation R9 live + Verlauf | alle (**Pub**-fähig) | `/api/wetter/r9`, `/wetter/:station/history` | **Dia**, RT (MQTT) | 608 + 618 | **Rosenweg Wetter** (`rosenweg-wetter`) | bleibt (gebündelt) |
| `vollmachten.html` | Vollmacht erstellen, unterschreiben, hochladen, nachschlagen | Eigentümer, Ausschuss, Verwaltung | `/api/vollmachten/*` (19), `/vollmachten/:id/upload-signed` | **PDF** (erzeugen + Ansicht), Up (unterschriebenes PDF), Kam (Scan) | 953 | **Rosenweg Vollmachten** (`rosenweg-vollmachten`) | **wird abgelöst** |
| `sitzungs-doodle.html`, `pwa/doodle/` | Terminumfragen anlegen/abstimmen | Angemeldete; **Pub** per Code | `/api/doodle/*` | – | 555 + 564 | **Rosenweg Termine** (`rosenweg-termine`) | bleibt (gebündelt) |
| `projekte.html` | Projekte, Dokumente, Abstimmungen | Eigentümer | `/api/projects` (15), `/documents`, `/doodle/*`; **Pub** `/api/public/project/:slug` | Up, PDF | 699 | **Rosenweg Projekte** (`rosenweg-projekte`) | **wird abgelöst** |
| `index.html#dokumente`, `/api/documents` (Repo `documents`) | Ablage: Ordner, Dateien, Vorschau | je nach Recht | `/api/documents`, `/documents/:path`, `/documents-preview`, `/folder`, `/move` | Up (raw bis 500 MB), PDF, Office-Vorschau | Teil | **Rosenweg Unterlagen** (`rosenweg-unterlagen`) – Name bewusst ≠ *Rosenweg Dokumente* (Fossify-Leser) | **wird abgelöst** (nur der Abschnitt Dokumente; `index.html` bleibt Web) |
| `stweg1…7/index.html`, `meg/index.html`, `meg/pages/einstellplaetze.html` | Seite der eigenen Gemeinschaft: Kontakte, Module, Kalender, Termine, Einstellplätze | Bewohner/Eigentümer der STWEG/MEG | `/api/stweg/*`, `/stweg-content`, `/stweg-sections`, `/stweg-modules`, `/calendar`, `/verteiler/by-stweg`, `/meg/einstellplaetze` | Druck (Listen) | 7×~115, STWEG 3: 1152 | **Rosenweg STWEG** (`rosenweg-stweg`) | bleibt (gebündelt) |
| `stweg-module.html`, `stweg-seite-editor.html` | Module und Inhalt der STWEG-Seite pflegen | Ausschuss | `/api/stweg-modules`, `/stweg-sections` | Textbearbeitung (Markdown/Rich) | 282 + 421 | → Rosenweg STWEG (Bereich „Seite bearbeiten“) | bleibt (gebündelt) |
| `isp.html`, `isp-mein-zugang.html`, `wlan.html` | Internet-Zugang, VPN, Mailbox, Weiterleitungen, Reverse-Proxy, DNS, WLAN-Zugang | ISP-Kunden (Bewohner) | `/api/isp/subscribers`, `/vpn-accounts`, `/mailbox-requests`, `/redirects`, `/reverse-proxy`, `/dns-info`, `/vlan-requests`, `/wifi`, `/isp/status-summary` | QR+ (WLAN-QR, WireGuard-QR) | 560 + 1207 + 215 | **Rosenweg Internet** (`rosenweg-internet`) | bleibt (gebündelt) |
| `tv.html` | TV7-Sender schauen, Playlist für externe Player | ISP-Kunden | `/api/tv/channels`, `/stream-url`, `/stream`, `/playlist`, `/extern` | **Video** (HLS/UDP-Proxy), QR+ | 519 | **Rosenweg TV** (`rosenweg-tv`) | **wird abgelöst** |
| `steuerung.html`, `stweg3/pages/alarmpanel.html`, `iobroker/heizung-operator.html` | Haustechnik: Live-Ansichten (ioBroker/HA eingebettet), Alarme, Heizraum | `r9`, `stweg3`, Technik | `/api/alarmpanel/*`, MQTT; Steuerung = iframes fremder Oberflächen | RT, **WebView** | 152 + 282 + 234 | **Rosenweg Anlagen** (`rosenweg-anlagen`) | bleibt (gebündelt) |
| `salz.html` | Salzvorrat | Bewohner R2/R4/R9, Kooperation, Technik | `/api/salz` | Barcode | 264 | **Rosenweg Salz** (besteht) | **wird abgelöst** |
| *(Proxmox/VM-Nutzung)* | eigene VMs öffnen | Personen mit VM | `/api/app-tunnel`, vm-gateway | SPICE, WireGuard | – | **Rosenweg Virtuelle Computer** (besteht) | – (keine Web-Seite) |

### 1b. Verwaltung, Ausschuss, Präsident

| Web-Seite(n) | Zweck | Rolle | API | Besonderheiten | Grösse | → App (Repo) | Web-Seite |
|---|---|---|---|---|---|---|---|
| `auslagen.html`, `pwa/arbeit/`, `auslagen-stundensatz.html` | Auslagen/Vorschüsse, Arbeitszeit erfassen, Beleg scannen (OCR), Stundensätze | `auslagen`, Hauswarte, Technik | `/api/auslagen` (12), `/auslagen/scan-beleg`, `/auslagen-stundensatz`, `/projects-mini` | **Kam** (Beleg), Up, PDF, Off (Zeiterfassung unterwegs) | 918 + 1328 + 144 | **Rosenweg Auslagen** (`rosenweg-auslagen`) | bleibt (gebündelt) |
| `handwerker.html` | Handwerker & Lieferanten, Einsätze, Notfallnummern, Verträge | `handwerker` | `/api/handwerker`, `/handwerker-events`, `/handwerker-notfall`, `/handwerker-verträge/anstehend` | Tel (Notfall anrufen), Off (Notfallliste!) | 1430 | **Rosenweg Handwerker** (`rosenweg-handwerker`) | **wird abgelöst** |
| `brief-tracking.html` | eingehende/ausgehende Briefe erfassen, Scan ablegen | Ausschuss, Technik, Präsident | `/api/briefe`, `/briefe/upload`, `/documents` | Up, **PDF**, Kam (Scan) | 192 | **Rosenweg Briefe** (`rosenweg-briefe`) | **wird abgelöst** |
| `objektverwaltung.html` | Wohnungen, Eigentümer, Wertquoten, Unterschriftenlisten | `objektverwaltung`, Ausschuss | `/api/wohnungen` (11), `/unterschriftenliste` (7), `/admin/users`, `/SearchServer` (Adresssuche) | **PDF** (Unterschriftenliste mit Hash) | 2093 | **Rosenweg Objekte** (`rosenweg-objekte`) | bleibt (gebündelt) |
| `grundbuch.html` | Grundbuchauszug hochladen, OCR, Anteile | Eigentümer | `/api/grundbuch/*` | Up, **PDF**, OCR | 420 | → Rosenweg Objekte (Bereich „Grundbuch“) | bleibt (gebündelt) |
| `verwaltung-admin.html` | Hausverwaltungen und Kontakte je STWEG | `verwaltung-admin` | `/api/verwaltungen/*` | PDF | 381 | → Rosenweg Objekte (Bereich „Hausverwaltungen“) | bleibt (gebündelt) |
| `personen.html` | Personen-Stammdaten, Dubletten zusammenführen | `wohnungsverwaltung` | `/api/personen`, `/personen-dedup/kandidaten`, `/personen/merge` | – | 432 | **Rosenweg Personen** (`rosenweg-personen`) | bleibt (gebündelt) |
| `loeschungen.html` | Konto-Löschungen genehmigen | `loeschungen` | `/api/admin/pending-deletions`, `/admin/mail-chain` | heikel | 185 | → Rosenweg Personen (Bereich „Löschungen“) | bleibt (gebündelt) |
| `email-verteiler.html`, `mail-compose.html`, `mail-templates.html`, `mail-empfaenger-admin.html` | Rundmail an Gruppen/STWEG, Ad-hoc-Mail, Vorlagen, Empfänger | `email-verteiler`, `mail-compose`, Technik/Präsident | `/api/verteiler` (12), `/mail-compose`, `/mail-templates`, `/mail-empfänger`, `/email/quota` | Up (Anhänge), Vorschau (HTML) | 980 + 204 + 270 + 333 | **Rosenweg Rundmail** (`rosenweg-rundmail`) | bleibt (gebündelt) |
| `verwaltung-mail-outbox.html`, `mail-approval-config.html`, `email-log.html` | Mails der Verwaltung freigeben, Freigabe-Regeln, Versandprotokoll | Technik, Präsident | `/api/verwaltung-mail-queue` (7), `/mail-approval-config`, `/email-log`, `/admin/mail-chain` | **PDF** (Anhänge), Push (neue Mail wartet – heute Badge) | 393 + 202 + 204 | **Rosenweg Mail-Freigabe** (`rosenweg-mail-freigabe`) | bleibt (gebündelt) |
| `email-archiv.html` | Mail-Archiv durchsuchen, Löschanträge | `email-archiv` | `/api/email-archive/*` | **PDF**, Suche, Pagination | 592 | **Rosenweg Mail-Archiv** (`rosenweg-mail-archiv`) | **wird abgelöst** |
| `melde-orte.html`, `tuerschilder.html`, Vorlagen `api/vorlagen/aushaenge/*` | QR-Schilder für Melde-Orte und Räume, Aushänge drucken | `reklamationen` | `/api/reklamation-orte`, `/raum-qr/*` (`/druck`, `/inhalt`, `/orte`) | **QR+**, **Druck** | 353 + 166 | **Rosenweg Aushänge** (`rosenweg-aushaenge`) | bleibt (gebündelt) |
| Ankündigungen in `stationen.html` | Aushänge/PDF/Notfall auf Info-Bildschirme schicken | Technik, Ausschuss | `/api/display/ankuendigungen`, `/announce`, `/display/pdf`, `/display/state` | Up (PDF), RT (MQTT) | Teil von 2514 | **Rosenweg Anzeigen** (`rosenweg-anzeigen`) | wird abgelöst, wenn Stationen **und** Anzeigen fertig sind (eine Seite, zwei Apps) |
| `rechteverwaltung.html` | Seitenrechte je Gruppe | `rechteverwaltung` | `/api/permissions`, `/permissions/pages`, `/admin/groups` | Matrix-Tabelle | 289 | **Rosenweg Rechte** (`rosenweg-rechte`) | **wird abgelöst** |

### 1c. Technik / Infrastruktur

| Web-Seite(n) | Zweck | Rolle | API | Besonderheiten | Grösse | → App (Repo) | Web-Seite |
|---|---|---|---|---|---|---|---|
| `stationen.html` (ohne Ankündigungen) | Stationen/PCs: Status, Rollen, Apps, OS, WLAN, Agent v2 | Technik, Präsident | `/api/stations/admin`, `/stations/v2` | RT, Up | 2514 | **Rosenweg Stationen** (`rosenweg-stationen`) | wird abgelöst, wenn Stationen **und** Anzeigen fertig sind (eine Seite, zwei Apps) |
| `sicherungen.html` | PBS-Sicherungen, PC-Abbilder | Technik | `/api/sicherungen` | – | 413 | **Rosenweg Sicherungen** (`rosenweg-sicherungen`) | **wird abgelöst** |
| `ssh-zugriffsmatrix.html` | SSH-Zugriffsmatrix | Technik | `/api/ssh/hosts`, `/ssh/matrix` | Matrix | 253 | **Rosenweg SSH** (`rosenweg-ssh`) | **wird abgelöst** |
| `proxmox-verwaltung.html` | Proxmox-Benutzer, ACL, Rollen | `proxmox-verwaltung` | `/api/proxmox/*` (7) | – | 336 | **Rosenweg Proxmox** (`rosenweg-proxmox`) | **wird abgelöst** |
| `noc-fullscreen.html` (+ `js/noc-cockpit.js`) | NOC-Wandbildschirm | Technik; Daten teils **Pub** | `/api/isp/noc/public/*`, `/isp/status-summary` | RT, Kiosk-Vollbild | 42 + JS | **Rosenweg NOC** (`rosenweg-noc`) | **wird abgelöst** |
| `mqtt.html`, `pwa/mqtt/` | MQTT-Topic-Browser, Regeln, Dienstkonten, App-Passwörter Dritter | `mqtt`, Technik | `/api/mqtt/*` (26), MQTT direkt | **RT** (MQTT/WebSocket) | 1190 + 895 | **Rosenweg MQTT** (`rosenweg-mqtt`) | bleibt (gebündelt) |
| `isp-admin.html`, `netzwerk.html`, `verbindungen.html`, `dmarc.html` | ISP-Betrieb: Kunden, VLAN, feste IPs, Mail-Relays, Wartung; Netzwerkgeräte; Verbindungsnachweis (FPÜV); DMARC | `isp`, Technik | `/api/isp/*` (Rest der 83), `/connections`, `/unifi/devices`, `/dmarc/reports` | grosse Tabellen, Pagination | 2080 + 156 + 213 + 161 | **Rosenweg ISP-Verwaltung** (`rosenweg-isp-verwaltung`) | bleibt (gebündelt) |
| `pbx/web/pbx-admin.html` (pbx.rosenweg4303.ch) | Nebenstellen, Ring-Groups, Trunk, Anrufe, Testanruf | `pbx-admin` | PBX-API `/api/pbx/config`, `/sip-extensions`, `/ring-members`, `/calls`, `/trunk-status`, `/test-call`, `/telefon-sitzungen` | Tel | 448 | **Rosenweg Telefonanlage** (`rosenweg-telefonanlage`) | **wird abgelöst** |
| `smartphones.html` (Technik-Teil) | geteilte Telefone: Bestand, Wartung, App-Katalog, WLAN-PPSK, Einrichtung | Technik | `/api/pbx/smartphones`, `/pbx/telefon-apps` | Up (APK), QR+ | Teil von 475 | **Rosenweg Geteilte Telefone** (`rosenweg-geteilte-telefone`) – übernimmt später „Alle Handys“ (Handy-Zugänge sperren, `/api/pbx/sip-privat`), das bis dahin in Rosenweg Mein Telefon steht (Stefan 27.11.2026) | bleibt (gebündelt: Teil von smartphones.html, das auch in Mein Telefon steckt) |
| `whatsapp-bot/public/` (whatsapp.rosenweg4303.ch) | WhatsApp-Gateway: Status, Opt-ins, Outbox, Kopplung | Technik, Präsident | Gateway `/api/whatsapp/admin`, prüft über Haupt-API `/api/auth/me` | QR (Kopplung anzeigen), RT | 850 | **Rosenweg WhatsApp** (`rosenweg-whatsapp`) | **wird abgelöst** |
| `pwa/technik/` (Technik-Cockpit) | Sammelsicht: Reklamationen, Energie live, Handwerker, Wartung, Push | Technik | diverse | Push | 916 | **entfällt** – Teile gehen in Reparatur, Energie, Handwerker, ISP-Verwaltung; Push wird nativ (4.5) | bleibt (verteilt auf mehrere Apps) |

### 1d. Bleibt Web (Vorschlag – Stefan entscheidet)

| Web-Seite | Grund |
|---|---|
| `index.html` (Startseite), `anfahrt.html`, `entsorgung.html`, `verwaltung.html`, `energie-info.html`, `aushang-verwaltungswechsel.html`, `shelly-emulator-howto.html`, `hilfe.html` | rein öffentliche Information; Besucher, Handwerker, Interessenten haben keine App. Apps verlinken auf Hilfe-Abschnitte. |
| `apps.html` | Download-Seite – muss ohne App gehen |
| `app-anmelden.html` | Teil der Anmeldung (Handy-Code im Browser bestätigen) |
| `raum.html` | Ziel der QR-Codes an Türen – Besucher scannen mit der Kamera-App |
| `pwa/reparatur/` öffentlicher Teil (Melde-Ort-Code, anonym melden) | Besucher und Handwerker ohne Konto; Bewohner bekommen die App |
| `sitzungs-doodle`/`pwa/doodle` öffentlicher Teil (Abstimmen per Code) | externe Teilnehmende |
| `/api/public/project/:slug` (öffentliche Projektseite) | Öffentlichkeit |
| `echtheitspruefung.html` | Dritte prüfen eine Unterschriftenliste ohne Konto |
| `abholung.html` | Link aus Mail/Brief (Druckauftrag abholen per Token) |
| `display.html`, `display-lite.html`, `cast-empfaenger.html` | Info-Bildschirme: Station-Rolle `display`, Chromecast-Receiver (muss Web sein), Kiosk-TV. Später prüfen, ob die Station-Rolle eine Flutter-Anzeige bekommt – kein Nutzen jetzt. |
| `dashboard.html` | Sammelansicht – widerspricht „keine Sammel-App“; Vorschlag: entfällt, Startpunkt sind /apps und der Launcher (siehe Frage 3) |
| KI-Suche (`/api/ki-search`, im Menü) | Vorschlag: vorerst Web; später ggf. Baustein in der Basis (siehe Frage 7) |

**Ergebnis:** 4 bestehende/umzubauende Apps + **37 neue** = 41 Apps. Rund 15 öffentliche Seiten bleiben Web.

### 1e. Alle Apps mit eigenem Logo

Entscheid Stefan 27.11.2026: **jede App bekommt ihr eigenes Logo** im Stil A2 wie `rosenweg-vm` – mindestens Turm + Rose, der Weg wo er lesbar bleibt; dazu ein Zeichen je Fachgebiet, damit die Apps nebeneinander (auf /apps, im Launcher, im Startmenü der Stationen) unterscheidbar sind. Erzeugt mit dem Logo-Baukasten der Basis (`werkzeug/logo/erzeugen.sh` + `zeichen/<motiv>.svg`). Farbe je Zielgruppe als zweites Unterscheidungsmerkmal (Vorschlag: Bewohner warm, Verwaltung blau, Technik grau/grün).

| App | Repo | Welle | Aufwand | Logo-Idee (Zeichen neben Turm + Rose) | Web |
|---|---|---|---|---|---|
| Rosenweg Profil | `rosenweg-profil` | 1 | S | Person (besteht) | bleibt (gebündelt) |
| Rosenweg Salz | `rosenweg-salz` | – | – | Salzsack/Kristall (besteht) | wird abgelöst |
| Rosenweg Virtuelle Computer | `rosenweg-vm` | – | – | Bildschirm (besteht, Vorbild A2) | – |
| Rosenweg Karten | `rosenweg-karten` | 1 | M | Karte mit Funkwellen | Java-App abgelöst |
| Rosenweg Telefonbuch | `rosenweg-telefonbuch` | 1 | S | aufgeschlagenes Buch mit Hörer | wird abgelöst |
| Rosenweg Mein Telefon | `rosenweg-mein-telefon` | 1 | S–M | Hörer mit Zahnrad | bleibt (gebündelt) |
| Rosenweg Zutritt | `rosenweg-zutritt` | 1 | M | Tür mit Schlüssel | bleibt (gebündelt) |
| Rosenweg Waschküche | `rosenweg-waschkueche` | 1 | M | Waschmaschine/Trommel | bleibt (gebündelt) |
| Rosenweg Reparatur | `rosenweg-reparatur` | 1 | L | Schraubenschlüssel | bleibt (gebündelt) |
| Rosenweg Wetter | `rosenweg-wetter` | 2 | S | Sonne mit Wolke | bleibt (gebündelt) |
| Rosenweg Energie | `rosenweg-energie` | 2 | L | Blitz | bleibt (gebündelt) |
| Rosenweg ZEV | `rosenweg-zev` | 2 | M | Rechnung mit Blitz | bleibt (gebündelt) |
| Rosenweg Termine | `rosenweg-termine` | 2 | M | Kalenderblatt mit Haken | bleibt (gebündelt) |
| Rosenweg Vollmachten | `rosenweg-vollmachten` | 2 | M–L | Blatt mit Unterschrift/Füller | wird abgelöst |
| Rosenweg Unterlagen | `rosenweg-unterlagen` | 2 | M | Ordner | wird abgelöst (Abschnitt) |
| Rosenweg Projekte | `rosenweg-projekte` | 2 | M | Kran/Bauplan | wird abgelöst |
| Rosenweg STWEG | `rosenweg-stweg` | 2 | M | Hausgruppe (drei Dächer) | bleibt (gebündelt) |
| Rosenweg Internet | `rosenweg-internet` | 2 | M | Globus/WLAN-Bögen | bleibt (gebündelt) |
| Rosenweg TV | `rosenweg-tv` | 2 | M | Fernseher | wird abgelöst |
| Rosenweg Mail-Freigabe | `rosenweg-mail-freigabe` | 2 | M | Brief mit Haken | bleibt (gebündelt) |
| Rosenweg Auslagen | `rosenweg-auslagen` | 3 | L | Quittung mit Franken-Zeichen | bleibt (gebündelt) |
| Rosenweg Handwerker | `rosenweg-handwerker` | 3 | L | Hammer/Helm | wird abgelöst |
| Rosenweg Briefe | `rosenweg-briefe` | 3 | S | Briefumschlag mit Pfeil (Sendungsverfolgung) | wird abgelöst |
| Rosenweg Objekte | `rosenweg-objekte` | 3 | L | Grundriss | bleibt (gebündelt) |
| Rosenweg Personen | `rosenweg-personen` | 3 | M | zwei Personen/Karteikarte | bleibt (gebündelt) |
| Rosenweg Rundmail | `rosenweg-rundmail` | 3 | L | Brief mit mehreren Pfeilen | bleibt (gebündelt) |
| Rosenweg Mail-Archiv | `rosenweg-mail-archiv` | 3 | M | Archivkiste mit Brief | wird abgelöst |
| Rosenweg Aushänge | `rosenweg-aushaenge` | 3 | M | Schild mit QR-Code | bleibt (gebündelt) |
| Rosenweg Anzeigen | `rosenweg-anzeigen` | 3 | M | Bildschirm mit Megafon | abgelöst mit Stationen |
| Rosenweg Rechte | `rosenweg-rechte` | 3 | S | Schild/Schloss mit Häkchen | wird abgelöst |
| Rosenweg Stationen | `rosenweg-stationen` | 4 | L | **vorhandenes Logo von os-stationen** (`docs/logo.svg`), kein neues | abgelöst mit Anzeigen |
| Rosenweg Sicherungen | `rosenweg-sicherungen` | 4 | M | Tresor/Kreispfeil | wird abgelöst |
| Rosenweg SSH | `rosenweg-ssh` | 4 | S | Terminal `>_` mit Schlüssel | wird abgelöst |
| Rosenweg Proxmox | `rosenweg-proxmox` | 4 | S–M | Server-Stapel | wird abgelöst |
| Rosenweg NOC | `rosenweg-noc` | 4 | M | Radar/Pulslinie | wird abgelöst |
| Rosenweg MQTT | `rosenweg-mqtt` | 4 | M | Baum aus Knoten (Topics) | bleibt (gebündelt) |
| Rosenweg ISP-Verwaltung | `rosenweg-isp-verwaltung` | 4 | L | Antennenmast | bleibt (gebündelt) |
| Rosenweg Telefonanlage | `rosenweg-telefonanlage` | 4 | M | Telefon-Verteiler (Hörer mit Verzweigung) | wird abgelöst |
| Rosenweg Geteilte Telefone | `rosenweg-geteilte-telefone` | 4 | M | zwei Smartphones | bleibt (gebündelt) |
| Rosenweg WhatsApp | `rosenweg-whatsapp` | 4 | M | Sprechblase mit Zahnrad (kein WhatsApp-Markenzeichen) | wird abgelöst |
| Rosenweg Anlagen | `rosenweg-anlagen` | 4 | M | Thermometer/Ventil | bleibt (gebündelt) |

Die Logos erscheinen an drei Stellen, die alle aus derselben Datei gespeist werden: **/apps** (Feld `logo` im App-Register, `img/apps/<app>.png`), **Startmenü der Stationen** (`.desktop`-Datei + `hicolor`-Icons im `.deb`, gebaut von der Release-Vorlage) und App-Symbol auf Android/iOS/macOS/Windows.

---

## 2. Gruppierungsregel und Begründung

Regel: **eine App = eine fachliche Aufgabe (ein Fachgebiet)**. Bedienung und Verwaltung desselben Fachgebiets gehören in dieselbe App und erscheinen rollenabhängig (wie Salz: Bewohner buchen, Technik setzt Schwellen). Getrennt wird, wo andere Leute etwas anderes erledigen.

| Gebündelt | Warum eine Aufgabe |
|---|---|
| Reparatur = melden + meine + STWEG-Übersicht + bearbeiten | ein Vorgang von der Meldung bis zur Erledigung; 8 Web-Kopien werden eine Ansicht |
| Waschküche = reservieren + verwalten | dieselben Räume und Regeln |
| Zutritt = Türen/Karten/Kennzeichen + Access-Admin | dieselben Türen und Benutzer. **Karten bleibt eigene App** (Entscheid), obwohl fachlich nahe – siehe Frage 4 |
| Energie = Verbrauch + Solar + Monitor + Zählerverwaltung | dieselben Zähler |
| ZEV getrennt von Energie | Abrechnung (Rechnungen, Geld) ist eine andere Aufgabe und andere Leute als Messwerte anschauen |
| Objekte = Objektverwaltung + Grundbuch + Hausverwaltungen | Stammdaten der Liegenschaften |
| Personen = Personen + Dubletten + Löschungen | Stammdaten der Menschen |
| Mail: **drei Apps** (Rundmail / Mail-Freigabe / Mail-Archiv) | Schreiben (Ausschuss), Freigeben (Technik/Präsident, schnell, Push), Nachschlagen (Archiv) sind getrennte Aufgaben mit verschiedenen Rechten |
| Internet = Status + Mein Zugang + WLAN | was ein ISP-Kunde braucht; ISP-Betrieb getrennt |
| ISP-Verwaltung = Admin + Netzwerk + Verbindungen + DMARC | Betrieb des ISP |
| Telefon: Mein Telefon / Telefonanlage / Geteilte Telefone | persönlich einstellen vs. Anlage konfigurieren vs. Gerätepark warten |
| Stationen ohne Ankündigungen; **Anzeigen** eigen | Rechner verwalten ≠ Mitteilungen an Bildschirme (macht auch der Ausschuss) |
| STWEG = Seite + Editor + MEG | „meine Gemeinschaft“; Dokumente aber in Unterlagen (Querverweis) |

---

## 3. Was zuerst in `rosenweg_basis` muss

Priorität A = vor Welle 1 nötig, B = vor Welle 2/3, C = bei Bedarf.

| Baustein | Prio | Wer braucht ihn | Inhalt / Paket-Vorschlag |
|---|---|---|---|
| **Updater** (PR #11 mergen) | A | alle | aus auf Stationen und mit Rosenweg Gerät; Quelle `/api/apps/index.json` |
| **Desktop-Gerüst** (Zweig `desktop-geruest…` mergen) | A | alle | Leiste links (Station) / unten (Telefon), Fenstergrösse, Tastatur |
| **Release-Vorlage** | A | alle | wiederverwendbarer GitHub-Workflow (`workflow_call`) in `rosenweg-basis`: Bau 5 Plattformen, Signatur (Rosenweg-APK-Schlüssel), Tag aus `pubspec` bei Merge auf main, `apps-release`-Schritt. Heute kopiert jede App 4–5 Workflow-Dateien. |
| **App-Vorlage** `werkzeug/neue-app.sh` | A | alle neuen | erzeugt Repo-Gerüst: `RosenwegApp`, **eigenes Logo** (Logo-Baukasten mit Fachgebiets-Zeichen aus 1e: alle Grössen für 5 Plattformen, `img/apps/<app>.png` für /apps, Station-Icons `hicolor` + `.desktop` fürs Startmenü), Authentik-Rücksprung, Workflows, README/Anleitung, Attrappe (`RW_ATTRAPPE`) und Bildschirmfoto-Test wie in Profil |
| **Rechte** | A | alle mit Rollen | `sitzung.darf('reklamationen', 'write')` aus `GET /api/auth/me` (liefert `permissions` schon), Technik/Präsident = alles wie `requirePermission`; Widget `NurMit(recht: …)`; Hinweis „keine Berechtigung“ einheitlich |
| **Listen/Tabellen** | A | fast alle | Liste mit Suche, Filter-Chips, Sortierung, „mehr laden“ (Cursor), Ziehen zum Neuladen; Desktop: Tabelle mit Spalten, Mehrfachauswahl; leere/Fehler-Zustände |
| **Formulare** | A | fast alle | Feldtypen (Text, Zahl CHF, Datum/Zeit, Auswahl, Person suchen, Wohnung wählen), Prüfung, „ungespeicherte Änderungen“, Bestätigungsdialog für Löschen/Entziehen |
| **Kamera / QR / Barcode** | A | Reparatur, Salz, Auslagen, Briefe, Vollmachten | `mobile_scanner` (Android/iOS/macOS), Desktop: USB-Scanner als Tastatur + Eingabefeld (Muster aus Salz übernehmen); Foto mit `image_picker`/`camera`, Verkleinern vor Upload |
| **Datei-Upload / -Download** | A | Reparatur, Unterlagen, Auslagen, Briefe, Vollmachten, Grundbuch, Anzeigen | Auswahl (`file_picker`), Drag & Drop am Desktop, Fortschritt, raw-Body (wie `/api/documents`) und multipart; Download mit Bearer in Datei, „Öffnen mit“/„Teilen“ |
| **PDF-Ansicht** | A | Vollmachten, ZEV, Mail-Freigabe, Mail-Archiv, Unterlagen, Briefe, Objekte | `pdfrx` (alle 5 Plattformen) mit Bearer-Laden, Seiten, Zoom, Teilen/Drucken |
| **Drucken** | B | Aushänge, Vollmachten, STWEG/MEG-Listen | `printing`-Paket (Systemdialog auf allen Plattformen); Druckinhalt kommt als PDF von der API (siehe 4.6) |
| **Diagramme** | B | Energie, Wetter, ZEV, NOC | `fl_chart`; Zeitachse, Tag/Monat/Jahr-Umschalter, Rosenweg-Farben |
| **Echtzeit (MQTT)** | B | Wetter, Energie live, Anzeigen, Anlagen, MQTT, NOC, Zutritt | Wrapper um `mqtt_client` (WebSocket + TCP), Zugang über `POST /api/mqtt/token`, Wiederverbinden, „live/veraltet“-Anzeige |
| **Benachrichtigungen** | B | Reparatur, Mail-Freigabe, Salz, Waschküche, Handwerker | einheitliche Registrierung beim Server (4.5), lokale Benachrichtigung, Tippen → Deep-Link in die App |
| **Deep-Links zwischen Apps** | B | alle | `rosenweg://<app>/<pfad>` bzw. https-App-Links; „In App öffnen, sonst /apps, sonst Web“ – ersetzt die Querverweise des Menüs |
| **Offline-Zwischenspeicher** | B | Telefonbuch, Handwerker (Notfall), Auslagen (Zeiterfassung), STWEG-Kontakte | letzter Stand lesbar mit Zeitstempel; Schreib-Warteschlange nur bei Auslagen (Muster `/api/me/app-daten` mit Version/Konflikt wiederverwenden) |
| **Personen-/Wohnungs-Auswahl** | B | Reparatur, Karten, Objekte, Personen, Rundmail, Auslagen | Suchfeld gegen vorhandene Endpunkte (`/api/admin/users`, `/api/wohnungen`) |
| **Telefonieren** | C | Telefonbuch, Handwerker, Mein Telefon | `tel:`-Link; mit Rosenweg Telefon (Fossify) als Ziel auf Android, sonst System |
| **WebView** | C | Anlagen (ioBroker/HA) | `webview_flutter` (Android/iOS/macOS), Windows `webview_windows`; **Linux** ohne stabiles Plugin → im Browser öffnen |
| **Video** | C | TV | `media_kit` (libmpv auf allen Plattformen) – eher nur in der TV-App, nicht in der Basis |

Grundsatz für alles Neue: wird ein Baustein in einer zweiten App gebraucht, wandert er in die Basis, bevor die zweite App ihn kopiert.

---

## 4. API-Arbeiten

### 4.1 Tokens – Stand

`api/middleware/auth.js` nimmt heute fünf Ausweise an; alle ~425 Routen mit `authMiddleware` gelten damit grundsätzlich auch für Apps:

| Ausweis | Erkennung | Einschränkung |
|---|---|---|
| Website-Sitzung | `sessions`-Tabelle | – |
| **Authentik `rosenweg-apps`** (PKCE) | `istAppToken` (aud/azp im JWT) → `validateAppToken` über userinfo, 60 s Zwischenspeicher, Bremse | keine Sperrliste; nur `requireUserLogin`-Routen lassen es durch, `change-password` verlangt aber eine frische **Website**-Sitzung mit `id_token` → App bekommt `403 reauth` |
| **Karten-/QR-/Handy-Sitzung** `rw_app_…` | `karteZugangPruefen` | `PAT_GESPERRT` (Passwort, Tokens, Passkeys, `auth/*` ausser `GET auth/me`, MQTT-Zugänge) und `requireUserLogin` |
| **Anlage-Token** (geteilte Telefone) | `istAnlageToken`, gilt für genau eine Anfrage | wie PAT, plus Methode/Pfad gebunden |
| PAT `rw_pat_…` | Hash in `api_tokens` | Sperrliste + Scopes |

Nebendienste: **PBX-API** nimmt `rw_app_` und Authentik-App-Tokens an (`pbx/api/app.py`); **WhatsApp-Gateway** prüft über `/api/auth/me`, sperrt nur `rw_pat_`; MQTT über `/api/mqtt/token`; TV-Streams über eigene Token in der URL.

### 4.2 Nötige Umbauten

1. **Stufen für heikle Bereiche (wichtigste Arbeit).** Die Karte ist ein schwächerer Ausweis (kopierbare UID). Heute darf eine Karten-Sitzung einer Technik-Person *alles* ausser Ausweis-Änderungen – also auch Proxmox-ACL, SSH-Matrix, Rechte, Personen zusammenführen, Löschungen, Mail-Freigabe, Stationen. Vorschlag: Middleware `verlangtKonto` (bzw. Feld `stufe` an `req.user`: `karte` < `konto` < `konto-frisch`) und an die Admin-Routen hängen; die Admin-Apps zeigen dann „Mit Rosenweg-Konto anmelden“. Siehe Frage 1.
2. **Frische-Prüfung für App-Tokens** (`change-password`, Passkeys, MQTT-App-Passwörter, Tokens): `auth_time` aus dem Authentik-JWT prüfen statt nur Website-`id_token`; die Basis kann `403 reauth` schon (README). Damit kann Profil auch `pwa/daten` vollständig ersetzen.
3. **Rechte-Endpunkt bestätigen:** `GET /api/auth/me` liefert `permissions` bereits (inkl. Ableitung „hat Zähler → energie-monitor read“). Dokumentieren als Vertrag für die Basis; Admin-Seiten, die heute nur per `permAny`-Gruppen im Menü gefiltert sind (z. B. Stationen, SSH, NOC: `technik,praesident`), brauchen echte Seiten-Schlüssel in `permissions`, damit die App dieselbe Regel hat wie die API.
4. **Pagination/Cursor** für lange Listen: nur ~17 Stellen mit `limit/offset` heute. Nötig mindestens: `email-archive`, `email-log`, `connections` (FPÜV), `access`-Log, `reklamationen`, `auslagen`, `verwaltung-mail-queue`, `handwerker-events`, `alarmpanel/events`, `personen`. Einheitlich `?limit=&nach=<cursor>` + `naechster` in der Antwort.
5. **Fehlende Endpunkte** (Web baut heute im Browser zusammen oder druckt HTML):
   - Druck als **PDF** statt HTML-Druckseite: `/api/raum-qr/druck`, Melde-Ort-Schilder, Aushang-Vorlagen, MEG-Einstellplatzliste, STWEG-Kontaktlisten.
   - Ankündigungen (`/api/display/*`) als eigenständige Schnittstelle von `/api/stations` trennen (für Rosenweg Anzeigen).
   - Steuerung: die eingebetteten ioBroker/HA-Ansichten laufen über Browser-Cookies/Forward-Auth – für die App entweder API-Endpunkte für die wichtigsten Werte (Alarmpanel hat sie schon) oder WebView mit eigener Anmeldung. Siehe Frage 6.
   - Push-Registrierung für native Apps (4.5).
6. **Uploads:** raw-Bodies (`/api/documents`, `upload-signed`) gehen mit Dart `http` direkt; Foto-Uploads der Reparatur auf Grösse prüfen, sonst nichts.
7. **App-Register aus dem Code:** `APPS_REGISTER` in `pbx/api/app.py` als Tabelle/JSON (Name, Repo, Paket, Text, „für“, Technik-Flag, Reihenfolge) – sonst braucht jede der 37 Apps einen PBX-Deploy. Ebenso Authentik-Rücksprünge je App (`ch.rosenweg4303.<app>:/anmeldung`) per Skript (`scripts/authentik-apps-sso.py` erweitern) anlegen.
8. **App-Kennung im Protokoll:** Header `X-Rosenweg-App: <kennung>/<version>` von der Basis senden, im Audit (`auditCtx`) mitschreiben; erlaubt später Mindestversion (`426 Upgrade Required` → Updater).
9. **Rückwärtskompatibilität:** Apps werden ungleichzeitig aktualisiert → Felder nur hinzufügen, nicht umbenennen; Breaking Changes nur mit neuer Route.
10. **CORS:** für native Apps unnötig – **nicht** lockern. Flutter-Web ist kein Ziel.
11. **Last:** `validateAppToken` fragt Authentik-userinfo bei jedem neuen Token (60 s Cache). Bei 40 Apps mit Polling Cache auf die Token-Laufzeit verlängern oder Polling durch MQTT ersetzen.
12. **`server.js` aufteilen** (30 725 Zeilen): je umgebaute App den zugehörigen Bereich nach `api/routes/<bereich>.js` verschieben (wie `salz.js`, `sicherungen.js`). Nicht Voraussetzung, aber bei jeder App-Welle mitnehmen – erleichtert Tests je App.

### 4.3 Push-Benachrichtigungen

Heute nur Web-Push (VAPID, `lib/webpush.js`). Native Apps brauchen:
- **Android ohne Google** (geteilte Telefone) und mit: **kein ntfy** (Entscheid Stefan 27.11.2026). Weg: MQTT-Abo über den vorhandenen Broker, bzw. Abfrage beim Öffnen der App; Details in Welle 2 klären.
- **iOS/macOS:** nur APNs – braucht Apple Developer Program (Grenze, siehe 5.4).
- **Linux/Windows-Desktop:** solange die App läuft (MQTT-Abo) + Systembenachrichtigung.
- Server: `POST /api/push/geraete {app, art: 'unifiedpush'|'apns'|'webpush', endpunkt}`; `webpushLib.sendToEmails` zu `benachrichtigen(emails, app, nachricht)` verallgemeinern.

---

## 5. Reihenfolge, Aufwand, Risiken

Aufwand: **S** ≈ bis 300 Web-Zeilen, wenige Endpunkte, keine Sonderhardware (2–4 Tage bis Release) · **M** ≈ 300–1000 Zeilen oder ein Sonderthema (5–10 Tage) · **L** ≈ >1000 Zeilen, mehrere Bereiche oder neue API (2–4 Wochen). Je inkl. 5 Plattformen, eigenem Logo, /apps, Startmenü der Stationen, Anleitung.

### Welle 0 – Fundament (vor allem anderen)

| Arbeit | Aufwand |
|---|---|
| offene PRs mergen: basis #11/#12 + Desktop-Gerüst, salz #14/#16, profil #1/#3, vm #26/#27 | S |
| Basis Prio A (Rechte, Listen, Formulare, Kamera/QR, Upload/Download, PDF) | L |
| Release-Vorlage + App-Vorlage `neue-app.sh` inkl. Logo-Erstellung je App (Zeichen-SVGs für die Fachgebiete aus 1e vorbereiten) | M |
| API: Stufen (4.2.1), Frische für App-Tokens (4.2.2), App-Register als Daten (4.2.7), App-Header (4.2.8) | M |

Begründung: Ohne Vorlage und Basis würde jede der 37 Apps dieselben Bausteine neu erfinden – genau das soll die Basis verhindern.

### Welle 1 – viele Nutzer, kleiner Umfang, kaum neue API

| App | Aufwand | Warum jetzt |
|---|---|---|
| Rosenweg Profil – vervollständigen (pwa/daten, App-Sitzungen) | S | besteht; braucht nur 4.2.2 |
| Rosenweg Karten (Flutter-Neubau) | M | Entscheid; NFC/PC-SC in der Basis schon da; Java-App weg |
| Rosenweg Telefonbuch | S | alle, klein, Offline-Nutzen |
| Rosenweg Mein Telefon | S–M | frisch gebaute Web-Seite (dd604cc), API vorhanden |
| Rosenweg Zutritt | M | alle Bewohner, täglicher Nutzen (Tür öffnen) |
| Rosenweg Waschküche | M | häufig genutzt, klare Aufgabe |
| Rosenweg Reparatur | L | grösster Bewohner-Nutzen, testet Kamera/Upload/Push der Basis; öffentlicher Web-Teil bleibt |

### Welle 2 – Bewohner/Eigentümer, Daten- und Dokument-Apps

| App | Aufwand | Abhängigkeit |
|---|---|---|
| Rosenweg Wetter | S | Diagramme + MQTT (Basis B) – gutes Pilotprojekt dafür |
| Rosenweg Energie | L | Diagramme, MQTT |
| Rosenweg ZEV | M | PDF |
| Rosenweg Termine | M | – |
| Rosenweg Vollmachten | M–L | PDF erzeugen/Upload |
| Rosenweg Unterlagen | M | Upload/Download/PDF |
| Rosenweg Projekte | M | Unterlagen, Termine (Deep-Links) |
| Rosenweg STWEG | M | Editor für Ausschuss; Drucken als PDF (4.2.5) |
| Rosenweg Internet | M | QR-Erzeugen (WLAN, WireGuard) |
| Rosenweg TV | M | Video (`media_kit`) – iOS/Mac-Grenzen beim UDP-Proxy prüfen |
| **Rosenweg Mail-Freigabe** | M | vorgezogen: wenige Nutzer, aber täglich und eilig; profitiert stark von Push |

### Welle 3 – Verwaltung und Ausschuss

| App | Aufwand |
|---|---|
| Rosenweg Auslagen (inkl. Arbeitserfassung, Offline) | L |
| Rosenweg Handwerker | L |
| Rosenweg Briefe | S |
| Rosenweg Objekte (inkl. Grundbuch, Hausverwaltungen) | L |
| Rosenweg Personen (inkl. Löschungen) | M |
| Rosenweg Rundmail | L |
| Rosenweg Mail-Archiv | M (Pagination) |
| Rosenweg Aushänge | M (PDF-Druck aus API) |
| Rosenweg Anzeigen | M |
| Rosenweg Rechte | S |

### Welle 4 – Technik und Infrastruktur

| App | Aufwand |
|---|---|
| Rosenweg Stationen | L |
| Rosenweg Sicherungen | M |
| Rosenweg SSH | S |
| Rosenweg Proxmox | S–M |
| Rosenweg NOC | M (Kiosk-Vollbild auf Station) |
| Rosenweg MQTT | M |
| Rosenweg ISP-Verwaltung | L (83 ISP-Routen, Pagination) |
| Rosenweg Telefonanlage | M |
| Rosenweg Geteilte Telefone | M |
| Rosenweg WhatsApp | M |
| Rosenweg Anlagen | M (WebView-Frage) |

Begründung der Reihenfolge: Nutzen = Anzahl Personen × Häufigkeit; Admin-Apps zuletzt, weil wenige Personen sie nutzen und diese das Web bis dahin problemlos haben (Ausnahme Mail-Freigabe wegen Eile/Push). Jede Welle zieht die Basis-Bausteine nach, die sie zuerst braucht (Welle 2: Diagramme, MQTT, Druck, Push).

Summe grob (38 Apps in den Wellen 1–4): ~8×S, ~22×M, 8×L, dazu Welle 0 → realistisch mehrere Monate; mit zwei bis drei Apps parallel pro Woche (Claude-gestützt, Stefan prüft Bedienung) etwa 4–6 Monate.

### Risiken

| Risiko | Gegenmassnahme |
|---|---|
| **Apple:** iOS-Verteilung und Core-NFC brauchen das Apple Developer Program; macOS-DMG ohne Notarisierung zeigt Gatekeeper-Warnung; APNs nur mit Konto | Entscheid Frage 2; bis dahin iOS „baut in CI, nicht verteilt“ (wie Salz) und Grenze auf /apps nennen |
| 41 Repos × 5 Plattformen = viel CI-Last und Pflege (Flutter-/Paket-Updates) | wiederverwendbarer Workflow, Renovate/Dependabot gesammelt, Basis-Version fest pinnen; Self-hosted Runner für Linux/Android |
| Karten-Sitzung öffnet Admin-Funktionen | Stufen (4.2.1) **vor** Welle 4 |
| Doppelte Wartung Web + App: abgelöste Seiten nur übergangsweise, **gebündelte Seiten dauerhaft** | abgelöste Seiten einfrieren; bei gebündelten neue Funktionen nur in der App (Frage 11); Web und App nutzen dieselbe API, keine Logik im Frontend |
| 41 eigene Logos müssen unterscheidbar bleiben | Zeichen-Liste 1e vorab festlegen, Kontaktbogen aller Logos nebeneinander prüfen (Bildschirmfoto nach ~/Downloads) |
| Linux-Lücken: WebView, Kamera (kein `mobile_scanner` unter Linux), NFC nur PC/SC | Grenzen in README/Anleitung nennen, Desktop-Ersatz (USB-Scanner, Datei wählen, Browser öffnen) |
| Bedienung zerfasert über 41 Apps (Ein-Symbol-pro-Aufgabe ist gewollt, aber Suche wird schwerer) | /apps nach Zielgruppe gruppieren, Launcher-Ordner, Deep-Links; Bedienung je App mitprüfen |
| `server.js`-Grösse: jede App berührt denselben Monolithen | Bereich je App auslagern (4.2.12) |
| Upstream-Abhängigkeit Fossify (Telefon, Kontakte, Dokumente) überlappt mit Telefonbuch/Unterlagen | klare Abgrenzung im README (Flutter = Portal-Funktion, Fossify = Gerätefunktion) |

---

## 6. Ablösung der Web-Seiten

Entscheid Stefan 27.11.2026: **Nur Web-Seiten, die 1:1 einer App entsprechen, werden abgelöst.** Wo der Plan mehrere Web-Seiten oder Web-Apps in **eine** Flutter-App bündelt, bleiben diese Web-Seiten bestehen (Spalte „Web-Seite“ in 1a–1c bzw. „Web“ in 1e).

**Wird abgelöst (1:1):** Telefonbuch, Vollmachten, Projekte, Abschnitt Dokumente (Unterlagen), TV, Salz, Handwerker, Brief-Tracking, Mail-Archiv, Rechte, Sicherungen, SSH, Proxmox, NOC, PBX-Admin (Telefonanlage), WhatsApp-Gateway, dazu `stationen.html`, sobald Stationen **und** Anzeigen fertig sind (eine Seite, zwei Apps) – und die Java-App Karten.

**Ablauf für diese Seiten:**

1. **App veröffentlicht** (alle Plattformen, auf /apps, im Startmenü der Stationen): Web-Seite zeigt oben ein Band „Diese Funktion gibt es jetzt als App – [Herunterladen]“ (gemeinsam in `js/nav.js`, Zuordnung Seite → App aus dem App-Index). Seite eingefroren (nur noch Fehlerbehebungen).
2. **Nach ~4 Wochen ohne Probleme:** Menüeintrag zeigt auf /apps#<app>; die Seite bleibt per direktem Link erreichbar.
3. **Abschalten**, wenn das Zugriffsprotokoll (Traefik/Audit) 4 Wochen nur noch Einzelfälle zeigt und diese Personen informiert sind. Die API bleibt.

**Bleibt (gebündelt):** alle übrigen Seiten aus 1a–1c, z. B. Profil + Meine Daten, Reparatur + Reklamationen + STWEG-Übersichten, Waschküche, Zutritt + Access, Mein Telefon + Telefon anmelden + Smartphones, Energie, ZEV, Wetter, Termine, STWEG/MEG, ISP/WLAN, Steuerung/Alarmpanel, Auslagen + Arbeit, Objekte/Grundbuch/Hausverwaltungen, Personen/Löschungen, Mail-Seiten (Rundmail, Freigabe), Aushänge, MQTT, ISP-Verwaltung, Technik-Cockpit. Für sie gilt:
- kein Abschalten, kein Umbiegen des Menüs; optional ein dezenter Hinweis „Auch als App: …“ (gleiches Band, nur als Hinweis);
- weiter gepflegt, aber neue Funktionen kommen zuerst in die App (Vorschlag – siehe Frage 11);
- damit ist auch die Frage „Personen ohne App / fremde Geräte“ für die meisten Bewohner-Funktionen erledigt: Waschküche, Zutritt, Reparatur, Energie bleiben im Browser nutzbar.

**Dauerhaft Web** bleibt ausserdem die Liste in 1d (öffentlich, Anmeldefluss, Besucher-Links, Anzeigen).

**Personen ohne App bei abgelösten Seiten:** betrifft fast nur Verwaltung/Technik (bekannte Personen mit eigenen Geräten). Im Haus ersetzen die **Stationen** (alle Apps vorinstalliert, .deb vom PXE-Server) den Browser am fremden Gerät. Einzige Bewohner-Seite unter den abgelösten ist das **Telefonbuch** – Vorschlag: zusätzlich als PDF (Ablage/Aushang), siehe Frage 9. Notfall-Handwerkerliste ebenfalls als PDF/Aushang.

---

## 7. Offene Fragen an Stefan (mit Vorschlag)

1. ~~Karten-Anmeldung bei Admin-Apps?~~ **Entschieden (Stefan, 27.11.2026): Karte = Schlüssel, volle Rechte wie Konto; Admin-Aktionen mit Karte werden nur protokolliert.**
2. **Apple Developer Program (99 USD/Jahr) anschaffen?** Ohne: keine iOS-Verteilung, kein Core NFC, keine Push auf iOS/macOS, DMG mit Gatekeeper-Warnung. Vorschlag: ja, vor Welle 1 (Karten, Zutritt, Reparatur brauchen NFC/Push).
3. **Dashboard** ersatzlos streichen oder kleine App „Rosenweg Übersicht“? Vorschlag: streichen; /apps nach Zielgruppe und der Launcher übernehmen den Einstieg.
4. **Karten und Zutritt** zusammenlegen? Beide verwalten dieselben UniFi-Access-Daten. Vorschlag: getrennt lassen (Entscheid steht), aber Access-Admin (Türen, Log) in Zutritt.
5. ~~Push-Weg: eigener ntfy?~~ **Entschieden: kein ntfy** (Stefan, 27.11.2026). Vorhandenen MQTT-Broker nutzen oder beim Öffnen abfragen.
6. **Steuerung/Anlagen:** WebView auf ioBroker/HA (Linux-Lücke, eigene Anmeldung) oder eigene API-Endpunkte für die wichtigsten Werte? Vorschlag: API für Alarm + Heizraum, WebView nur als „Erweitert“, auf Linux Browser.
7. **KI-Suche** (Menü, `/api/ki-search`): in jede App als Basis-Baustein, eigene App oder Web? Vorschlag: vorerst Web, später Basis-Baustein „Frag den Rosenweg“.
8. **Namen bestätigen:** „Rosenweg Unterlagen“ (≠ Dokumente), „Rosenweg Mein Telefon“ (≠ Telefon), „Rosenweg Geteilte Telefone“, „Rosenweg Termine“, „Rosenweg Rundmail“. Vorschlag: so.
9. **Telefonbuch** ist die einzige abgelöste Bewohner-Seite: als PDF-Ausdruck/Aushang zusätzlich anbieten oder Web-Seite doch behalten? Vorschlag: PDF in der Ablage, Web abschalten.
10. **Messenger** (`rosenweg-messenger` PWA, `messages-rosenweg`): ausserhalb dieses Plans lassen? Vorschlag: ja, ist keine Portal-Funktion; später eigener Plan.
11. **Gebündelte Web-Seiten weiter ausbauen?** Vorschlag: neue Funktionen nur noch in der App, Web nur Fehlerbehebungen – sonst doppelte Arbeit.
12. **Farbe je Zielgruppe** im Logo (Bewohner/Verwaltung/Technik) zusätzlich zum Fachgebiets-Zeichen? Vorschlag: ja.
