# Email-System — Rosenweg

Stand: 28.11.2026. Sicherheitsregeln (Mail-Composer, Druck per Mail,
WhatsApp-Gateway) im Überblick: [`sicherheit.md`](sicherheit.md) Abschnitt 4.8.

> **Bis Sommer 2026** lief der Mail-Eingang über Cloudflare Email Routing → Gmail
> (`rosenweg4303@gmail.com`) → IMAP-Abruf der API, der Ausgang über SMTP2GO.
> Heute sind **Mailcow** und **Proxmox Mail Gateway (PMG)** der Mailserver. Das
> Gmail-Konto und sein App-Passwort gelten als kompromittiert und sind zu
> ändern (`sicherheit.md` Abschnitt 7.1, Punkt 2), auch wenn das Konto nicht
> mehr gebraucht wird.

## Bestandteile

| Teil | Wo | Aufgabe |
|---|---|---|
| Mailcow | CT 240 `mailcow`, `100.64.2.33` | Postfächer, Verteiler-Aliase (Mailcow verteilt selbst an die Mitglieder + `archiv@`), SOGo, IMAP |
| PMG | CT 230 `pmg`, `100.64.2.31`, pve3 | Filter und Relay. Ausgehend primär über den eigenen VPS (`smtp-relay.rosenweg4303.ch`), Ausweichziel SMTP2GO; interne Ziele (z. B. WhatsApp-Gateway) über den Transport `intern` ohne Ausweichziel. Details: [`../pmg/README.md`](../pmg/README.md) |
| API (IMAP-Abruf) | CT 128 | holt Mails aus Mailcow-Postfächern (unten) |
| API (Versand) | CT 128 | Mailcow-Submission `MAILCOW_SMTP_HOST:587` (STARTTLS, Zertifikat `mail.rosenweg4303.ch` geprüft), je Funktion ein Gateway-User (unten); ZEV-Mails als `zev@rosenweg9.ch` |
| WhatsApp-Gateway | CT 116, `100.64.2.39:2525` | Mail → WhatsApp für `*@whatsapp.rosenweg4303.ch`, nur über PMG (siehe [`../whatsapp-bot/README.md`](../whatsapp-bot/README.md)) |
| Druck-API | CT 111 `cups-server`, `100.64.2.32:8080` | druckt PDFs auf `DruckerR9`/`DruckerR13`; in der API `api/lib/druckapi.js` (auch für den Scanner-Zettel) |

## IMAP-Abruf der API

Die API (CT 128) fragt alle `IMAP_POLL_INTERVAL` Sekunden (Standard 60) ab:

| Postfach | Variablen | Wofür |
|---|---|---|
| Eingangspostfach `inbox@` | `IMAP_HOST`, `IMAP_PORT` (993), `IMAP_USER`, `IMAP_PASS`, `IMAP_MAILBOXES` (Standard `INBOX,Junk`) | Verteiler-Erkennung, Druck per Mail |
| `archiv@` | `ARCHIV_IMAP_USER`, `ARCHIV_IMAP_PASS` | E-Mail-Archiv (`email-archiv.html`) |
| `dmarc@` | `DMARC_IMAP_USER`, `DMARC_IMAP_PASS` | DMARC-Berichte (`/api/dmarc/reports`) |
| `smartme@rosenweg9.ch` | `SMARTME_IMAP_USER`, `SMARTME_IMAP_PASS` | ZEV-Rechnungen |

Ohne `IMAP_USER`/`IMAP_PASS` findet kein Abruf statt. Die Passwörter stehen nur
in `/opt/rosenweg-core/.env`.

**TLS:** Zertifikate werden geprüft. Weil die API Mailcow per IP anspricht,
muss `IMAP_SERVERNAME` (bzw. `ZEV_IMAP_SERVERNAME`) auf einen Namen im
Zertifikat gesetzt sein. Notausgang bei kaputtem Zertifikat, nur vorübergehend:
`IMAP_TLS_INSECURE=1`, `ZEV_IMAP_TLS_INSECURE=1`, `DMARC_IMAP_TLS_INSECURE=1`.

**Verteiler-Erkennung:** Massgeblich sind `X-Original-To`/`Delivered-To` (der
Empfänger nach Alias-Auflösung in Mailcow, mit `+tag`), ergänzend `To`/`Cc`/`Bcc`.
`inbox@` selbst ist nie ein Ziel. Mit `VERTEILER_NATIVE_FANOUT` (Standard an)
verteilt Mailcow selbst; die API versendet Verteiler-Mails **nicht** nochmals.

## Druck per Mail (`druckerr9@`, `druckerr13@`)

Mails an `druckerr9@rosenweg4303.ch` bzw. `druckerr13@…` werden auf
`DruckerR9` bzw. `DruckerR13` gedruckt; mit `+name` (z. B.
`druckerr9+vorname.nachname@…`) bekommt der Ausdruck ein Deckblatt für diese
Person samt QR-Code zur Abholbestätigung (`abholung.html`).

Ablauf in der API, Schritt für Schritt. Jede Ablehnung markiert die Mail als
gelesen und schreibt eine Zeile ins API-Log (`docker compose logs api | grep Print`):

1. **Druck-API konfiguriert?** Ohne `PRINT_API_SECRET` wird nichts gedruckt
   (`[Print] PRINT_API_SECRET fehlt — …`). Ziel: `PRINT_API_URL`
   (Standard `http://100.64.2.32:8080`).
2. **Absender bestimmen:** Die Adresse wird aus `<…>` im `From`-Kopf genommen,
   **nicht** aus dem Anzeigenamen (`"chef@rosenweg4303.ch" <x@fremd.example>`
   gilt als `x@fremd.example`). `+tag` wird entfernt.
3. **Spam:** Mails aus dem Ordner `Junk`/`Spam`, mit `dmarc=fail` in einem
   `Authentication-Results`-Kopf oder mit `X-Spam-Flag: YES` / `X-Spam: Yes`
   werden nie gedruckt (`[Print] Rejected (spam=… authFehler=…)`).
4. **Externe Absender** (nicht `@rosenweg4303.ch`) nur mit **positivem
   DMARC-Befund des eigenen Mailservers**. Alle Bedingungen müssen erfüllt sein:
   - Der **oberste** `Authentication-Results`-Kopf zählt (tiefere kann der
     Absender selbst mitschicken).
   - Seine authserv-id (erstes Wort nach `Authentication-Results:`) ist gleich
     `PRINT_AR_AUTHSERV_ID` (ohne Gross/Klein).
   - Er enthält `dmarc=pass` mit `header.from=` = Domain der Absenderadresse.
   - Im `From`-Kopf steht genau eine Adresse.

   Fehlt `PRINT_AR_AUTHSERV_ID`, wird **keine** Mail eines externen Absenders
   gedruckt (`[Print] PRINT_AR_AUTHSERV_ID fehlt — …`). Sonst:
   `[Print] Rejected (kein dmarc=pass) from=…`.
5. **Systemmails** (`noreply@`, `mailer-daemon@`, `Auto-Submitted:
   auto-generated|auto-replied`, `X-Rosenweg-No-Print: true`) werden übersprungen.
6. **Berechtigung:** eigene Domäne, `EMAIL_ALLOWLIST`, ein Benutzer in der
   Datenbank oder ein Authentik-Konto mit genau dieser Adresse. Sonst
   `[Print] Rejected: <adresse> not whitelisted for <drucker>`.
7. Doppelte Aufträge (gleiche Message-ID) werden übersprungen; dann Deckblatt
   (Gotenberg) und Anhänge an die Druck-API.

**`PRINT_AR_AUTHSERV_ID` richtig setzen (offener Punkt):** An einer echten, von
aussen eingegangenen Mail im Postfach `inbox@` den **obersten**
`Authentication-Results`-Kopf ansehen (Mailcow/SOGo: „Quelltext anzeigen“), das
erste Wort danach ist die authserv-id, z. B.

```
Authentication-Results: <authserv-id>; dkim=pass header.d=… ; spf=pass … ; dmarc=pass (p=…) header.from=example.ch
```

Den Wert in `/opt/rosenweg-core/.env` als `PRINT_AR_AUTHSERV_ID=<authserv-id>`
eintragen, API neu starten, dann von einer externen Adresse mit DMARC-Eintrag
einen Testdruck an `druckerr9+test@…` senden und im Log auf `[Print]` achten.
Solange der Wert fehlt oder falsch ist, drucken nur Absender aus
`@rosenweg4303.ch`.

## Ausgang der API (Mailcow, Gateway-User)

Seit 27.11.2026 (vorher SMTP2GO, dessen Login ab 16.11.2026 mit 535 scheiterte)
sendet die API nur noch über Mailcow-Submission: `MAILCOW_SMTP_HOST`
(`100.64.2.33`), Port 587, STARTTLS, Zertifikat gegen
`MAILCOW_SMTP_SERVERNAME` (`mail.rosenweg4303.ch`) geprüft. Weiter geht es
Mailcow → PMG → Relay.

Jede Funktion hat einen eigenen Mailcow-Benutzer (Gateway-User), der Login und
Absender zugleich ist. Mailcow lässt als Umschlag-Absender nur die eigene
Adresse zu (`553 … not owned by user`).

| Gateway | Postfach | Wofür (trigger in `email_log`) |
|---|---|---|
| `2fa` | `2fa@rosenweg4303.ch` | Karten-Bestätigungslinks und Quittungen, Login-/Reparatur-/Umfrage-Codes, „neues Gerät“/„Neue App-Anmeldung“ |
| `noreply` | `noreply@rosenweg4303.ch` | alle übrigen Systemmails, bis sie einen eigenen Gateway-User bekommen |
| `zev` | `zev@rosenweg9.ch` | Absender `@rosenweg9.ch` (echtes Postfach) |

- Zugangsdaten nur in `/opt/rosenweg-core/.env`: `MAIL_<NAME>_USER`,
  `MAIL_<NAME>_PASS`; die Zuordnung trigger → Gateway steht in
  `api/lib/mailgateway.js`.
- Systemabsender (`MAIL_FROM`, `noreply@…`) werden zur Gateway-Adresse
  (Anzeigename bleibt, sonst „Rosenweg“). Bei fremdem Kopf-Absender (Verteiler:
  `"Name via Liste" <liste@…>`) bleibt der Kopf, `Sender:` und Umschlag werden
  der Gateway-User.
- `email_log.gateway` hält fest, über welchen Gateway-User eine Mail ging.
- Neuer Gateway-User: Postfach in Mailcow anlegen (Name „Rosenweg System –
  <Funktion>“, kleines Kontingent), Name in `MAIL_GATEWAYS`, USER/PASS in die
  `.env`, Trigger in `GATEWAY_REGELN` zuordnen.

SMTP2GO bleibt nur Ausweichziel von PMG und Relay; die API liest dort noch das
Kontingent (`/api/email/quota`, NOC) und verwaltet Smarthost-Domains (ISP).

Verwendung: Verteiler-Weiterleitung, Authentik-Benachrichtigungen,
Systemmails. Der Mail-Composer der Website sendet **immer über die
Freigabe-Outbox**; direkt nur an einen Stammempfänger mit „ohne Freigabe“, wenn
alle Adressen unverändert sind (50 Mails pro Stunde).

## DNS-Einträge (Stand der früheren Doku, nicht nachgemessen)

| Record | Wert | Beschreibung |
|--------|------|-------------|
| SPF | `v=spf1 include:_spf.mx.cloudflare.net include:spf.smtp2go.com ~all` | Erlaubte Sender |
| DMARC | `p=quarantine; adkim=s; aspf=s` | Policy: Quarantäne bei Fail |
| DKIM (CF) | `cf2024-1._domainkey` | Cloudflare DKIM |
| DKIM (SMTP2GO) | `s1102430._domainkey → dkim.smtp2go.net` | SMTP2GO DKIM |
| DKIM (Legacy) | `dkim._domainkey` | Alter DKIM Key |
| Return Path | `em1102430 → return.smtp2go.net` | SMTP2GO Bounce-Handling (Absender-Subdomain, siehe `whatsapp-bot/lxc/gateway-data.md`) |
| Tracking | `link → track.smtp2go.net` | SMTP2GO Link-Tracking |

Mit dem Wechsel auf Mailcow/PMG/VPS-Relay müssen SPF und DKIM die neuen
Absender enthalten; gegen die aktuelle Zone prüfen.

## DMARC-Reports

- Gehen an `dmarc@rosenweg4303.ch` (eigenes Mailcow-Postfach).
- Abruf über `/api/dmarc/reports` (Admin), Anzeige in `dmarc.html`.
- Parsing: ZIP/GZ-Anhänge → XML → strukturierte Daten.

## Verteiler-Adressen

| Adresse | Beschreibung |
|---------|-------------|
| ausschuss@rosenweg4303.ch | Verwaltungsausschuss |
| technik@rosenweg4303.ch | Technik-Gruppe |
| praesident@rosenweg4303.ch | Präsident |
| dmarc@rosenweg4303.ch | DMARC-Reports (automatisch) |
| archiv@rosenweg4303.ch | Email-Archiv (automatisch) |
| druckerr9@, druckerr13@ | Druck per Mail (siehe oben) |

Pflege der Verteiler: `email-verteiler.html`. `PUT /api/verteiler/:id` ändert nur
die mitgeschickten Felder; fehlt z. B. `members`, bleibt die Liste stehen.

## Wer darf an einen Verteiler schreiben (Gate)

Verteiler mit „extern erlaubt“ (`external_allowed`) nehmen Mails von allen an.
Alle anderen aktiven Verteiler der Domain sind **gesperrt**: Mailcow verteilt sie
nativ (Alias-`goto` = Mitglieder + `archiv@`), die API sieht die Mail nicht. Die
Absenderprüfung macht deshalb Rspamd über das Gate
[`mailcow/mailcow-verteiler-gate.py`](../mailcow/mailcow-verteiler-gate.py)
(CT 240, Timer alle 5 Minuten). Es holt `GET /api/verteiler/mailcow-gate`
(`version: 2`) und baut **je Verteiler** eine eigene Regel. Die Regeln stehen in
[`api/lib/verteiler-gate.js`](../api/lib/verteiler-gate.js); dieselben gelten im
Rückfall ohne nativen Fanout in der API:

| Verteiler | Wer darf schreiben |
|---|---|
| alle gesperrten | Technik, Präsident, Funktions- und Gateway-Postfächer der Domain (`noreply@`, `2fa@`, `praesident@` …), `technik@`/`praesident@`, Adressen aus `VERTEILER_GATE_ALLE_LISTEN` (CT 128 `.env`, durch Komma getrennt) |
| einer STWEG N, ohne Absender-Gruppen | Personen der STWEG N (Kontakte der Wohnungen, Mieter wie Eigentümer, nicht archiviert; Authentik-Gruppen Bewohner/Eigentümer/Ausschuss von N) |
| einer STWEG N, mit Absender-Gruppen | nur Mitglieder dieser Gruppen |
| einer STWEG N, immer | Verwaltung von N: Gruppe `stwegN-verwaltung` (Übergang „Verwaltung“), Adressen und Domains der Verwaltungen mit Vertrag für N oder für alle STWEGs |
| STWEG-übergreifend (`stweg` 0), ohne Absender-Gruppen | alle bekannten Personen und alle aktiven Verwaltungen |
| STWEG-übergreifend, mit Absender-Gruppen | nur diese Gruppen und die Verwaltung aller STWEGs (Vertrag ohne STWEG, Übergangsgruppe oder in jeder `stwegN-verwaltung`); `eigentuemer@` und `eigentuemer-direkt@`: `ausschuss` + `Verwaltung` (einmalige Migration, Entscheid 28.11.2026) |

Ganze Domains gibt das Gate nur für Verwaltungen frei, nie Freemail-Domains
(gmail.com …) und nie die eigenen Mailcow-Domains. Die Regel greift auch für
`+tag`-Adressen (`stweg3+x@`). `GATE_ABSENDER_PRUEFEN=1` in
`/etc/default/mailcow-verteiler-gate` weist zusätzlich Absender ab, die weder
angemeldet sind noch SPF/DMARC bestehen (sonst nur Markierung
`ROSENWEG_GATE_UNBELEGT` in der Rspamd-Historie).

**Erneuern auf CT 240** (erst nach dem Ausrollen der API, die alte API liefert
keine `version: 2`; das neue Skript ändert dann nichts):

```bash
# auf pve1 (100.64.2.20), Skript aus dem Repo vorher dorthin kopieren
pct push 240 mailcow/mailcow-verteiler-gate.py /usr/local/sbin/mailcow-verteiler-gate.py --perms 0755
pct exec 240 -- /usr/local/sbin/mailcow-verteiler-gate.py --trocken   # Blöcke ansehen, schreibt nichts
pct exec 240 -- systemctl start mailcow-verteiler-gate.service          # schreibt, configtest, Rspamd-Neustart
pct exec 240 -- journalctl -u mailcow-verteiler-gate.service -n 5 --no-pager
```

Schlägt `rspamadm configtest` fehl, rollt das Skript die Blöcke zurück. Zurück
zum alten Stand: Skript aus dem Stand vor diesem Umbau (`git log -- mailcow/mailcow-verteiler-gate.py`)
zurückspielen und den Dienst starten. Solange das alte Skript läuft, liefert die
API die alten Felder (`gated_aliases`, `allowed_domains`, `allowed_emails`)
weiter (ÜBERGANG, danach in `server.js` entfernen).

## Von aussen ins Postfach — welche Namen funktionieren

Die Ports 993 (IMAPS), 465 (SMTPS) und 587 (Submission) sind am Edge offen,
143 und 110 bewusst gefiltert. Welcher Name dort ankommt, entscheidet ein
TCP-SNI-Router in Traefik; ohne passenden Router liefert Traefik sein
Notfallzertifikat und jedes Mailprogramm bricht ab.

| Name | 993 | 465 | Ziel |
|---|---|---|---|
| `imap.rosenweg4303.ch` | ✓ | — | Mailcow 100.64.2.33 |
| `smtp.rosenweg4303.ch` | — | ✓ | PMG 100.64.2.31 |
| `mail.rosenweg4303.ch` | ✓ | ✓ | Mailcow (seit 6.9.2026) |

Die Autokonfiguration (`autoconfig.rosenweg4303.ch`) nennt `imap.` und
`smtp.` — diese beiden waren immer in Ordnung. `mail.rosenweg4303.ch` hatte
bis zum 6.9.2026 **keinen** Router auf 993/465 und antwortete mit
`TRAEFIK DEFAULT CERT`; wer den naheliegenden Namen von Hand eintrug, kam
nicht hinein.

Behoben über die Spalte `isp_mail_relays.sni_alias`. Beide Alias-Router
zeigen auf **Mailcow**, auch der für 465 — PMGs Zertifikat kennt den Namen
nicht, Mailcows schon. Ausgehend ändert das nichts, weil Mailcow ohnehin
über PMG hinausreicht. Der Alias wird **nicht** automatisch aus
`mail.<domain>` abgeleitet: Der Name muss im Zertifikat stehen, und das gilt
für `mail.rosenweg4303.ch`, nicht für `mail.rosenweg9.ch`.

**Messen, nicht vermuten.** Das interne DNS ist geteilt
(`mail.rosenweg4303.ch` → intern `100.64.2.33`, öffentlich `37.17.232.133`).
Ein Test aus dem Rosenweg-Netz oder vom Mac über den Tunnel sagt darum
nichts über die Erreichbarkeit von aussen. Ehrlich misst man vom Relay-VPS:

```bash
ssh -J stefan@10.0.10.149 stefan.mueller@46.224.229.122 \
  'openssl s_client -connect mail.rosenweg4303.ch:993 \
     -servername mail.rosenweg4303.ch -verify_hostname mail.rosenweg4303.ch \
     </dev/null 2>&1 | grep "Verify return code"'
# erwartet: Verify return code: 0 (ok)
```
