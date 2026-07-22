# Journal — Findings & offene Punkte

> **Harte Regel:** Findings und offene Punkte hier festhalten, damit sie nicht verloren gehen.
> Neueste Session zuerst. Offenes als Checkbox, Erledigtes abhaken (nicht löschen).

---

## 2026-07-22

### Offen
- [ ] **Outbound-SPF-Lücke (Fallback):** `rosenweg9.ch` und `personen.rosenweg4303.ch` haben `include:spf.smtp2go.com` **nicht** im SPF (nur `rosenweg4303.ch`). Fällt der Relay-VPS (`smtp-relay.rosenweg4303.ch`, opendkim Selector `relay`) aus und PMG weicht auf SMTP2GO aus → **SPF + DKIM fehlschlagen → DMARC-Fail** für diese 2 Domains. Fix: SPF-Include + SMTP2GO-DKIM für beide, oder bestätigen dass Fallback für sie nie genutzt wird.
- [ ] **SMTP2GO-DKIM `rosenweg4303.ch`:** CNAMEs `s1/s2/em._domainkey` aktuell **nicht auffindbar** — Selector prüfen / ob noch nötig (Relay ist jetzt primär, SMTP2GO nur Fallback). Historie: mail-tester war mal 10/10.
- [ ] **`whatsapp.rosenweg4303.ch`:** hat keine eigenen SPF/DMARC-Records. OK **nur solange** die WhatsApp-Bridge als `@rosenweg4303.ch` sendet — tatsächlichen From verifizieren; falls `@whatsapp.rosenweg4303.ch`, eigene SPF+DKIM nötig.
- [ ] **Spam False-Positive-Beobachtung:** nach Auth-Score-Verschärfung + auth-bewusstem Whitelisting die PMG-Quarantäne einige Tage auf FPs prüfen. Falls legitime (auch weitergeleitete) Mail hängt → `SPF_FAIL` 1.3 → 1.0 in `zz-rosenweg-authscore.cf`.
- [ ] **PMG-Quarantäne-Filter Allowlist:** ist Whack-a-Mole bei PMG-UI-Updates. Bei „forbidden"/„Unexpected token '<'" → `grep ' 403 ' /var/log/nginx/quarantine-filter.access.log` auf CT230, fehlenden Pfad ergänzen.

### Findings / Risiken
- **Brute-Force-Fläche PMG-Login:** Edge macht TLS-Passthrough → nginx auf CT230 sieht keine echte Client-IP (alle = Edge `.40`) → nginx-Rate-Limit / fail2ban wirkungslos. `/api2/*/access/ticket` ist extern nötig (Quarantäne-App) → Admin-Passwort-Login extern möglich; Schutz nur via PMG-Login-Delay + starkes Passwort. Admin-**Config** (`/nodes`,`/config`,`/cluster`) bleibt aber 403.
- **immosense.ch (Hausverwaltung):** hat **kein DMARC** (nur SPF via M365/Mailchimp). Nicht unser Problem, aber notiert (ihre Domain ist für Dritte spoofbar).

### Erledigt
- [x] **Authentik-OIDC PVE + PMG** repariert/eingerichtet — Split-Horizon-DNS (intern via Edge `.40`, korrekter `https://`-Issuer). PVE war 000, PMG neu aufgesetzt (`/etc/pmg/realms.conf`, Authentik-App `pmg`). DNS: UDM-A/AAAA (PVE) + unbound-`local-data` (CT230).
- [x] **PMG-Quarantäne extern:** nginx-Pfad-Filter → extern nur Quarantäne (inkl. Mobile-UI, Ticket-Login, Mail-Vorschau), Admin blockiert. Report-Default-Host auf `quarantine.rosenweg4303.ch`.
- [x] **Spam-Filter:** SPF/DKIM/DMARC-Scores verschärft (`zz-rosenweg-authscore.cf`); auth-bewusstes Whitelisting (Hausverwaltung + 130 Eigentümer/Bewohner, `welcomelist_auth`); **HA-fester Auto-Sync-Timer in CT128** (nicht Hypervisor!) → Push nach CT230.
- [x] Subject-Encoding-Bug im PMG-Spam-Report („f��r") gefixt (HTML-Entity im Titel).
