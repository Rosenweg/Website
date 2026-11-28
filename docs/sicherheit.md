# Sicherheit – Vorfälle, Schutzmechanismen, Betrieb

Stand: 17.11.2026 (nach der Sicherheitsprüfung, PR #23). Dieses Dokument ist die
zentrale Stelle für alles, was mit Angriffsschutz zu tun hat: was passiert ist,
welche Regeln heute gelten, welche Umgebungsvariablen sie steuern, wie man
ausrollt und zurückbaut, und was noch offen ist. Die einzelnen Fachdokumente
(`api.md`, `energie-api.md`, `ssh-zugang.md` …) verweisen hierher.

> **Grundsatz:** Fehlt eine Konfiguration (Geheimnis, Schlüssel, Adresse), schaltet
> sich die betroffene Funktion **ab** (fail closed) – sie fällt nie auf einen
> Standardwert zurück. Ein abgeschaltetes Feature ist ein Betriebsproblem; ein
> Standardpasswort aus dem öffentlichen Repo ist ein Sicherheitsproblem.

---

## 1. Vorfälle 16./17. November 2026

### 1.1 SSRF über den Energy-Collector (16.11.)

- **Was:** Die Admin-API des Energy-Collectors (`/api/energy/meters` POST/PUT,
  `/meters/:id/test`) war ohne Anmeldung erreichbar. Es wurden Schein-Zähler
  angelegt, die der Collector danach selbst abgefragt hat: `100.64.2.1:22`, die
  eigene Datenbank, beliebige HTTP-Ziele (Server-Side Request Forgery).
- **Zusätzlich:** `/api/energy/meters/:id/users` und `/api/energy/user/:email/meters`
  lieferten ohne Anmeldung die E-Mail-Adressen der Zähler-Zuordnungen. Mit genau
  solchen Adressen liefen kurz danach die Code-Anfragen aus 1.2.
- **Behoben:** PR #20 (Admin-Schlüssel, Zielprüfung `meter-target.js`, nftables),
  PR #21 (Zuordnungs-Routen nur mit Admin-Schlüssel), PR #23 (alle personenbezogenen
  Lese-Routen nur noch angemeldet, siehe Abschnitt 4.6).

### 1.2 Durchprobieren der Einmal-Codes der Reparatur-Meldung (17.11.)

- **Zeitraum:** 02:29–05:40 UTC, rund **3,6 Millionen** Anfragen auf
  `POST /api/reklamationen/oeffentlich`, etwa 1000 pro Sekunde, alle über
  Cloudflare (die echte Quell-IP steht nicht im Edge-Log, nur Cloudflare-Knoten).
- **Ursache:** Die öffentliche Reparatur-Meldung ohne Konto prüfte den 6-stelligen
  E-Mail-Code **ohne Versuchslimit**. Login-OTP, Doodle-Code und Reparatur-Code
  teilten sich ausserdem dieselbe Tabelle; Fehlversuche wurden nur im
  Arbeitsspeicher gezählt.
- **Folgen:** Drei Treffer → Schein-Meldungen #3 („auto-brute“), #4 („auto“) und
  #5 („i9384 benign test reclamation“, mit einer SVG-Datei als „Foto“). Die
  Technik-WhatsApp-Gruppe bekam die Meldungen.
- **Begleitbefunde in derselben Nacht:** fehlgeschlagener Z-Push-Login für
  `rosenweg4303` um 02:22 UTC; Mailversand der API schlug zeitweise mit SMTP 535
  fehl (Ursache ausserhalb des Codes).
- **Sofortmassnahmen:** nginx-Drossel für Code-Endpunkte (#22); danach der
  vollständige Umbau in PR #23 (Abschnitt 4.2).

### 1.3 Öffentlich ausgelieferte Dateien (entdeckt 17.11.)

Auf den Frontend-Containern lagen seit Juni noch Dateien aus der alten
Docker-Auslieferung, die ohne Anmeldung abrufbar waren:

| Datei | Inhalt |
|---|---|
| `www…/networks_full.json` | zwei WireGuard-Private-Keys der UDM |
| `www…/devices_full.json` | UniFi-Geräteschlüssel aller Geräte (authkey, inform, mesh, syslog) |
| `www…/network-data.json` | Netztopologie, MACs, IPs |
| `stweg*/data/kontakte.json`, `meg/data/kontakte.json` | Namen, E-Mails, Telefonnummern |

Am 17.11. ~12:05 UTC gelöscht und aus dem Repo entfernt. **Die Schlüssel gelten als
kompromittiert** (Abschnitt 7.1).

### 1.4 Öffentliches Repository

`github.com/Rosenweg/Website` ist **öffentlich**. Die Git-Historie enthält ältere
Klartext-Geheimnisse (Cloudflare-Token, Gmail-App-Passwort, SMTP2GO, UniFi-Keys,
Bearer der AD-/Print-/PVE-APIs, UniFi-Controller-Backup, Datenbank-Passwort,
WhatsApp-Gateway-Key, einen vollständigen PAT). Im aktuellen Stand sind sie
entfernt; **gültig bleiben sie, bis sie rotiert sind**.

---

## 2. Prüfung und Behebung (Vorgehen)

Nach dem Vorfall wurde die ganze Codebasis in Runden geprüft – jeweils eine
Lese-Runde mit getrennten Prüfern je Bereich (API in Abschnitten, Routen/
Bibliotheken, Nebendienste, Frontend, ISP/PWA, Infrastruktur) und danach eine
Fix-Runde. Jede Runde prüfte auch, ob die vorherigen Behebungen wirken und ob sie
etwas gebrochen haben.

| Runde | Funde | Schwerpunkt |
|---|---|---|
| 1 | ~170 | ganze Codebasis |
| 2 | ~75 | Wirksamkeit von Runde 1, Rückschritte, neue Funde |
| 3 | ~35 | dito |
| 4 | ~15 | dito, dazu bisher nur stichprobenartig gelesene Dateien |

Geprüft wurde ohne Browser und ohne Produktiv-DB: `node --check` für alle
JS-Dateien, alle Inline-Skripte der HTML-Seiten, `py_compile`, `bash -n`,
`nginx -t` (nginx 1.26, alle 7 Konfigurationen), `php -l` (Z-Push), dazu
Einheitentests für Einmal-Codes, Login-Ablauf und Personen-Abgleich.

---

## 3. Bedrohungsmodell in einem Satz je Rolle

- **Anonym aus dem Internet:** darf nur öffentliche Seiten, Geräte-Routen
  (Shelly/LaMetric/Solar-Anzeige), Code-Anforderung, Echtheitsprüfung und die
  öffentlichen STWEG-Infos sehen – nie Personendaten, nie Lastprofile, nie
  Infrastruktur-Details.
- **Angemeldeter Bewohner/Mieter:** sieht und ändert nur, was ihm gehört (eigene
  Wohnung, eigene Zähler, eigene Meldungen/Auslagen/Vollmachten, eigene Konten)
  und was seine STWEG allen Bewohnern zeigt.
- **Ausschuss einer STWEG:** verwaltet **nur diese STWEG**. Eigentümer- oder
  Bewohnerschaft in einer anderen STWEG gibt dort keine Schreibrechte.
- **Verwaltung:** wie Ausschuss, gebunden an die STWEG-Gruppen, in denen sie steht.
- **Technik / Präsident:** volle Rechte. Bestimmte Vorgänge (Gruppen vergeben,
  Konten löschen, Personen mit eigenem Konto ändern, Zonen-Freigaben) sind nur hier
  möglich. Ausnahme: MQTT-Verwaltung (inkl. App-Passwörter für andere) und die
  Anzeigen-Bedienung (Ankündigungen, Notfall) verlangen die Gruppe `technik` (oder
  `role=admin`); `Präsident` allein genügt dort nicht.
- **Interne Dienste:** sprechen sich nur mit eigenen Geheimnissen an; keine
  IP-Vertrauensstellung ausser wo ausdrücklich dokumentiert (`INTERN_LESER`).

---

## 4. Schutzmechanismen je Bereich

### 4.1 Anmeldung, Sitzungen, Zugangstoken

| Regel | Wo | Details |
|---|---|---|
| OAuth-State signiert (HMAC) und einmalig | `api/server.js` `/api/auth/login`, `/api/auth/callback` | Schlüssel zufällig je Prozessstart; 10 Min gültig. Nach einem API-Neustart muss eine laufende Anmeldung neu begonnen werden. |
| State an den Browser gebunden | Cookie `rw_oauth_bind` (HttpOnly, Secure, SameSite=Lax, Path=`/api/auth/callback`, 10 Min) | Fehlt das Cookie oder passt es nicht → Seite „Anmeldung abgebrochen“ (400), kein automatischer Neustart. Verhindert, dass jemand seinen eigenen Anmeldecode im Browser eines Opfers einlöst. |
| Client-Merker beim Rücksprung | `js/authentik-auth.js` | `#auth=`-Token wird nur übernommen, wenn `login()` im selben Browser in den letzten 15 Min gestartet wurde; Nutzerobjekt kommt nur von `/api/auth/me`. |
| Keine Login-Schleifen | `js/authentik-auth.js` | Abmelden nur bei 401; bei 5xx bleibt die Sitzung. Automatische Login-Starts höchstens 2 in 2 Min je Tab, dann Hinweis mit Knopf. `AuthentikAuth.ready` (Promise) und Event `authentik-auth-ready`. |
| Benutzerzeile an Authentik gebunden | Spalte `users.authentik_sub` | Wird beim ersten Login gesetzt; ein anderes Authentik-Konto mit derselben E-Mail bekommt 403. Gilt für Browser-Login und Bearer-Token. |
| Konto gelöscht → Zugang weg | `lokalesKontoNachLoeschung()` | `authentik_sub=NULL`, `active=false`, Sitzungen gelöscht, PATs widerrufen, Token-Cache geleert. Der Sync deaktiviert Zeilen, deren Konto in Authentik fehlt. |
| Passwort ändern | `POST /api/change-password` | Nur aus einer Authentik-Browsersitzung, die höchstens 15 Min alt ist („Jetzt neu anmelden“ im Profil, `prompt=login`); 5 Versuche/Std.; danach werden alle anderen Sitzungen gelöscht. Kein altes Passwort nötig (Passkey-Konten haben keins). |
| OTP-Login per E-Mail | `/api/otp/*` | **Abgeschaltet**, solange `OTP_LOGIN_ENABLED` nicht `1` ist (kein Frontend nutzt ihn; er gäbe eine Sitzung an Authentik vorbei). |
| PAT-Pfade normalisiert | `api/middleware/auth.js` | Gross/Klein, doppelte und abschliessende `/` werden vor Sperrliste und Scope-Prüfung vereinheitlicht. Gesperrt für PATs: Passwort, Token, Passkeys, MQTT-App-Passwörter, Profil-Login. |
| MCP-Ressourcen | `api/mcp/erweiterungen.js` | Positivliste: für alle nur Hilfe-/Konzeptdokumente; Betriebsdokumente nur Technik/Präsidium; nur mit Scope `docs:read` (oder ohne Scopes). |

### 4.2 Einmal-Codes (Reparatur-Meldung, Doodle, OTP-Login)

Alles in `api/lib/otp.js`:

- **8 Stellen**, kryptografischer Zufall, **zweckgebunden** (`login`,
  `reklamation`, `doodle`): ein Reparatur-Code ist kein Login-Code.
- **Versuche in der Datenbank am Code** (`otp_codes.versuche`): nach **5**
  Fehlversuchen ist der Code verbraucht – über alle Routen, auch nach Neustart.
  Prüfen und Hochzählen in einer SQL-Anweisung (keine Umgehung durch parallele
  Anfragen); Verbrauch nur einmal (`UPDATE … WHERE used=false`).
- **Gültigkeit 10 Minuten.**
- **Ausstellen:**
  - Antwort sofort und immer gleich („Falls die Adresse im Verzeichnis steht…“) –
    weder Inhalt noch Antwortzeit verraten, ob eine Adresse bekannt ist.
  - Vor der Antwort nur ein Limit **je Client-IP: 20 in 10 Min** über alle drei
    Code-Routen (IPv4 je Adresse, **IPv6 je /64**).
  - Erst im Hintergrund, nur für bekannte Adressen: **3 Codes in 10 Min und 12 pro
    Tag je Adresse**, global höchstens `OTP_GLOBAL_MAX_10MIN` (Standard 1000) je
    Zweck. Überschreitungen werden still verworfen und geloggt.
- **nginx davor** (`frontends-lxc/nginx/upstreams.conf`, Zone `rw_otp`):
  10 Anfragen/Min je Client-IP, Burst 10, ohne Gross/Klein-Unterschied im Pfad.
- **Doodle-E-Mail-Prüfung** in linearer Zeit, Eingaben auf 254 Zeichen begrenzt.

### 4.3 Rechte und Mandantentrennung

- **Schreibzugriffe je STWEG** (`requireStwegWrite`, `stwegSchreibErlaubt`):
  Technik/Präsident, Ausschuss **dieser** STWEG, Verwaltung nur mit einer Gruppe
  dieser STWEG. Gilt für Wohnungen, Kontakte, Import/Archiv, ZEV-Konfiguration und
  -Sync, Unterschriftenlisten und Rückläufe.
- **Benutzer- und Gruppenverwaltung** (`/api/admin/users`, `/api/admin/groups`):
  Nicht-Technik vergibt nur Bewohner-/Eigentümer-Gruppen der eigenen
  Ausschuss-STWEG, und nur an Konten, die ausschliesslich solche Gruppen haben oder
  schon in der eigenen STWEG sind. Konten anlegen ohne Passwort und ohne
  AD-Synchronisation; Benutzername `vorname.nachname`; Kollisionen (auch Gross/Klein,
  auch E-Mail) → 409. Löschen nur Technik/Präsident. Gruppen-IDs nur als UUID.
- **Personen** (`/api/personen/:id`, `/api/personen/merge`): Personen mit eigenem
  aktivem Konto oder mit Wohnungen ausserhalb der eigenen Ausschuss-STWEGs dürfen
  nur Technik/Präsident umbenennen, umadressieren oder zusammenführen.
- **Kontakte in der Wohnungsverwaltung**: `person_id` aus dem Formular wird
  verworfen (nur die bisherige gilt); die Weitergabe an die Person übernimmt der
  Server nur für ungeschützte Personen. Wechselt an einer Karte die E-Mail einer **geschützten** Person
  (eigenes Konto oder Wohnungen in einer anderen STWEG, z. B. beim Mieterwechsel), wird
  der Kontakt auf eine eigene Person umgehängt; bei ungeschützten Personen werden Name
  und E-Mail wie bisher in die gemeinsame Person übernommen.
- **Eigene Wohnung im Profil** (`/api/me/wohnung`): neue Kontakte werden nie mit
  fremden Personen verknüpft; geänderte Namen am eigenen Kontakt gehen nicht in
  `personen.name` (der Signaturname bleibt verwaltet); E-Mail/Telefon, die einer
  anderen Person oder einem Konto gehören → 409. Gleiche Prüfung für
  `/api/me/kontakt`, `/api/me/emails`, `/api/me/phones`.
- **Automatisches Löschen von Konten** nach Auszug: nur Konten, deren Gruppen
  **alle** Bewohner/Eigentümer dieser STWEG sind; storniert, sobald die Adresse
  wieder aktiver Kontakt ist.
- **Weitere STWEG-gebundene Bereiche:** Reklamationen (Liste und alle `:id`-Routen,
  Melde-Orte, Auto-Zuweisung), Auslagen (Entwürfe nur durch den Ersteller, keine
  Selbstgenehmigung, Positionen nur bis „eingereicht“), Personenliste, Dashboard,
  Telefonbuch (Bewohner: nur eigene STWEG, keine archivierten), ZEV-Rechnungen,
  Verwaltungen (Plattform-Zugänge nur der eigenen STWEG), Grundbuch und
  Einstellplätze (fremde Einträge ohne Namen/Adressen/E-Mails), Waschküche
  (Reservieren und Lesen nur eigene STWEG), E-Mail-Log (nur Technik/Präsident).
- **Dokumente** (`/api/documents`): Unterordner `auslagen/`, `anzeigen/`,
  `reklamationen/`, `unterschriftenlisten/`, `grundbuch-bilder/` nur
  Technik/Präsident; `fotos_von_versendeten_briefen/` nur Ausschuss. Verschieben nur
  von Dateien, Zielendung aus der Upload-Liste, kein Überschreiben.

### 4.4 Uploads, Dateien, Ausgaben im Browser

- **Fotos der Reparatur-Meldung:** Typ aus dem Inhalt (JPEG/PNG/WebP/HEIC), sonst
  verworfen; Auslieferung nur dieser Endungen mit `nosniff` und
  `Content-Security-Policy: sandbox`.
- **Avatar:** nur `data:image/(png|jpeg|webp)`, höchstens 512 KB, Magic-Bytes geprüft.
- **Mail-Archiv-Anhänge:** Content-Type über Positivliste, sonst Download.
- **Frontend:** alle Werte in `innerHTML` werden escaped (`& < > " '`); Daten nie in
  `onclick`-Strings, sondern `data-*` + `addEventListener`; Links nur
  `http(s)/mailto/tel`; Mail-Vorschau bereinigt (DOMParser) und gesandboxt, externe
  Bilder erst auf Knopfdruck; CSV-Exporte gegen Formeln geschützt; Fremdskripte mit
  fester Version und `integrity` (ausser Tailwind-CDN und Google Fonts).
- **Fehlertexte:** Der Server gibt intern nur Log-Details aus; an den Browser geht
  ein allgemeiner Text (`fehlerFuerClient`). Ein Fehler-Handler am Ende verhindert
  Stacktraces; Ablehnungen in async-Routen werden gefangen.

### 4.5 Sicherheits-Header (nginx, alle Frontends)

`frontends-lxc/nginx/sicherheit-header.conf`, in jeder `location` mit eigenem
`add_header` eingebunden:

```
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: SAMEORIGIN
Content-Security-Policy: frame-ancestors 'self'
Strict-Transport-Security: max-age=31536000
```

Keine `script-src`-Regel (die Seiten nutzen Inline-Skripte). Gesperrt werden
ausserdem `.md`, `.alt`, `.bak`, Quell- und Konfigurationsdateien, `/data/` auf den
STWEG-Hosts. JSON: auf `fe-www` nur `site-config.json`, `zaehler-config.json`,
`access-manifest.json`; auf den STWEG-Hosts nur `site-config.json`; isp und pwa
haben keine eigene JSON-Sperre (dort liegen keine Datendateien). `/.well-known/` bleibt erreichbar.

### 4.6 Energie

| Route (unter `/api/energy/`) | Zugang |
|---|---|
| `surplus`, `surplus-available`, `lametric`, `shelly`, `solar-live`, `tariffs`, `tariffs/current` | offen (Geräte, Anzeigen) – **ohne** die Liste `consumers` (Live-Leistung je Wohnung) |
| alles andere (`meters`, `live`, `history`, `daily`, `today`, `export`, `compare`, `dashboard`, `alerts`, `meine-zaehler` …) | nur angemeldet über die Haupt-API (`api/routes/energie-lesen.js`), nur zugeordnete Zähler; Technik/Präsident/Admin/`energie-config:read` sehen alles |
| Schreiben | nur `/api/energie-admin/*` (Recht `energie-config:write`) mit Admin-Schlüssel |

- nginx schickt nur die offenen Routen direkt zum Collector, alles andere zur API.
- Der Collector liefert personenbezogene Lese-Routen nur an `INTERN_LESER`
  (= Haupt-API `100.64.2.52`) oder mit Admin-Schlüssel. **Ausnahme vom Grundsatz
  „fail closed“:** Ist `ENERGY_INTERN_LESER` leer, sind diese Routen am Collector
  für jede Quelle offen (Warnung im Log). Auf CT 129 ist der Wert seit dem
  17.11.2026 gesetzt; Prüfung auf CT 129:
  `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/energy/meters`
  muss `403` liefern.
- `/api/zaehler-technik` (Seite `stweg3/pages/zaehler-technik.html`): Zugang nur
  für die Gruppen `technik`, `präsident`, `verwaltung` und `r9-eigentuemer`
  (Eigentümer also nur Rosenweg 9). Volle Sicht nur
  mit Technik/Präsident/Admin/`energie-config:read`; Verwaltung und Eigentümer
  sehen keine IP/Port/Seriennummer und Live-Werte nur von Netz, Produktion und
  eigenen Zählern.

### 4.7 ISP, Traefik, DNS

- Mail-Relays, Reverse-Proxy und Weiterleitungen von Nicht-Admins werden **nie
  automatisch** freigegeben, wenn der Name in einer unserer Cloudflare-Zonen liegt
  oder sich mit einem fremden Eintrag (gleicher Name, Ober-/Unterdomain, gleiche
  registrierbare Domain) überschneidet. Bei einem DB-Fehler gilt: Konflikt.
- Beide Traefik-Generatoren übernehmen nur `approval_status='approved'` und prüfen
  Hostnamen, SNI und Ports erneut. Ändert ein Nicht-Admin Ziel, Port, SNI oder
  schaltet die Anmeldung ab → zurück auf „wartet auf Admin“.
- Freigeben in `isp-admin.html`: Knöpfe „Genehmigen“ bei Mail-Relays (Reiter
  „Mailserver/PMG“) sowie bei Reverse-Proxy-Routen und Weiterleitungen (Reiter
  „Routing“).
- NOC ohne Token: gekürzte Sicht (ohne MAC/Hostnamen, IPs, WAN-IP, LXC-Liste);
  Token nur per Header `X-Noc-Token` bzw. `#token=` in der Wandbild-URL.
- Heizung (`heizung.rosenweg9.ch`, `heizung.rosenweg4303.ch`): alle Router hinter
  Authentik, auch in anderer Schreibweise des Hostnamens.

### 4.8 Mail, WhatsApp, Druck, PBX

- **WhatsApp-Gateway (CT 116):** SMTP 2525 nur von PMG (nftables für IPv4 **und**
  IPv6). Von PMG nur Absender aus `smtp_senders` und nur Aliase als Empfänger
  (Antworten auf eigene Weiterleitungen ausgenommen). Der HTTP-Proxy zur API lässt
  nur `GET /api/auth/{login,callback,logout,me}`, `GET /api/whatsapp/admin/recipients` und
  `POST /api/whatsapp/admin/broadcast`
  durch. PATs werden in der Oberfläche abgelehnt.
- **Mail-Composer:** immer über die Freigabe-Outbox; direkt nur an einen
  Stammempfänger mit „ohne Freigabe“, wenn alle Adressen unverändert sind.
- **Druck per Mail:** Absender aus `<…>`, nicht aus dem Anzeigenamen; Junk wird nicht
  gedruckt; externe Absender nur mit `dmarc=pass` in einem
  `Authentication-Results`-Kopf des eigenen Mailservers (`PRINT_AR_AUTHSERV_ID`).
- **PBX (CT 220):** AMI nur von `127.0.0.1` und der API (`100.64.2.52`);
  Rufnummern und Namen ohne Steuerzeichen in allen Routen, Call-Files und
  AGI-Befehlen; Provisionierungs-Token einmalig.
- **Voicemail:** automatische Reklamationen höchstens 3 je Nummer und 20 pro Tag.
- **Doodle-Einladungen:** höchstens 50 je Umfrage, 100 pro Tag und Konto.

### 4.9 SSH-Zugang (Kurzfassung, Details in `ssh-zugang.md`)

- Schlüssel liefert `rw-authorized-keys` nur für Konten der Gruppe `rw-verwaltet`
  (von `rw-konten-sync` angelegt) oder für Logins in `SCHLUESSEL_AUCH_FUER` der
  `/etc/rosenweg-ssh.conf` (so auf den AD-Hosts CT 102, 106, 108, 111, 136, 206).
- sudo schreibt `rw-konten-sync` nur für `rw-verwaltet` mit UID ≥ 1000.
- Host-Token nur per stdin (`curl -K -`), nie in der Prozessliste; Absage (400/404)
  löscht den Zwischenspeicher sofort.
- Sitzungsschlüssel (`/api/ssh/sitzung`) nie für Technik-/sudo-Konten und nur auf
  bekannten aktiven Stationen; Systemkonten (`root`, `ansible`, `claude`, `github`,
  `ubuntu`, `debian`, `pi` …, erweiterbar per `SSH_GESPERRTE_LOGINS`) nie.
- Stationen von Nicht-Technik werden gesperrt registriert und erhalten Geheimnisse
  erst nach Freigabe.

### 4.10 Karten-Anmeldung der Apps auf privaten Geräten (`api/routes/app-karte.js`)

Entscheid Stefan 26.11.2026: Rosenweg-Apps zeigen auf privaten Geräten (ohne
Rosenweg Gerät) denselben Anmeldeschirm wie der Sperrbildschirm der geteilten
Telefone. Die Karte allein meldet an, **ohne PIN** (die PIN gibt es nur auf
geteilten Telefonen). Jede App hat ihre eigene Sitzung.

Die UID ist kopierbar und das Gerät steht nicht im Haus. Darum:

- **Bindung ans Gerät:** Schlüsselpaar EC P-256 im Android-Keystore der App
  (nicht exportierbar); der Server kennt nur den öffentlichen Schlüssel.
  Zugangs-Token `rw_app_…` gilt 15 Minuten; erneuern nur mit Unterschrift über
  eine einmalige Herausforderung des Servers (`POST /api/apps/sitzung/erneuern`).
- **Kartenprüfung bei jedem Erneuern** live in UniFi Access (entzogen = Sitzung
  weg, Gruppen frisch). Access nicht erreichbar: höchstens 24 Std. ohne Prüfung.
- **Benachrichtigung:** Mail an die Person bei der ersten Karten-Anmeldung auf
  einem neuen Gerät (Kennung = sha256 der ANDROID_ID, gleich für alle
  Rosenweg-Apps eines Geräts).
- **Übersicht/Widerruf:** Profil → „Mit der Rosenweg-Karte angemeldete Apps“;
  Technik/Präsident sehen alle (`GET /api/apps/sitzungen?alle=1`,
  `DELETE /api/apps/sitzungen/:id`, `POST /api/apps/sitzungen/alle-abmelden`).
- **Schwächerer Ausweis:** gleiche Sperrliste wie PATs (kein Passwort, keine
  Token/Passkeys/MQTT-Zugänge) und `requireUserLogin` lehnt ab.
- **Kein Orakel:** „nicht bekannt oder gesperrt“ für Fremde gleich.
- **Laufzeit** 30 Tage (`APP_KARTE_TAGE`), höchstens 20 aktive Sitzungen je
  Person (`APP_KARTE_MAX_SITZUNGEN`); eine neue löst die am längsten unbenutzte ab.

### 4.11 Karte wie Schlüssel: App-QR, Profil, Signieren (Entscheid Stefan 28.11.2026)

Karten-, QR- und Handy-Sitzungen (`rw_app_…`) und geteilte Telefone (Anlage-Token)
dürfen seit 28.11.2026 drei Dinge, die vorher nur mit dem Rosenweg-Konto gingen.
Alles andere aus 4.10 bleibt: **kein Passwort, keine SSH-Schlüssel, keine
API-Tokens, keine Passkeys, keine MQTT-Zugänge** (Konto-Übernahme), und nie mit
einem persönlichen Zugangstoken (PAT) oder über MCP.

| Was | Route | Schutz |
|---|---|---|
| **C** App-Anmelde-QR (RWAPP1) ausstellen, z. B. in Mein Telefon am geteilten Telefon | `POST /api/apps/qr-ausweis`, `GET /api/apps/qr-ausweis/:id` (`ak.qrAusstellenErlaubt`) | nur fürs eigene Konto; 90 s, einmal, je Person nur der neueste (unverändert); jede Ausgabe im `admin_protokoll` (Bereich `apps`, Karten-/Geräte-Vermerk); ein QR aus einer Karten-Anmeldung meldet beim Einlösen **immer** per Mail und die neue Sitzung trägt `herkunft` |
| **F** Profil-Angaben und Profilbild | `PUT /api/auth/profile`, `PUT /api/auth/avatar` (`lib/sperrliste.js` `KARTE_FREI`); am geteilten Telefon dazu die übrigen Angaben wie mit der Karte auf dem eigenen Handy (Zusatznummern, E-Mail-Aliase, WhatsApp, Desktop-Stil) | genau diese zwei Anfragen, sonst bleibt `/api/auth/` zu; jede Änderung mit der Karte im `admin_protokoll` (Bereich `profil`, nur Feldnamen); signiert wird nie unter einem selbst geänderten Namen (`vmKontoNamen`) |
| **E** Vollmacht digital signieren | `POST /api/vollmachten/:id/sign-bestaetigung`, dann `POST …/sign-digital {bestaetigung}` (`lib/signaturbestaetigung.js`) | direkt vor dem Signieren **Karte erneut vorlegen** (live in UniFi Access: zugewiesen, derselben Person) **oder Anmelde-QR aus dem Konto scannen** (nur ein QR, den eine Konto-Anmeldung ausgestellt hat); Nachweis gilt `VOLLMACHT_BESTAETIGUNG_S` (120 s), einmal, nur diese Vollmacht und Person; 5 Fehlversuche / 15 Min je Person; Protokoll in `vollmacht_sign_bestaetigungen`, `admin_protokoll` (Bereich `vollmachten-signatur`) und Kartenprotokoll |

Technik/Präsident lesen die drei Bereiche mit `GET /api/admin-protokoll/:bereich`
(`profil`, `apps`, `vollmachten-signatur`).

**Warum der QR fürs Signieren vom Konto stammen muss:** Seit C kann man an einem
geteilten Telefon einen App-QR ausstellen. Wer an einem Telefon steht, an dem
jemand anderes noch angemeldet ist, könnte sich so selbst einen QR holen
(abfotografieren, der Kamera zeigen) und die „Bestätigung“ wäre wertlos. Darum
zählt für E nur ein QR mit `ausgestellt_art` website, otp, app oder authentik.

**Restrisiko bei C:** Ein QR aus einer Karten-Anmeldung ergibt eine QR-Sitzung,
die beim Erneuern das Konto (Authentik) prüft, nicht die Karte. Wird eine
verlorene Karte nur in UniFi Access entzogen, laufen solche Sitzungen weiter.
Darum: bei verlorener Karte immer auch **„Alle Apps abmelden“** (Profil bzw.
Rosenweg Zutritt, `POST /api/apps/sitzungen/alle-abmelden`); die Person bekommt
bei jedem solchen Einlösen eine Mail.

#### Rechtsverbindlichkeit und Beweiskraft der Signatur mit Karte oder QR

Keine Rechtsberatung; Einschätzung für den Betrieb.

- **Rechtliche Kategorie gleich:** Mit Konto, Karte oder QR entsteht dieselbe
  *einfache elektronische Signatur* (ZertES Art. 2 lit. a). Für keine der drei
  gilt eine gesetzliche Vermutung; im Streit würdigt das Gericht den Nachweis
  frei (Art. 157 ZPO). Keine ist der eigenhändigen Unterschrift gleichgestellt —
  das kann nur die qualifizierte elektronische Signatur (Art. 14 Abs. 2bis OR).
  Verlangt ein Reglement der STWEG für die Vollmacht Schriftform, genügt also
  weder die Konto- noch die Karten-Signatur; dafür bleibt der Papierweg
  (unterschriebene PDF hochladen). Das galt schon vor dieser Änderung.
- **Beweiskraft nicht gleichwertig:**
  - *Konto (frisch):* Wissen (Passwort) bzw. die Anmeldung in Authentik, höchstens
    15 Minuten alt (`STUFE_FRISCH_MIN`).
  - *QR aus dem Konto:* gleich stark wie eine Konto-Anmeldung (der QR wurde
    höchstens 90 s vorher in einer Konto-Sitzung ausgestellt), aber diese
    Sitzung muss nicht frisch sein; dazu Besitz des Geräts, das ihn zeigt.
  - *Karte:* nur Besitz; gelesen wird die Seriennummer (UID) der Karte, die sich
    kopieren lässt; keine PIN. Ein Bestreiten („Karte verloren oder kopiert“) ist
    leichter. Die Karte muss in UniFi Access der Person zugewiesen und nicht
    gesperrt sein — das ist der stärkste Teil des Nachweises.
- **Was dokumentiert wird:** Auf dem PDF steht die Methode im Klartext
  (`signed_bestaetigung`, z. B. „Rosenweg-Karte 4F2A9C erneut vorgelegt am …
  um … Uhr (angemeldet am geteilten Telefon 2098)“), dazu Zeit, Identität und
  (für Technik/Präsident) IP. In der Datenbank: `signed_bestaetigung_art`
  (konto, karte, qr), `signed_bestaetigung_ref` → `vollmacht_sign_bestaetigungen`
  (Karte, QR-ID, Sitzung, App, Gerät, IP, Zeit der Vorlage, Zeit des Signierens)
  und die Einträge im `admin_protokoll` und im Kartenprotokoll. Wer die Vollmacht
  prüft (Verwaltung, Versammlungsleitung), sieht so, womit bestätigt wurde, und
  kann bei Zweifel eine Konto- oder Papier-Signatur verlangen.

---

## 5. Grenzwerte (Rate-Limits) auf einen Blick

| Was | Grenze |
|---|---|
| Code anfordern (alle Zwecke) | 20 / 10 Min je IP (IPv6 je /64); 3 / 10 Min und 12 / Tag je Adresse; global 1000 / 10 Min je Zweck |
| Code prüfen | 5 Versuche je Code, dann verbraucht |
| nginx `rw_otp` | 10 / Min je IP, Burst 10 |
| Passwort ändern | 5 / Std. je Konto |
| Stations-/App-Login (AD) | 10 Fehlversuche / 15 Min je Name, 50 / 15 Min je IP |
| Reparatur-Meldung (angemeldet) | 5 / 10 Min je Person |
| Tür öffnen (Zutritt-PWA) | 10 / 10 Min, jede Öffnung protokolliert (`access_tueroeffnungen`) |
| NFC-Anlernen | 10 Sitzungen / 10 Min |
| KI-Suche | 30 / Min |
| Beleg-Scan (KI) | 30 / Std. |
| Grundbuch-OCR | 30 / Std. je Konto |
| Vollmacht KI-Prüfung | 10 / Std. |
| Personensuche (Vollmachten) | 60 / 10 Min |
| Echtheitsprüfung (verify-json) | 30 / 10 Min je Client |
| Mail-Composer | 50 / Std. |
| Mailbox-Antrag | 10 / Std., höchstens 3 automatisch angelegte Postfächer |
| VPN-Konto anlegen | 10 / Std., höchstens 10 Konten |
| Stations-Tunnel | 10 / Std., höchstens 20 je Konto |
| App-Tunnel zum vm-gateway (`POST /api/apps/tunnel`, Rosenweg-Konto) | 30 / Std. je Gerät, 60 / Std. je Konto; höchstens 5 Geräte gleichzeitig je Person (prüft der Gateway) |
| DNS-Prüfung (ISP) | 30 / 10 Min |
| Push-Test | 5 / 10 Min |
| Voicemail-Reklamation | 3 / Tag je Nummer, 20 / Tag gesamt |
| Doodle-Einladungen | 50 je Umfrage, 100 / Tag je Konto |
| Signatur-Bestätigung mit Karte/QR (`POST /api/vollmachten/:id/sign-bestaetigung`) | 5 Fehlversuche / 15 Min je Person |
| Karten-Anmeldung der Apps (`POST /api/apps/karte-anmelden`) | je 15 Min: 10 Fehlversuche und 40 Versuche je IP, 5 Fehlversuche je Karte, 10 je Gerät, 200 Fehlversuche gesamt; höchstens 20 Sitzungen je Person |
| Z-Push (ActiveSync) | 5 Fehlversuche / 15 Min je Benutzer; nginx 10 / s gesamt |

---

## 6. Umgebungsvariablen mit Sicherheitsbezug

Die API liest ihre Umgebung aus `/opt/rosenweg-core/.env` (CT 128). **Werte stehen
nie im Repo.**

### 6.1 Pflicht – sonst ist die Funktion aus

| Variable | Funktion | Fehlt → |
|---|---|---|
| `DB_PASSWORD` | Datenbank | lauter Log-Eintrag, Start ohne DB scheitert |
| `ENERGY_DB_PASSWORD` | Energie-DB (API und `backend-lxc/energy/compose.yml`) | Compose startet nicht |
| `ENERGY_ADMIN_API_KEY` | Collector-Admin und Zuordnungs-Routen | Energie-Konfiguration und „Meine Zähler“ aus |
| `AD_PASSWORD_API_SECRET` | AD-Passwort beim Passwortwechsel | nur Authentik wird gesetzt |
| `PRINT_API_SECRET` | Druck per Mail | es wird nichts gedruckt |
| `PRINT_AR_AUTHSERV_ID` | Druck von externen Absendern (authserv-id des eigenen Mailservers) | externe Absender werden nicht gedruckt |
| `PVE_MSG_SECRET` | Host-Meldungen der PVE-Knoten | `/api/pve-messages` 503 |
| `GOOGLE_CALENDAR_ICS_URL` | Termine | `/api/calendar` 503 |
| `TRAEFIK_CONFIG_SECRET`, `TRACKER_SHARED_SECRET`, `WHATSAPP_SHARED_SECRET`, `PBX_SHARED_SECRET`, `ALARM_SECRET`, `MQTT_AUTH_SECRET`, `SSH_HOST_TOKEN`, `SCAN_API_KEY`, `EMAIL_INBOUND_SECRET` | interne Dienste | jeweilige Schnittstelle antwortet 403/503 |

### 6.2 Optional / Steuerung

| Variable | Wirkung |
|---|---|
| `OTP_LOGIN_ENABLED=1` | OTP-Login per E-Mail einschalten (Standard: aus) |
| `OTP_GLOBAL_MAX_10MIN` | globales Code-Limit je Zweck (Standard 1000) |
| `NOC_PUBLIC_OPEN`, `NOC_PUBLIC_TOKEN` | NOC-Wandbild: ohne Token gekürzte Sicht |
| `VPN_AUSZUG_SPERREN` | Standard an: der Abgleich sperrt VPN-Zugänge beim Auszug selbst (Peer entfernt, Zeile bleibt). `aus`: nur melden (`GET /api/isp/vpn-accounts/wohnsitz`) |
| `SSH_GESPERRTE_LOGINS` | weitere Logins, die nie SSH-Zugang bekommen |
| `STATION_PROXY_NETZE`, `STATION_INTERN_NETZE` | eigene Proxys / Hausnetz für Stationen |
| `ZEV_ABSENDER` | erlaubte Absender der ZEV-Rechnungsmails |
| `IMAP_SERVERNAME`, `ZEV_IMAP_SERVERNAME` | Servername für die TLS-Prüfung der Postfächer |
| `IMAP_TLS_INSECURE=1`, `ZEV_IMAP_TLS_INSECURE=1`, `DMARC_IMAP_TLS_INSECURE=1` | Notausgang, falls ein Zertifikat ungültig ist (nur vorübergehend) |
| `VOLLMACHT_BESTAETIGUNG_S` | wie lange die Karten-/QR-Bestätigung fürs Signieren gilt (Standard 120 s, 30–300) |
| `PORTAL_ANLAGE_SECRET` | Apps auf geteilten Telefonen (Rosenweg Gerät → PBX-API → hier, `lib/anlagetoken.js`); derselbe Wert in `/etc/default/pbx-api` auf CT 220. Fehlt er, ist der Weg aus (401) |
| `NODE_ENV=production` | keine Stacktraces im Browser |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | **noch gesetzt** (UniFi/Mailcow/PVE mit eigenen Zertifikaten) – soll durch `NODE_EXTRA_CA_CERTS` ersetzt werden |

### 6.3 Nebendienste

| Dienst | Variablen |
|---|---|
| Energy-Collector (CT 129, `/opt/rosenweg-energy/.env`) | `ADMIN_API_KEY`, `ENERGY_DB_PASSWORD`, `ENERGY_INTERN_LESER=100.64.2.52`, `METER_NETWORKS`, `MODBUS_ALLOWED_PORTS` |
| WhatsApp-Gateway (CT 116) | `GW_SMTP_STRENG_IPS` (Standard PMG `100.64.2.31`), `GW_NOTIFY_TLS_VERIFY` |
| Syslog-Collector | `SYSLOG_ALLOWED_SOURCES`, `SYSLOG_TCP_IDLE_TIMEOUT` (600 s), `SYSLOG_MAX_TCP_CLIENTS` (20) |
| wg-control (CT 113) | `WG_CONTROL_BIND`, `WG_CONTROL_TOKEN` |
| vm-gateway (eigener CT, Repo rosenweg-vm/gateway) | `GW_STEUER_BIND`, `GW_STEUER_TOKEN`, `PVE_TOKEN`; Haupt-API: `VM_GATEWAY_URL`, `VM_GATEWAY_TOKEN` |
| Z-Push (CT 115) | `RW_LDAP_URI` (für LDAPS) |
| Avatar-Sync (CT 108) | `AUTHENTIK_URL`, `AUTHENTIK_API_TOKEN`, `AVATAR_HOSTS` |

---

## 7. Offene Punkte

### 7.1 Geheimnisse rotieren (dringend – Repo ist öffentlich)

In dieser Reihenfolge; nach jedem Schritt den neuen Wert nur in `.env`/Vault, nie
ins Repo:

1. Cloudflare-API-Token (DNS-Kontrolle über alle Zonen, damit auch Zertifikate)
2. Gmail-App-Passwort des Sammelpostfachs
3. SMTP2GO-Passwort und -API-Key
4. UniFi-API-Keys (beide), danach UniFi-Geräte neu adoptieren
5. WireGuard-Schlüsselpaare der UDM (VPN-Server, Tunnel WG-HEL1)
6. `AD_PASSWORD_API_SECRET` (DC, `password-api.py`) – dort zusätzlich: Passwort nur
   für frisch angelegte, nicht privilegierte Konten setzen
7. `PRINT_API_SECRET` (Druck-API `100.64.2.32`)
8. `PVE_MSG_SECRET` (Melde-Skripte auf den PVE-Knoten)
9. Privater Kalender-Link in Google neu erzeugen → `GOOGLE_CALENDAR_ICS_URL`
10. PAT aus der alten `hilfe.html` (`rw_pat_5ec5…`) in `api_tokens` widerrufen
11. Was über die alte Stations-Registrierung an Nicht-Technik ging:
    `STATION_AD_JOIN_PASSWORD`, `STATION_ROOT_PASSWORD_HASH`, `STATION_MQTT_PASSWORD`,
    PPSK `RK-Clients`; ausserdem `SSH_HOST_TOKEN`
12. Energie-DB-Passwort (`ALTER USER energy PASSWORD …` im energy-db-Container,
    dann `.env` auf CT 129 **und** CT 128)
13. Optional: Repo privat schalten und Historie bereinigen (`git filter-repo` + Force-Push)

### 7.2 Betrieb

- Routen mit Umlaut im Pfad (Mail-Empfänger, Handwerker-Verträge/-Aufträge,
  Unterschriftenlisten-Rückläufe, Zähler-Daten) waren schon vor dem 17.11. nie
  erreichbar (Express vergleicht den kodierten Pfad) – Behebung in PR #24.

- ~~Zertifikat `contacts.rosenweg4303.ch` abgelaufen~~ — seit 18.11.2026 endet TLS am Edge, das Zertifikat erneuert sich dort automatisch (`zpush/README.md`).
- `PRINT_AR_AUTHSERV_ID` an einer echten Mail prüfen (oberster
  `Authentication-Results`-Kopf).
- ~~CrowdSec/fail2ban auf dem Edge-Proxy fehlen~~ — seit 18.11.2026 CrowdSec auf dem Edge (CT 245) mit nftables- und Traefik-Bouncer, PMG als weiterem Bouncer; Details und Rosenweg-Regeln in `edge-traefik/README.md`. Offen: MQTT und Nextcloud melden gescheiterte Anmeldungen noch nicht an CrowdSec.
- ioBroker läuft mit `auth=false` (nur noch hinter Authentik erreichbar).
- Kiosk: Änderungen wirken erst nach erneutem `setup-kiosk.sh`; `root_password`
  in der Kiosk-Konfiguration setzen.
- Auf den AD-Hosts (CT 102, 106, 108, 111, 136, 206) läuft noch die alte
  `rw-konten-sync` (damit AD-Konten ihr sudo behalten).

### 7.3 Grundsatzentscheide

Die gesammelten Ja/Nein-Fragen aus den Prüfrunden stehen im PR #23 und in den
Prüfberichten; die wichtigsten:

- Repo privat? Historie bereinigen?
- `NOC_PUBLIC_OPEN` ganz streichen (Wandbild nur mit Token)?
- Mail-Relays/Weiterleitungen von Nicht-Admins nie automatisch freigeben?
- Telefonbuch: Bewohner nur eigene STWEG (jetzt) oder alle?
- Stationen: Registrierung durch Nicht-Technik ganz verbieten?
- Eigener Host-Token je SSH-Host statt eines gemeinsamen?
- Echtheitsprüfung öffentlich nur „echt/Datum/Anzahl“ statt aller Eigentümer?
- Gmail-Adresse als erlaubter Absender für Mails an WhatsApp behalten?

---

## 8. Ausrollen und Rückbau

### 8.1 Reihenfolge

1. API (CT 128): `cd /opt/rosenweg-core && docker compose pull api && docker compose up -d api`
2. Frontends (alle `fe-*`): `/opt/rosenweg/repo/frontends-lxc/deploy.sh`
   (installiert nginx-Konfig **und** `sicherheit-header.conf`, prüft `nginx -t`).
   Läuft eine alte Fassung des Skripts, schlägt `nginx -t` fehl, weil die
   Header-Datei fehlt – einfach ein zweites Mal starten.
3. Energie (CT 129): Compose aus dem Repo, `.env` mit `ENERGY_INTERN_LESER`, dann
   Collector neu.
4. WhatsApp-Gateway (CT 116): Image, `wa-2525-fw.nft` + Unit, alte iptables-Regel weg.
5. Edge (CT 245): `extra-routes.yml` nach `/etc/traefik/dynamic/` (Datei-Provider
   lädt selbst neu).
6. Einzeldienste: wg-control (CT 113), Z-Push (CT 115), PBX (CT 220), TV7 (CT 250,
   über `tv7-streamer/deploy.sh`), router-api (alle Router-CTs), Avatar-Sync (CT 108),
   Dokumenten-Backup (CT 106).
7. SSH-Skripte: `rw-authorized-keys`, `rw-konten-sync` auf Knoten und Containern;
   vorher je Host prüfen, ob die benutzten Logins in `rw-verwaltet` stehen.

### 8.2 Prüfen

```sh
# nginx-Syntax lokal (Arbeitskopie):  /tmp/ngx-skripte/test.sh <repo>
# Von aussen:
curl -sI https://www.rosenweg4303.ch/ | grep -iE 'x-frame|content-security|strict-transport|nosniff'
curl -s https://www.rosenweg4303.ch/api/energy/meters          # 401
curl -s https://www.rosenweg4303.ch/api/energy/surplus         # ohne "consumers"
curl -s -X POST https://www.rosenweg4303.ch/api/otp/send       # 404 (abgeschaltet)
```

### 8.3 Zurückbauen

Jede beim Rollout am 17.11.2026 ersetzte Datei liegt daneben als
`<datei>.vor-sicherheit-2026-11-17` (bzw. in `/root/` des Containers), ebenso
`/opt/rosenweg-core/.env.vor-sicherheit-2026-11-17` und
`/opt/rosenweg-energy/{.env,compose.yml}.vor-sicherheit-2026-11-17`. Images:
vorheriges Tag aus GHCR (`:<git-sha>`) in der Compose-Datei eintragen.
