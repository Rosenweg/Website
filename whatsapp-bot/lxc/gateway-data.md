# WhatsApp-Gateway — Daten-Konfiguration (`gateway.sqlite` auf CT 116)

Wer per **Mail→WhatsApp** senden darf und welche Mail-Adresse auf welche
WhatsApp-Gruppe/Nummer mappt, liegt als **Daten** in `/data/gateway.sqlite`
(CT 116) — nicht im Code. Verwaltbar über das Gateway-Web-UI
(`whatsapp.rosenweg4303.ch`) oder direkt per SQL. Dieser Soll-Zustand dient zur
Reproduktion bei Neuaufbau.

## `smtp_senders` — erlaubte Absender (Mail→WhatsApp)
Annahme, wenn **Quell-IP (`smtp_ips`) ODER Absender (`smtp_senders`)** gewhitelistet
ist. Absender per exakter Adresse ODER ganzer Domain (`@domain`, **kein** Subdomain-Match).

| addr | Zweck |
|---|---|
| `@rosenweg4303.ch` | interne Absender |
| `@rosenweg9.ch` | interne Absender |
| `@juroct.net` | Test/Admin |
| `stefan.mueller.1694@gmail.com` | Admin |
| `@em1102430.rosenweg4303.ch` | **SMTP2GO-Return-Path.** Website-Verteiler-Sends (rosenweg_api) laufen über SMTP2GO, das den Envelope-Absender auf diese **Subdomain** umschreibt. `@rosenweg4303.ch` deckt die Subdomain NICHT ab → ohne diesen Eintrag bounced der Gateway die Verteiler→WhatsApp-Mails mit `554 Quell-IP oder Absender nicht erlaubt`. |

## `smtp_ips` — erlaubte Quell-IPs
| ip | Zweck |
|---|---|
| `100.64.2.33` | Mailcow (Inbound-Verteiler-Fanout über die Mailcow-Alias-Expansion) |

PMG `.31` bewusst **NICHT** — wäre zu offen (jede über PMG relayte Mail an einen
Alias-Empfänger ginge an WhatsApp = Spoofing-Tür). Darum der gezielte Sender-Eintrag.

## `aliases` — Mail-Local-Part → WhatsApp-Ziel
`<address>@whatsapp.rosenweg4303.ch` → Ziel. `target_kind`: `group` (per Gruppenname) | `number` | `jid`.

| address | target | kind |
|---|---|---|
| `technik` | Rosenweg Technik | group |
| `ausschuss` | Rosenweg Ausschuss | group |
| `rosenweg9` | Rosenweg 9 | group |
| `allgemein` | Allgemein | group |
| `stefan` | +41765199970 | number |
| `stefan-test` | Rosenweg (Test 2P) | group |

## `wa_forwards` — WhatsApp → Mail (Inbound-Routing)
Aktuell leer.

## Seed bei Neuaufbau
```sh
pct exec 116 -- docker exec -i whatsapp-bot node - <<'EOF'
const db = require('better-sqlite3')('/data/gateway.sqlite');
const now = new Date().toISOString();
const sender = db.prepare("INSERT OR IGNORE INTO smtp_senders (addr,note,created_by,created_at) VALUES (?,?,?,?)");
for (const s of ['@rosenweg4303.ch','@rosenweg9.ch','@juroct.net','stefan.mueller.1694@gmail.com','@em1102430.rosenweg4303.ch'])
  sender.run(s, 'seed', 'iac', now);
db.prepare("INSERT OR IGNORE INTO smtp_ips (ip,note,created_by,created_at) VALUES (?,?,?,?)").run('100.64.2.33', 'Mailcow', 'iac', now);
const alias = db.prepare("INSERT INTO aliases (address,target,target_kind,note,created_by,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET target=excluded.target, target_kind=excluded.target_kind");
for (const [a,t,k] of [['technik','Rosenweg Technik','group'],['ausschuss','Rosenweg Ausschuss','group'],['rosenweg9','Rosenweg 9','group'],['allgemein','Allgemein','group'],['stefan','+41765199970','number']])
  alias.run(a, t, k, 'seed', 'iac', now);
console.log('gateway-data seeded');
EOF
```
