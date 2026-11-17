# WhatsApp-Gateway — Daten-Konfiguration (`gateway.sqlite` auf CT 116)

Stand: 17.11.2026.

Wer per **Mail→WhatsApp** senden darf und welche Mail-Adresse auf welche
WhatsApp-Gruppe/Nummer mappt, liegt als **Daten** in `/data/gateway.sqlite`
(CT 116) — nicht im Code. Verwaltbar über das Gateway-Web-UI
(`whatsapp.rosenweg4303.ch`) oder direkt per SQL. Dieser Soll-Zustand dient zur
Reproduktion bei Neuaufbau.

## `smtp_senders` — erlaubte Absender (Mail→WhatsApp)

Regeln seit dem 17.11.2026 (Einzelheiten in [`../README.md`](../README.md#mail--whatsapp-smtp-2525)):

- Eine Quell-IP aus `smtp_ips` genügt **nur**, wenn sie keine strenge Quelle ist.
  Strenge Quellen stehen in `GW_SMTP_STRENG_IPS` (Standard PMG `100.64.2.31`),
  weil über sie auch Mail aus dem Internet kommt.
- Von einer strengen Quelle muss der Envelope-Absender in `smtp_senders` stehen,
  und Empfänger dürfen **nur Aliase** (Tabelle `aliases`) sein – keine freien
  Nummern, Gruppennamen oder JIDs. Fehler: `554 Quell-IP oder Absender nicht
  erlaubt` bzw. `550 Empfaenger nicht erlaubt`.
- Ausnahme: Eine Antwort an `<nummer>@whatsapp.rosenweg4303.ch` (Reply-To einer
  WhatsApp→Mail-Weiterleitung) wird angenommen, wenn genau dieser Absender
  zuletzt per Mail an diese Nummer geschrieben hat oder als Empfänger einer
  Regel in `wa_forwards` für diese Nummer steht, und in `smtp_senders` steht.
- Einträge: exakte Adresse oder ganze Domain (`@domain`). Eine Domain deckt
  **keine** Subdomains ab.
- Port 2525 ist ausserdem per nftables nur für PMG offen (IPv4 und IPv6).

Pflege über die Web-Oberfläche `whatsapp.rosenweg4303.ch` (nur Technik/Präsident)
oder per SQL wie unten.

| addr | Zweck |
|---|---|
| `@rosenweg4303.ch` | interne Absender |
| `@rosenweg9.ch` | interne Absender |
| `@juroct.net` | Test/Admin |
| `<private-admin-adresse>` | Admin (private Adresse; ob sie bleiben soll, ist offen – `docs/sicherheit.md` Abschnitt 7.3) |
| `@em1102430.rosenweg4303.ch` | **SMTP2GO-Return-Path.** Website-Verteiler-Sends (rosenweg_api) laufen über SMTP2GO, das den Envelope-Absender auf diese **Subdomain** umschreibt. `@rosenweg4303.ch` deckt die Subdomain NICHT ab → ohne diesen Eintrag bounced der Gateway die Verteiler→WhatsApp-Mails mit `554 Quell-IP oder Absender nicht erlaubt`. |

## `smtp_ips` — erlaubte Quell-IPs
| ip | Zweck |
|---|---|
| `100.64.2.33` | Mailcow (Inbound-Verteiler-Fanout über die Mailcow-Alias-Expansion) |
| `100.64.2.31` | PMG — Mailcow stellt `*@whatsapp.rosenweg4303.ch` über den PMG-Transport zu, jede Verteiler→WhatsApp-Mail kommt also von hier (Stand 24.10.2026, `ausschuss-verwaltung@`) |

PMG `.31` steht drin, weil die Zustellung an `whatsapp.rosenweg4303.ch` über den
PMG-Transport läuft. Seit dem 17.11.2026 gilt PMG aber als **strenge Quelle**:
Der Eintrag allein lässt keine Mail mehr durch, der Absender muss zusätzlich in
`smtp_senders` stehen, und Empfänger sind nur Aliase. Bis dahin ging jede über
PMG an eine Brückenadresse relayte Mail nach WhatsApp, auch an frei gewählte
Nummern. Weiterhin wirken davor die Verteiler-Gates in Mailcow (rspamd).

Mailcow `.33` ist keine strenge Quelle und würde allein über die IP angenommen.
Seit der nftables-Regel vom 17.11.2026 erreicht Mailcow Port 2525 aber gar nicht
mehr direkt (nur PMG darf verbinden); der Eintrag ist damit ohne Wirkung und kann
bleiben.

## `aliases` — Mail-Local-Part → WhatsApp-Ziel
`<address>@whatsapp.rosenweg4303.ch` → Ziel. `target_kind`: `group` (per Gruppenname) | `number` | `jid`.

| address | target | kind |
|---|---|---|
| `technik` | Rosenweg Technik | group |
| `ausschuss` | Rosenweg Ausschuss | group |
| `rosenweg9` | Rosenweg 9 | group |
| `allgemein` | Allgemein | group |
| `stefan` | <private-mobilnummer> | number |
| `stefan-test` | Rosenweg (Test 2P) | group |

## `wa_forwards` — WhatsApp → Mail (Inbound-Routing)
Aktuell leer.

## Seed bei Neuaufbau
```sh
pct exec 116 -- docker exec -i whatsapp-bot node - <<'EOF'
const db = require('better-sqlite3')('/data/gateway.sqlite');
const now = new Date().toISOString();
const sender = db.prepare("INSERT OR IGNORE INTO smtp_senders (addr,note,created_by,created_at) VALUES (?,?,?,?)");
for (const s of ['@rosenweg4303.ch','@rosenweg9.ch','@juroct.net','<private-admin-adresse>','@em1102430.rosenweg4303.ch'])
  sender.run(s, 'seed', 'iac', now);
db.prepare("INSERT OR IGNORE INTO smtp_ips (ip,note,created_by,created_at) VALUES (?,?,?,?)").run('100.64.2.33', 'Mailcow', 'iac', now);
db.prepare("INSERT OR IGNORE INTO smtp_ips (ip,note,created_by,created_at) VALUES (?,?,?,?)").run('100.64.2.31', 'PMG-Transport', 'iac', now);
const alias = db.prepare("INSERT INTO aliases (address,target,target_kind,note,created_by,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET target=excluded.target, target_kind=excluded.target_kind");
for (const [a,t,k] of [['technik','Rosenweg Technik','group'],['ausschuss','Rosenweg Ausschuss','group'],['rosenweg9','Rosenweg 9','group'],['allgemein','Allgemein','group'],['stefan','<private-mobilnummer>','number']])
  alias.run(a, t, k, 'seed', 'iac', now);
console.log('gateway-data seeded');
EOF
```
