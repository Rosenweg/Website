# Email-System — Rosenweg

## Übersicht

```
Absender
    │
    ▼
Cloudflare Email Routing (MX)
    │
    ▼
Gmail (rosenweg4303@gmail.com)
    │
    ▼ IMAP Polling (alle 60s)
API Server
    ├── Verteiler-Mails → DB + Weiterleitung via SMTP2GO
    ├── DMARC Reports → Gmail DMARC-Ordner
    └── Archiv-Mails → DB + Gmail Archiv-Ordner
```

## Inbound

### Cloudflare Email Routing
- **MX Records**: `route1/2/3.mx.cloudflare.net`
- **Catch-All**: Weiterleitung an `rosenweg4303@gmail.com`
- Cloudflare empfängt alle Mails an `*@rosenweg4303.ch`

### Gmail
- **Konto**: `rosenweg4303@gmail.com`
- **App-Passwort**: `ykst kwwe kakp tqjn`
- **IMAP**: `imap.gmail.com:993` (TLS)

### IMAP-Polling (API Server)
Der API Server pollt Gmail alle 60 Sekunden und verarbeitet:

1. **Verteiler-Mails**: Erkennung via Plus-Tag (`rosenweg4303+ausschuss@gmail.com` → `ausschuss@rosenweg4303.ch`) oder `To:`-Header
2. **DMARC-Reports**: `dmarc@rosenweg4303.ch` → In Gmail DMARC-Ordner verschieben
3. **Archiv-Mails**: `archiv@rosenweg4303.ch` → In DB speichern + Gmail Archiv-Ordner

### Gmail-Ordner
| Ordner | Inhalt |
|--------|--------|
| INBOX | Unverarbeitete Mails |
| DMARC | DMARC-Reports (107+ Mails) |
| Archiv | Archivierte Mails |
| Verteiler/ausschuss | Ausschuss-Mails |
| Verteiler/technik | Technik-Mails |
| Verteiler/praesident | Präsident-Mails |
| Verteiler/_unbekannt | Unbekannte Verteiler |
| Verteiler/_sonstige | Sonstige |

## Outbound

### SMTP2GO
- **Host**: `mail-eu.smtp2go.com`
- **Port**: 2525 (STARTTLS)
- **User**: `rk-website`
- **Passwort**: `BvyLJUzXJVbFbo57`
- **From**: `noreply@rosenweg4303.ch`
- **API Key**: `api-44D0ACBD9BEE4EE48BA219A0DEE9C005`

### Verwendung
- Verteiler-Weiterleitung (API)
- Authentik Benachrichtigungen (Passwort-Reset, etc.)
- System-Mails (Registrierung, etc.)

## DNS Records

| Record | Wert | Beschreibung |
|--------|------|-------------|
| SPF | `v=spf1 include:_spf.mx.cloudflare.net include:spf.smtp2go.com ~all` | Erlaubte Sender |
| DMARC | `p=quarantine; adkim=s; aspf=s` | Policy: Quarantäne bei Fail |
| DKIM (CF) | `cf2024-1._domainkey` | Cloudflare DKIM |
| DKIM (SMTP2GO) | `s1102430._domainkey → dkim.smtp2go.net` | SMTP2GO DKIM |
| DKIM (Legacy) | `dkim._domainkey` | Alter DKIM Key |
| Return Path | `em1102430 → return.smtp2go.net` | SMTP2GO Bounce-Handling |
| Tracking | `link → track.smtp2go.net` | SMTP2GO Link-Tracking |

## DMARC-Reports

- **107+ Reports** von Google und Microsoft
- Werden automatisch in Gmail DMARC-Ordner verschoben
- Abruf via `/api/dmarc/reports` (Admin)
- Parsing: ZIP/GZ Attachments → XML → strukturierte Daten

## Verteiler-Adressen

| Adresse | Beschreibung |
|---------|-------------|
| ausschuss@rosenweg4303.ch | Verwaltungsausschuss |
| technik@rosenweg4303.ch | Technik-Gruppe |
| praesident@rosenweg4303.ch | Präsident |
| dmarc@rosenweg4303.ch | DMARC-Reports (automatisch) |
| archiv@rosenweg4303.ch | Email-Archiv (automatisch) |

## Geplant: Proxmox Mail Gateway + Mailcow

Siehe [plans/proxmox-mail-gateway.md](plans/proxmox-mail-gateway.md)

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
