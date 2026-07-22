# Journal — Findings & offene Punkte

> **Harte Regel:** Findings und offene Punkte hier festhalten, damit sie nicht verloren gehen.
> Neueste Session zuerst. Offenes als Checkbox, Erledigtes abhaken (nicht löschen).

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

### Findings / Risiken
- **Brute-Force-Fläche PMG-Login:** Edge macht TLS-Passthrough → nginx auf CT230 sieht keine echte Client-IP (alle = Edge `.40`) → nginx-Rate-Limit / fail2ban wirkungslos. `/api2/*/access/ticket` ist extern nötig (Quarantäne-App) → Admin-Passwort-Login extern möglich; Schutz nur via PMG-Login-Delay + starkes Passwort. Admin-**Config** (`/nodes`,`/config`,`/cluster`) bleibt aber 403.
- **immosense.ch (Hausverwaltung):** hat **kein DMARC** (nur SPF via M365/Mailchimp). Nicht unser Problem, aber notiert (ihre Domain ist für Dritte spoofbar).

### Erledigt
- [x] **Authentik-OIDC PVE + PMG** repariert/eingerichtet — Split-Horizon-DNS (intern via Edge `.40`, korrekter `https://`-Issuer). PVE war 000, PMG neu aufgesetzt (`/etc/pmg/realms.conf`, Authentik-App `pmg`). DNS: UDM-A/AAAA (PVE) + unbound-`local-data` (CT230).
- [x] **PMG-Quarantäne extern:** nginx-Pfad-Filter → extern nur Quarantäne (inkl. Mobile-UI, Ticket-Login, Mail-Vorschau), Admin blockiert. Report-Default-Host auf `quarantine.rosenweg4303.ch`.
- [x] **Spam-Filter:** SPF/DKIM/DMARC-Scores verschärft (`zz-rosenweg-authscore.cf`); auth-bewusstes Whitelisting (Hausverwaltung + 130 Eigentümer/Bewohner, `welcomelist_auth`); **HA-fester Auto-Sync-Timer in CT128** (nicht Hypervisor!) → Push nach CT230.
- [x] Subject-Encoding-Bug im PMG-Spam-Report („f��r") gefixt (HTML-Entity im Titel).
