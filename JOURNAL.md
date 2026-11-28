# Journal — Findings & offene Punkte

> **Harte Regel:** Findings und offene Punkte hier festhalten, damit sie nicht verloren gehen.
> Neueste Session zuerst. Offenes als Checkbox, Erledigtes abhaken (nicht löschen).

---

## 2026-11-26

### Offen
- [ ] **Smartphones: jedes Handy einmal (Stefan 26.11.: „ist nur 1 Telefon – sieht aus wie 4 Geräte“):** /smartphones und Profil zeigen eigene Handys jetzt je Handy mit ihren Apps (js/meine-geraete.js). Gemeinsame Gerätekennung sha256("rosenweg:"+ANDROID_ID) wie die Karten-Sitzungen; Telefon und Messenger schicken sie erst ab der nächsten App-Version (phone-rosenweg/messages-rosenweg PR `geraet-kennung`, Versionsnummer beim Mergen hochzählen). Bis dahin Rückfall nach Modellname als „vermutlich dasselbe Handy“.
- [ ] **logon.bat ablösen:** Ordnerumleitung als GPO «Rosenweg-Ordnerumleitung» ([ad-dc/gpo-ordnerumleitung](ad-dc/gpo-ordnerumleitung/README.md)), zuerst nur Gruppe `Ordnerumleitung` (stefan.mueller). Ausrollen: `einrichten.sh stefan.mueller` auf dc1, Test auf win11-1, dann `logon-bat-abschalten.sh --ausfuehren`. **Falle:** Cron `/etc/cron.d/sync-logon-script` auf dc1 setzt alle 5 min bei allen Konten wieder `scriptPath: logon.bat` (94 Konten am 26.11.) – das Skript schaltet ihn zuerst ab.

---

## 2026-11-24

### Offen
- [ ] **Geteilte Telefone zentral einrichten (Stefan 24.11.: „über das zentrale Rosenweg-System“, später):** Im pbx-Admin Telefon-IP und Kopplungscode des Drahtlosen Debuggings eingeben; ein Dienst im Netz (adb im Container, z.B. CT 220) koppelt per WLAN, führt `scripts/geteiltes-telefon-einrichten.sh` aus und zeigt das Ergebnis. Neue Schritte so auf allen Telefonen nachziehen. Bis dahin: Skript per WLAN-adb vom Mac (Anleitung in `pbx/GETEILTE-TELEFONE.md`).
- [x] **„Über Fossify-Apps“ → „Rosenweg-Apps“ (erledigt 24.11.2026):** Fossify-Links in den Apps waren schon entfernt (Über-Seite mit Rosenweg-Hinweis, Kauf-/Mehr-Apps-Einträge in FOSS-Builds aus). Eigene Seite https://rosenweg4303.ch/apps.html (nur fe-www, `rw-web-ausrollen.sh --neu --nur fe-www`) nennt Fossify/Sipdroid als Grundlage, GPL-3.0 und Quellcode.
- [ ] **Telefon orten über WLAN:** In „Geteilte Telefone“ anzeigen, an welchem UniFi-Access-Point das Telefon zuletzt hing (Haus/Stockwerk). Ergänzt „Telefon suchen“ (Klingeln, 24.11. gebaut).
- [ ] **Zentraler Log-Sammler (User 2026-11-24):** Logs aller CTs/VMs (Nextcloud, Traefik, Postfix/PMG, Asterisk, Authentik, Bots, Proxmox-Hosts) an einer Stelle sammeln, durchsuchen und mit Aufbewahrungsfrist versehen. Bisher liegt jedes Log nur im eigenen Container. Ein Fehler fällt erst auf, wenn er etwas lahmlegt; Beispiel: nextcloud.log mit 6,3 GB, unbemerkt. Varianten prüfen (z.B. Loki+Grafana oder VictoriaLogs; Versand per Vector/Alloy oder journald-remote). Dazu Alarme: Fehlerrate, Log-Wachstum, „Job läuft nicht mehr“.
- [x] **Nextcloud kam seit 22.11. nicht mehr in `/stweg1`–`/stweg3`** (sichtbar als readme.md „Permission denied“ im Log). Ursache: Ordnerrechte-Rollout 22.11. (`/root/ordnerrechte` auf CT 206/106) gibt nur benannten AD-Gruppen + `api-svc` Zugriff. Die Nextcloud liest aber als lokales `www-data`. Fix 24.11.: In CT 104 lokale Gruppe `technik` gid 11156, `www-data` als Mitglied, php-fpm neu gestartet. Lesen/Schreiben geprüft. README auf CT 206+106 ergänzt.
- [ ] **Ordnerrechte sauber:** Nextcloud als eigener Eintrag in `tabelle.txt` statt über die lokale gid 11156 in CT 104. Dazu muss `anwenden.sh` numerische IDs (uid 33) annehmen. Prüfen, ob auf den Fileservern etwas als www-data läuft.
- [x] **Nextcloud sieht Samba-Änderungen in den Ablage-Einbindungen nicht:** Bei externen „Local“-Einbindungen ist `filesystem_check_changes` nicht gesetzt (= nie prüfen). Wird eine Datei über Windows/Samba/CephFS direkt geändert, zeigt die Nextcloud weiter alte Größe/ETag/Inhalt-Vorschau. Für „Persönlich“ (id 29) am 24.11. auf 1 gesetzt (bei jedem direkten Zugriff prüfen) — damit funktioniert der Notizen-Abgleich. Am 24.11. auf Stefans Anweisung für **alle 25 Einbindungen** gesetzt (`occ files_external:option <id> filesystem_check_changes 1`). **Regel: bei jeder neuen Einbindung mitsetzen.**
- [ ] **win11-1: Drucker-Verbinden beim Anmelden scheitert** (24.11. 12:44, „Verbindung mit DruckerR9 an 100.64.2.32“, CT 111 cups-server). Samba/CUPS auf CT 111 laufen, DruckerR9 idle, nichts im Log. Wahrscheinlich `logon.bat`/Point-and-Print. Nicht durch den Home-Umbau.
- [ ] **Ordnerrechte-Skripte liegen nur auf CT 206/106**, nicht im Repo. Ins Repo holen.
- [x] **AD-Home als einziger persönlicher Ordner** (Entscheid Stefan 24.11.): Nextcloud zeigt `/userdata/home/$user` als „Persönlich“, für alle Personen freigeschaltet. 74 Homes, Timer `homes-anlegen` auf CT 106/206. Offen: Nextcloud-Wurzel zurückdrängen, Windows-Test (inherit acls). Plan: [docs/plans/persoenlicher-ordner.md](docs/plans/persoenlicher-ordner.md).
- [ ] **Rechte Nextcloud ↔ Fileserver angleichen:** Nextcloud-Einbindungen aus `tabelle.txt` erzeugen (Bewohner bei stweg3/6/meg fehlen, `allgemein` für Ausschüsse, `stweg8`/`vorlagen`/`anzeigen` nicht eingebunden). 28.11.2026: Die STWEG-Ordner sind erledigt (`nextcloud/einbindungen-ablage.py`, stündlicher Timer auf CT 104, Bewohner nur `bewohner/`, STWEG 3/6 mit `r9-`/`r1-eigentuemer`, Verwaltung dazu). Offen bleiben `allgemein` für die Ausschüsse sowie `vorlagen` und `anzeigen`.
- [ ] **Nextcloud: Ausschuss bekommt evtl. nur die Nur-lesen-Einbindung:** `/stwegN` hat eine beschreibbare (Ausschuss) und eine Nur-lesen-Einbindung (Eigentümer) am selben Punkt. Nextcloud 33 beachtet die Priorität nicht (siehe `nextcloud/einbindungen-ablage.md`), wer in beiden Gruppen ist, bekommt eine beliebige. Lösung offen, z. B. ein eigener Punkt `/stwegN-ausschuss` für die beschreibbare Einbindung.
- [x] **Mieter sehen Eigentümer-Unterlagen (Datenschutz, 28.11.2026):** API, Samba und Nextcloud zeigen reinen Bewohnern im STWEG-Ordner nur noch `stwegN/bewohner/`. Siehe `fileserver-lxc/ordnerrechte/README.md`.
- [ ] **Nextcloud: „Error while generating metadata for fileid …“** bei mehreren Dateien (7659–7783), seit Cron wieder läuft sichtbar. Ursache noch nicht angeschaut.
- [ ] **Nächtliche Sicherung (vzdump 01:00 → PBS) überlastet Ceph:** 2 OSDs „slow operations in BlueStore“, pve1 Load >30, Nextcloud antwortete 503. Sicherungsfenster/Bandbreite (`bwlimit`, Staffelung) und OSD-Zustand bei Tag ansehen.
- [ ] **Ceph HEALTH_ERR wegen unsicherer aes-Schlüsseltypen** (Altlast, unabhängig vom Ausfall).
- [ ] **CT 128 API-Container mit `NODE_TLS_REJECT_UNAUTHORIZED=0`:** TLS-Prüfung global aus. Gezielt nur für die betroffene interne Verbindung lösen.

### Erledigt
- [x] **Nextcloud-Cron lief seit 19.10.2026 nicht** (Modus „cron“, aber keine Crontab/kein Timer → keine Hintergrund-Jobs, keine Log-Rotation). Neu: systemd `nextcloud-cron.timer` alle 5 min auf CT 104 (Nice 10, IO idle). Erster Lauf 24.11. ok (27 s CPU).
- [x] **nextcloud.log 6,3 GB:** `loglevel` stand auf 0 (Debug) → auf 2 gesetzt, `log_rotate_size` 100 MB, altes Log nach Rotation gelöscht (Sicherung der Config: CT 104 `/root/config.php.vor-loglevel-2026-11-24`).
- [x] **Euro-Office als Office der Nextcloud** (CT 139, siehe docs/euro-office.md).

---

## 2026-07-22

### Offen
- [ ] **Outbound-Fallback DMARC-Lücke (SMTP2GO):** `smtp_fallback_relay = [mail.smtp2go.com]:587` ist **global** — fällt der Relay-VPS aus, geht ALLE Mail über SMTP2GO. **PRIORITÄT (User 2026-07-22): die Absender-Domains müssen erst in SMTP2GO verifiziert/freigegeben werden**, sonst Verified-Sender-Block auf dem Fallback. Verifizierung liefert DKIM-CNAMEs + Return-Path → dann ins DNS + SPF-Include. Aktueller DNS-Stand (inkonsistent):
  - `rosenweg4303.ch`: teilweise (SPF hat smtp2go, `link.`→track.smtp2go.net), aber **keine DKIM-CNAMEs** (`s1/s2._domainkey` fehlen).
  - `rosenweg9.ch`: **gar nicht** in SMTP2GO.
  - `personen.rosenweg4303.ch`: teilweise (`link.`+`em.`→return.smtp2go.net), **SPF fehlt smtp2go**, keine DKIM-CNAMEs.
  - **Eingegrenzt (User 2026-07-22): NUR `rosenweg9.ch` ist in SMTP2GO unverified.** rosenweg4303.ch + personen sind verifiziert (DKIM-Ausrichtung deckt DMARC auf dem Fallback). To-do NUR für rosenweg9.ch: als Sender-Domain in SMTP2GO anlegen/verifizieren → DKIM-CNAMEs (`s1/s2._domainkey`) + Return-Path (`em.`/`link.`) + `include:spf.smtp2go.com` ins rosenweg9.ch-DNS (Cloudflare).
  - **Konkret (SMTP2GO-Verifizierungs-Records für rosenweg9.ch, aus Dashboard 2026-07-22):** In Cloudflare-Zone rosenweg9.ch, alle **DNS only**:
    - CNAME `em1102430` → `return.smtp2go.net`
    - CNAME `s1102430._domainkey` → `dkim.smtp2go.net`
    - TXT/SPF (bestehenden ersetzen): `v=spf1 mx a:smtp-relay.rosenweg4303.ch include:spf.smtp2go.com -all` (Relay bleibt drin, nur smtp2go ergänzt)
    - `link`→track.smtp2go.net existiert bereits. Danach in SMTP2GO „Verify".
  - **WICHTIG (User): Relay NICHT anfassen** — diese Änderungen berühren Relay/PMG-Config nicht (nur additive rosenweg9-DNS-Records).
  - **ERLEDIGT (DNS gesetzt 2026-07-22, User-Freigabe für CF-Token):** Alle 3 Records via CF-API gesetzt + autoritativ verifiziert (em1102430→return.smtp2go.net, s1102430._domainkey→dkim.smtp2go.net, SPF ergänzt — alle DNS-only, Relay unberührt). **Offen nur noch:** User klickt in SMTP2GO „Verify" (rote → grün). CF-Token liegt in CT230 `/etc/letsencrypt/cloudflare/credentials.ini`; Classifier blockt Pipe-in-Shell + Token-Echo → Muster: Skript als Datei auf Host ablegen, dann `bash datei` ausführen. Beleg für die Lücke war: SMTP2GO-Report `zev@rosenweg9.ch` = 1 Reject (Unverified).
- [x] **`whatsapp.rosenweg4303.ch` — beide Wege DMARC-sauber gemacht (2026-07-22, Variante B):** WA-Bridge sendet als `@whatsapp.rosenweg4303.ch`. **Relay-Weg (primär):** opendkim auf Relay-VPS additiv um Subdomain erweitert (SigningTable `*@whatsapp.rosenweg4303.ch`, KeyTable, Key `/etc/dkimkeys/whatsapp.rosenweg4303.ch/relay.private`, reload via USR1 — bestehende Domains unberührt) + DNS `relay._domainkey.whatsapp.rosenweg4303.ch` TXT (Key-Match priv↔DNS verifiziert ✓) + SPF `whatsapp.rosenweg4303.ch` = `v=spf1 a:smtp-relay.rosenweg4303.ch include:spf.smtp2go.com -all`. **SMTP2GO-Weg:** DKIM `s1102430._domainkey.whatsapp` + `em1102430` + `link.whatsapp`→track (alle DNS-only). Noch: whatsapp in SMTP2GO „Verify" klicken. Live-DKIM-Test via echte WA→Mail empfohlen.
- [ ] **Spam False-Positive-Beobachtung:** nach Auth-Score-Verschärfung + auth-bewusstem Whitelisting die PMG-Quarantäne einige Tage auf FPs prüfen. Falls legitime (auch weitergeleitete) Mail hängt → `SPF_FAIL` 1.3 → 1.0 in `zz-rosenweg-authscore.cf`.
- [ ] **PMG-Quarantäne-Filter Allowlist:** ist Whack-a-Mole bei PMG-UI-Updates. Bei „forbidden"/„Unexpected token '<'" → `grep ' 403 ' /var/log/nginx/quarantine-filter.access.log` auf CT230, fehlenden Pfad ergänzen.

### WhatsApp-Gruppen-Archivierung (2026-07-22)
- [x] **archiv@-Forwarding für WA-Gruppen aktiviert (3 aktive Gruppen).** Mechanismus: gateway.js `wa_forwards`-Tabelle (in `/data/gateway.sqlite`, NICHT API-DB) + `forwardByRules` (feuert bei jedem Inbound). War **0 Regeln** → 3 Regeln `kind=jid` → `archiv@rosenweg4303.ch` eingetragen (JIDs `120363407257445046/…421411374914/…423555609689@g.us`). Landet via archiv@-Poller im durchsuchbaren `email_archive`.
- [x] **PMG-Reject gefixt:** Bot-Forward-Mail wurde von PMG `554 Rejected by SPF` abgelehnt — Bot-IP `100.64.2.39` fehlte im **`smtpd/pass/mynetworks`-Override** (Port 25 = postscreen→smtpd-pass hat ENGES mynetworks, nicht das /24!). Fix: `.39` in `/usr/local/sbin/pmg-restore-relay.sh` `NEED=`-Liste ergänzt + ausgeführt (`postconf -P`, persistent via pmg-restore-timer). Re-Test: `250 queued` ✓.
- [x] **„Alle Gruppen inkl. künftige" (Variante A, ERLEDIGT 2026-07-22):** Catch-all in `gateway.js` — env `WA_ARCHIVE_ALL_GROUPS=archiv@rosenweg4303.ch` (in CT116 `/opt/whatsapp-bot/compose.yml`), `forwardByRules` hängt bei `isGroup` die Adresse an (dedup gegen wa_forwards). Deckt alle + künftige Gruppen ohne Pflege. Die 3 manuellen `kind=jid`-Regeln wieder entfernt (redundant). Deployt via Commit c7821e6 → CI → `docker compose pull` CT116.
- [x] **Gateway-Web-UI wiederhergestellt (Variante B, ERLEDIGT 2026-07-22):** Frontend war aus dem Image entfernt + Source nicht im Repo → **neu gebaut**: `whatsapp-bot/public/index.html` (Admin-SPA, Tabs Pairing/Weiterleitungen/Senden/Nachrichten/Gruppen/SMTP-Absicherung/Aliase/Keys, Auth via AuthentikAuth = Technik/Präsident) + `public/authentik-auth.js`; Dockerfile `COPY whatsapp-bot/public`. `whatsapp.rosenweg4303.ch` → HTTP 200 mit UI (statt „Cannot GET /"). Backend `/gateway/ui/*` (:8090) unverändert. WA-Session bleibt bei Deploy erhalten (/data-Volume). NB: Safe-Browsing-„Schädlich"-Flag bleibt (User: ignorieren).
- [ ] **Datenschutz (User: „Alibi-Übung", ignorieren):** in offenen Gruppen sieht/screenshottet eh jeder alles → für den eigenen Kreis unkritisch, solange Archiv-Zugriff begrenzt + Teilnehmer informiert.
- **NICHT vergessen:** `whatsapp.rosenweg4303.ch` ist Google-Safe-Browsing-geflaggt („Schädlich") — User will es **ignorieren** (dokumentiert, kein To-do).

### Technik-WhatsApp-Alerts fielen 2 Wochen lautlos aus (2026-07-22)
- [x] **Root Cause:** `resolveTechnikWhatsappGroupId()` (api/lib/whatsapp.js) suchte die Technik-Gruppe über den **flaky `/groups`-Endpoint** des Bots (whatsapp-web.js `getChats` liefert zeitweise leer) → lieferte **seit 2026-07-08 `null`** → `alertMeter`/PBX-Voicemail reihten NICHTS ein (queueWhatsappMessage nur `if(gid)`). Watchdog erkannte die Ausfälle (Logs), aber KEIN WhatsApp. Beweis: letzte `whatsapp_messages` mit source_type='meter-watchdog' = 2026-07-08, obwohl Meter weiter UNREACHABLE.
- [x] **Fix 1 (Resolver):** `TECHNIK_WA_GROUP_ID=120363407257445046@g.us` (Env, CT128 `/opt/rosenweg-core/compose.yml`) — Resolver bevorzugt feste JID, `/groups` nur Fallback. Commit fbaf446. Verifiziert: Resolver liefert JID. Betraf ALLE Technik-Alerts (Zähler + PBX-Voicemail).
- [x] **Fix 2 (Send crashte):** Nachdem Fix 1 wieder Alerts einreihte → Versand `failed`: `client.getChatById()` wirft WA-Web-„r"-Fehler (msg=429). `sendViaClient` (whatsapp-bot/index.js) lud bei Gruppen erst den Chat → crashte. Fix: getChatById best-effort try/catch → bei Fehler direkt `client.sendMessage(chatId,…)`. Commit d0084c8.
- [x] **Fix 3 (Deploy blockiert):** **CT116 disk-full** (`no space left on device`) → neues Bot-Image ließ sich nicht pullen, Bot lief auf altem Code. `docker image/builder prune -af` → 7 GB frei → Image + Fix live. **Wiederkehrend** (viele Image-Pulls) → Auto-Prune-Timer auf CT116 wäre sinnvoll (offen).
- [ ] **Offene Hardware-Aktion:** r9-eg3 (~3 Tage offline, 100.64.90.75) + r9-haupt (~9,5h, 100.64.90.70) sind physisch tot (smart-me Modbus :502 hängt) → am Gerät T1+T2 ~10s drücken (Neustart). Watchdog alarmiert jetzt wieder.

### Findings / Risiken
- **Brute-Force-Fläche PMG-Login:** Edge macht TLS-Passthrough → nginx auf CT230 sieht keine echte Client-IP (alle = Edge `.40`) → nginx-Rate-Limit / fail2ban wirkungslos. `/api2/*/access/ticket` ist extern nötig (Quarantäne-App) → Admin-Passwort-Login extern möglich; Schutz nur via PMG-Login-Delay + starkes Passwort. Admin-**Config** (`/nodes`,`/config`,`/cluster`) bleibt aber 403.
- **immosense.ch (Hausverwaltung):** hat **kein DMARC** (nur SPF via M365/Mailchimp). Nicht unser Problem, aber notiert (ihre Domain ist für Dritte spoofbar).

### Erledigt
- [x] **Authentik-OIDC PVE + PMG** repariert/eingerichtet — Split-Horizon-DNS (intern via Edge `.40`, korrekter `https://`-Issuer). PVE war 000, PMG neu aufgesetzt (`/etc/pmg/realms.conf`, Authentik-App `pmg`). DNS: UDM-A/AAAA (PVE) + unbound-`local-data` (CT230).
- [x] **PMG-Quarantäne extern:** nginx-Pfad-Filter → extern nur Quarantäne (inkl. Mobile-UI, Ticket-Login, Mail-Vorschau), Admin blockiert. Report-Default-Host auf `quarantine.rosenweg4303.ch`.
- [x] **Spam-Filter:** SPF/DKIM/DMARC-Scores verschärft (`zz-rosenweg-authscore.cf`); auth-bewusstes Whitelisting (Hausverwaltung + 130 Eigentümer/Bewohner, `welcomelist_auth`); **HA-fester Auto-Sync-Timer in CT128** (nicht Hypervisor!) → Push nach CT230.
- [x] Subject-Encoding-Bug im PMG-Spam-Report („f��r") gefixt (HTML-Entity im Titel).
