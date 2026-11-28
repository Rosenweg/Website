# Umwandlung Web-Apps → Flutter-Apps: Wellen 3 und 4

Stand 28.11.2026. Grundlage: [flutter-apps.md](flutter-apps.md) und die Entscheide dieser Woche.

## Stand vorher (Wellen 1 und 2)

| Welle | Apps | Stand |
|---|---|---|
| 1 | Mein Telefon, Waschküche, Reparatur, Zutritt | live auf /apps |
| 2 | Mail-Freigabe | live auf /apps |
| 2 | Wetter, Termine, ZEV, Energie, TV, Unterlagen, Vollmachten, Projekte | gebaut, werden gemergt bzw. veröffentlicht |
| 2 | STWEG, Internet | im Bau |

Welle 3 beginnt, sobald Welle 2 ganz auf /apps ist.

## Vorgehen pro App (gilt für alle Wellen)

1. **Klären.** Ein Agent liest die Web-Seiten, die API und die Rechte. Daraus schreibt er `~/Downloads/klaerung-<app>.md` mit Funktionen, Rechten je Gruppe, Gruppenfarbe, Lücken in der API sowie Datenschutz- und Rechtefunden. Stefan beantwortet die offenen Entscheide gesammelt.
2. **Funde zuerst beheben.** Datenschutz- und Sicherheitsfunde werden vor dem App-Bau behoben und ausgerollt.
3. **Bauen.** Mit allen Entscheiden im Auftrag, mit Sonnet, höchstens 5 Agenten gleichzeitig.
4. **Integrieren.** Der Integrations-Agent mergt der Reihe nach, vergibt die Basis-Versionen, rollt die API aus (nur er auf CT 128), setzt den Authentik-Rücksprung und trägt die App auf den Stationen ein.
5. **Fertig ist eine App erst, wenn:**
   - sie auf /apps steht;
   - sie auf allen 5 Plattformen läuft (Linux, macOS, Windows, Android, iOS);
   - der Updater drin ist;
   - die Gruppenfarbe nach den freigeschalteten Funktionen wechselt;
   - das Logo Turm + Weg + Rose zeigt;
   - sie bei Bedarf im Katalog der geteilten Telefone und als Stationspaket steht;
   - es die **Web-Version unter `/app/<name>/` mit gemeinsamer Anmeldung** gibt (siehe unten).
6. **Web-Seiten:** Sie bleiben, solange eine App mehrere Seiten bündelt. 1:1 ersetzte Seiten werden abgelöst, aber erst nach Stefans OK je App. Bis dahin zeigt das Menü auf `/app/<name>/` und die alte Seite bleibt liegen.

### Web-Version unter /app/<name>/ (Entscheid Stefan 28.11.2026)

Jede App wird zusätzlich mit `flutter build web` gebaut, liegt unter `https://rosenweg4303.ch/app/<name>/` (auch auf isp.) und ersetzt im Menü die alte Seite. **Es gibt nur eine Anmeldung für die ganze Website.** Die Web-App hat keinen eigenen Anmeldeschirm und keinen eigenen Client in Authentik: sie ruft `js/authentik-auth.js` der Website auf und nutzt deren Sitzung (Token in localStorage und im Cookie auf `.rosenweg4303.ch`). Ohne Sitzung geht es zur normalen Anmeldung der Website und danach zurück auf die Seite; Abmelden in der App meldet auf der ganzen Website ab. Rechte, Gruppen und Gruppenfarbe kommen aus derselben API (`/api/auth/me`). Technik dazu: `rosenweg-basis` `docs/web.md`.

**Weitere App umstellen** (je App, 10 Minuten plus Prüfung):

1. `rosenweg_basis` auf eine Fassung mit Web (≥ 0.9.0).
2. In der App `…/rosenweg-basis/werkzeug/web-einrichten.sh <app-ordner>` (legt `web/` an, schaltet `web: true` in `.github/workflows/app.yml` ein; `--kurz`, wenn der Kurzname vom Repo-Namen abweicht).
3. `flutter build web --release --base-href /app/<name>/` muss laufen. Eigener Code: kein `dart:io` ohne `!kIsWeb`, Dateien über `dateiSpeichern`/`dateiTeilen` und Bytes, nichts mit `dart:ffi` in geladenen Dateien. Im Browser mit der Seite prüfen: eingeloggt, ausgeloggt, Abmelden, Rechte je Gruppe.
4. PR, Merge, Release: der Job `web` hängt `<app>-web.tar.gz` ans Release.
5. Ausrollen: `scripts/rw-web-ausrollen.sh --app <name>` (neuestes Release; `--tag`, `--pruefen`, `--zurueck` für den Rückweg). Es liegt auf fe-www und fe-isp unter `/var/www/rosenweg/app/<name>/`; `frontends-lxc/deploy.sh` lässt `/app/` stehen.
6. `js/nav.js`: Menüeintrag auf `https://rosenweg4303.ch/app/<name>/` (Konstante `APP_WEB`), die alte Seite danach nicht mehr verlinken. Entfernt wird sie erst nach Stefans OK.
7. Das Ausrollen und der Menüeintrag gehören zum Release der App („fertig“), nicht zu einem späteren Aufräumen.

## Welle 3 – Verwaltung und Ausschuss

Diese Apps nutzen nur Ausschuss, Verwaltung, Technik und Präsident.

- **Gruppenfarbe:** mindestens **blau**, für Technik und Präsident **grün**.
- **Ohne Recht:** Wer keines hat, bekommt keinen Zugang. Die Apps haben also keine rote Stufe.

| # | App | Ersetzt / bündelt | Nutzer | Besonderes | Aufwand |
|---|---|---|---|---|---|
| 3.1 | **Rosenweg Objekte** | objektverwaltung.html (inkl. Grundbuch, Hausverwaltungen) | `objektverwaltung`, Ausschuss | Wohnungen, Eigentümer, Wertquoten, Unterschriftenlisten als PDF mit Hash | L |
| 3.2 | **Rosenweg Personen** | personen.html (inkl. Löschungen) | `wohnungsverwaltung` | Stammdaten, Dubletten zusammenführen, Löschanträge (Ablauf aus #183/#209 beachten) | M |
| 3.3 | **Rosenweg Handwerker** | handwerker.html → wird abgelöst | `handwerker` | Einsätze, Verträge; **Notfallnummern offline** und direkt anrufen | L |
| 3.4 | **Rosenweg Rundmail** | email-verteiler, mail-compose, mail-templates, mail-empfaenger-admin | `email-verteiler`, `mail-compose`, Technik/Präsident | Rundmail an Gruppen/STWEG, Vorlagen, Anhänge, HTML-Vorschau; Zusammenspiel mit Mail-Freigabe | L |
| 3.5 | **Rosenweg Mail-Archiv** | email-archiv.html → wird abgelöst | `email-archiv` | Suche, Seitenweise laden, PDF, Löschanträge | M |
| 3.6 | **Rosenweg Briefe** | brief-tracking.html → wird abgelöst | Ausschuss, Technik, Präsident | Briefe erfassen, mit Kamera scannen, als PDF ablegen | S |
| 3.7 | **Rosenweg Aushänge** | melde-orte.html, tuerschilder.html, Aushang-Vorlagen | `reklamationen` | QR-Schilder für Melde-Orte und Räume, Druck; Schilder liegen neu in `stwegN/bewohner/schilder/` | M |
| 3.8 | **Rosenweg Anzeigen** | Ankündigungen in stationen.html | Technik, Ausschuss | Aushänge/PDF/Notfall auf Info-Bildschirme; live über MQTT | M |
| 3.9 | **Rosenweg Auslagen** | auslagen.html, pwa/arbeit/, auslagen-stundensatz.html | `auslagen`, Hauswarte, Technik | Belege mit Kamera und Texterkennung, **Arbeitszeit offline** erfassen, Stundensätze, Bezug zu Projekten | L |
| 3.10 | **Rosenweg Rechte** | rechteverwaltung.html → wird abgelöst | `rechteverwaltung` | Matrix Seitenrechte je Gruppe; eher **grün** (Technik) | S |

**Vorgeschlagene Dreiergruppen:**

1. Objekte, Personen, Handwerker: Stammdaten zuerst, darauf bauen die anderen auf.
2. Rundmail, Mail-Archiv, Briefe: alles rund um Post.
3. Aushänge, Anzeigen, Auslagen.
4. Rechte.

**Absehbare Klärfragen für Welle 3** (werden im Klär-Durchgang je App konkret):

- **Rundmail:** Wer darf an wen senden, und wann braucht es die Freigabe durch einen Zweiten?
- **Mail-Archiv:** Wie lange bleiben Mails? Wer sieht was?
- **Personen:** Löschen nur über den Ablauf mit Anonymisierung (Anrufliste, Protokoll), wie auf der Telefonanlage gebaut.
- **Handwerker und Auslagen:** Was muss offline gehen, und darf es auf geteilten Telefonen offline gespeichert werden?
- **Auslagen:** Die Belege enthalten Personendaten. Darf die KI-Texterkennung extern laufen oder nur im Haus?
- **Objekte:** Wie sicher müssen die Unterschriftenlisten sein, und welche Eigentümerdaten sieht die Verwaltung?

## Welle 4 – Technik und Infrastruktur

Diese Apps nutzt nur Technik/Präsident, Gruppenfarbe **grün**. Es sind Werkzeuge für wenige Personen, dafür mit grossen Rechten.

| # | App | Ersetzt / bündelt | Besonderes | Aufwand |
|---|---|---|---|---|
| 4.1 | **Rosenweg Stationen** | stationen.html (ohne Ankündigungen) | Status, Rollen, Apps, OS, WLAN, Agent v2; live. Die Seite fällt erst weg, wenn Stationen **und** Anzeigen fertig sind. | L |
| 4.2 | **Rosenweg ISP-Verwaltung** | isp-admin, netzwerk, verbindungen, dmarc | Kunden, VLAN, feste IPs, Mail-Relays, Wartung, Netzwerkgeräte, Verbindungsnachweis, DMARC; 83 Routen, grosse Tabellen. Übernimmt die Admin-Teile, die bewusst **nicht** in der Bewohner-App „Internet“ sind (alle WLAN-Passwörter mit Protokoll, VPN-Zugänge ohne Wohnsitz, TV-Technik) | L |
| 4.3 | **Rosenweg Geteilte Telefone** | smartphones.html (Technik-Teil) | Bestand, Wartung, App-Katalog, WLAN-PPSK, Einrichtung; übernimmt „Alle Handys“ aus Mein Telefon (Entscheid 27.11.) | M |
| 4.4 | **Rosenweg Telefonanlage** | pbx-admin.html → wird abgelöst | Nebenstellen, Rufgruppen, Trunk, Anrufe, Testanruf | M |
| 4.5 | **Rosenweg NOC** | noc-fullscreen.html → wird abgelöst | Wandbildschirm im Vollbild auf der Station, Daten teils öffentlich | M |
| 4.6 | **Rosenweg MQTT** | mqtt.html, pwa/mqtt/ | Topic-Browser, Regeln, Dienstkonten, App-Passwörter Dritter; live | M |
| 4.7 | **Rosenweg Sicherungen** | sicherungen.html → wird abgelöst | PBS-Sicherungen, PC-Abbilder | M |
| 4.8 | **Rosenweg Proxmox** | proxmox-verwaltung.html → wird abgelöst | Benutzer, ACL, Rollen | S–M |
| 4.9 | **Rosenweg SSH** | ssh-zugriffsmatrix.html → wird abgelöst | SSH-Zugriffsmatrix | S |
| 4.10 | **Rosenweg WhatsApp** | whatsapp-bot/public → wird abgelöst | Gateway-Status, Opt-ins, Outbox, Kopplung per QR. Vor dem Bot-Start immer die Outbox prüfen (Ausfall 24.10.) | M |
| 4.11 | **Rosenweg Anlagen** | steuerung.html, alarmpanel, heizung-operator | Haustechnik live, Alarme, Heizraum. Die eingebetteten fremden Oberflächen (ioBroker/HA) brauchen einen Entscheid: in der App als WebView zeigen oder nativ nachbauen | M |

**Vorgeschlagene Dreiergruppen:**

1. Geteilte Telefone, Telefonanlage, WhatsApp: rund um Kommunikation; „Alle Handys“ zieht dann aus Mein Telefon um.
2. Stationen (mit Anzeigen aus Welle 3), NOC, Sicherungen.
3. ISP-Verwaltung, MQTT, Anlagen.
4. Proxmox, SSH.

**Absehbare Klärfragen für Welle 4:**

- **Mit der Karte:** Admin-Funktionen nur protokollieren, nie sperren („Karte wie Schlüssel“). Welche Aktionen sind so heikel, dass sie zusätzlich eine frische Kontoanmeldung brauchen, z. B. Proxmox-Rechte, SSH, Löschungen?
- **Geteilte Telefone und Stationen:** Welche Technik-Apps dürfen überhaupt darauf laufen?
- **Anlagen:** fremde Oberflächen als WebView einbetten oder nativ nachbauen?
- **NOC:** öffentliche Teile ohne Anmeldung auf dem Wandbildschirm?

## Was dafür in der Basis noch fehlt (absehbar)

| Baustein | Für |
|---|---|
| Grosse Tabellen mit seitenweisem Laden, Sortieren, Filtern | Mail-Archiv, ISP-Verwaltung, Objekte, Personen |
| Matrix-Ansicht (Zeilen × Spalten mit Häkchen) | Rechte, SSH |
| Offline-Speicher mit Abgleich | Handwerker (Notfallnummern), Auslagen (Arbeitszeit) |
| Texterkennung für Belege (im Haus oder extern, je nach Entscheid) | Auslagen, Briefe |
| HTML-Vorschau und -Editor für Mails | Rundmail |
| Vollbild/Kiosk am Desktop (`window_manager`) | NOC, Anzeigen, TV |
| WebView-Baustein mit Anmeldung | Anlagen |

## Zeitbedarf grob

- **Welle 3:** 10 Apps, davon 4 gross (L). Mit 5 Agenten parallel und dem Klären vorab etwa 3–4 Gruppen.
- **Welle 4:** 11 Apps, davon 2 gross (L). Etwa 4 Gruppen.
- **Engpass:** Der Engpass waren bisher die macOS-Builds. Mit „macOS/iOS nur beim Release“ (in Arbeit) und optional einem eigenen Mac-Runner geht es deutlich schneller.
