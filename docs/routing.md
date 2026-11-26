# Routing-Übersicht — Dienste, Adressen, Pfade

Referenz: welcher Dienst hört auf welche Adresse und wie wird durchgeroutet.
Stand: 17.11.2026 (Grundkette, Frontends, Pfade); die Abschnitte ab „DNS für
Web-Routing“ sind vom 6.9.2026. Bei Routing-Fehlern zuerst hier nachsehen.
Sicherheitsregeln für Routen (Freigabe, Konflikte mit eigenen Zonen):
[`sicherheit.md`](sicherheit.md) Abschnitt 4.7.

## Grundkette

```
DNS (Cloudflare) → öffentliche Adresse (public.rosenweg4303.ch) → UDM-DNAT
   → edge-traefik CT 245 (100.64.2.40, TLS) → Frontend-LXC (nginx, HTTP)
   → /api → API CT 128 (100.64.2.52:3000) bzw. offene Energie-Routen → CT 129 (100.64.2.53:3001)
```

- Routen kommen aus zwei Quellen: der Tabelle `isp_reverse_proxy_routes`
  (Pflege in `isp-admin.html`, Sync alle 15 s) und `edge-traefik/extra-routes.yml`
  (fest, von Hand ausgerollt).
- Der frühere Weg CF-Tunnel → Swarm-Traefik (`100.64.2.27`) ist abgebaut.
- Mail (SMTP/IMAP) geht nicht über den Cloudflare-Proxy, sondern per
  TCP-SNI-Router am Edge (siehe unten und `email.md`).

## HTTP-Hosts → Frontend-LXC

| Host | Ziel | Quelle der Route |
|---|---|---|
| `www.rosenweg4303.ch`, `rosenweg4303.ch` | CT 118 `fe-www` `100.64.2.41` | `extra-routes.yml` (`www-lxc-svc`) |
| `isp.rosenweg4303.ch`, `noc.rosenweg4303.ch` | CT 119 `fe-isp` `100.64.2.42` | DB |
| `stweg1..7.rosenweg4303.ch` | CT 120–126 `100.64.2.43–.49` | DB |
| `meg.rosenweg4303.ch` | CT 127 `100.64.2.50` | DB |
| **`rosenweg9.ch`, `www.rosenweg9.ch`** | CT 122 `fe-stweg3` `100.64.2.45` (`$site=stweg3`) | `extra-routes.yml` (`rw9-lxc-svc`) |
| `pwa.rosenweg4303.ch` | CT 130 `fe-pwa` `100.64.2.54` | `extra-routes.yml` (`pwa-lxc-svc`) |
| `whatsapp.rosenweg4303.ch` | CT 116 `http://100.64.2.39:8090` | DB, id=25 |
| `heizung.rosenweg9.ch`, `heizung.rosenweg4303.ch` | ioBroker `100.64.90.50:8082`, **immer** über Authentik | `extra-routes.yml` |
| `contacts.rosenweg4303.ch` | CT 115 `100.64.2.38:443`, TLS-Passthrough | `extra-routes.yml` (TCP) |

## Pfad-Routing innerhalb der Frontends (nginx)

Gilt für `frontends-lxc/nginx/{website,stweg,isp,pwa}.conf`:

| Pfad | Ziel | Notiz |
|---|---|---|
| `/api/energy/{surplus,surplus-available,lametric,shelly,solar-live,tariffs,tariffs/current}` | Collector `rw_energy` (CT 129) | nur diese offenen Geräte-/Anzeige-Routen (seit 17.11.2026) |
| übrige `/api/energy/…` | API `rw_api` (CT 128) | Anmeldung + nur zugeordnete Zähler |
| `/api/` | API `rw_api` (CT 128) | `X-Forwarded-Proto https` fest; Code-Endpunkte gedrosselt (`rw_otp`, 10/Min je IP) |
| `/js/`, `/css/` | gemeinsam, am Docroot | hostunabhängig |
| `/solar` | `/$site/pages/solaranlage-live.html` | Kurz-URL (stweg3/rosenweg9.ch) |
| `/zaehler-technik` | `/$site/pages/zaehler-technik.html` | nur stweg3 |
| `/data/`, `*.md`, `*.json` (ausser Freigaben), `.alt` … | 404 | Sperrregeln, siehe `frontends-lxc/README.md` |
| sonst nicht gefunden (stweg) | **`@www_fallback` → 302 `www.rosenweg4303.ch$uri`** | erklärt „landet auf Hauptseite“ bei unbekannten Pfaden |

> **Debug-Tipp:** „wird auf rosenweg4303.ch umgeleitet“ = entweder der Pfad fällt
> in `@www_fallback` (serverseitig, mit curl reproduzierbar) ODER ein
> **gespeicherter 301/302 im Browser** (curl bekommt 200, Browser leitet um →
> privates Fenster testen).

## Mail (direkt, nicht CF)
| Zweck | Endpoint | Backend |
|---|---|---|
| Submission Roamer | `smtp.rosenweg9.ch:587/465` | Router-DNAT → PMG (.31) bzw. Traefik-SNI-Passthrough |
| IMAP Roamer | `imap.rosenweg9.ch:993` | → Mailcow (CT 240) |
| Mailcow-Web/Autoconfig | `mailcow.rosenweg9.ch`, `personen.rosenweg4303.ch` | CT 240 |
| PMG / Quarantäne | `pmg.rosenweg4303.ch`, `quarantine.rosenweg9.ch` | CT 230 (.31) |
| WhatsApp-Inbound | `MX whatsapp.rosenweg4303.ch` → PMG → Transport `intern:[100.64.2.39]:2525` | CT 116; 2525 nur von PMG (IPv4+IPv6), Empfänger nur Aliase |

## Weitere LXC-Dienste
| Dienst | CT / IP | Host |
|---|---|---|
| Mailcow | CT 240 / .33 | mailcow.rosenweg9.ch |
| PMG | CT 230 / .31 | pmg.rosenweg4303.ch |
| WhatsApp-Bridge | CT 116 / .39 | whatsapp.rosenweg4303.ch |
| Z-Push (Kontakte) | CT 115 / .38 | contacts.rosenweg4303.ch (Zertifikat abgelaufen, offener Punkt) |
| Nextcloud | CT 104 / .36 | (eigenes LXC) |
| Authentik (SSO) | CT 114 / .37 | OAuth/OIDC für alle Frontends |
| PBX | CT 220 / .55 (pve3) | pbx.rosenweg4303.ch |

## Entfernt
- **NetBox** (`netbox.rosenweg4303.ch`) — Stack am 2026-06-19 entfernt (Crash-Loop → Ceph-Stall). Kachel in `netzwerk.html` + DNS + PVE-Token `netbox@pam!collector` noch aufzuräumen.

## DNS für Web-Routing: CNAME statt IP

Wer eine Reverse-Proxy-Route oder eine Weiterleitung anlegt, muss seinen
Namen auf uns zeigen lassen. Empfohlen wird ein **CNAME auf
`public.rosenweg4303.ch`** — und zwar mit Grund: Unsere öffentliche Adresse
ist dynamisch. Ein CNAME folgt ihr von selbst; wer die IP fest einträgt, hat
sie mehrfach in seiner Zone stehen und muss bei jedem Wechsel jeden Eintrag
einzeln nachziehen.

`public.rosenweg4303.ch` trägt in Cloudflare den Kommentar «Public IP for own
reverse proxy / PMG MX» und ist der Name, den auch der DynDNS-Endpunkt
(`/api/cf-ddns?hostname=public`) nachführt. Der ältere
`kooperation.rosenweg4303.ch` zeigt aufs selbe Ziel und bleibt gültig.

`ispCheckDns` unterscheidet vier Fälle und sagt jeweils, was zu tun ist:

| `trifft_ueber` | Bedeutung |
|---|---|
| `cname` | CNAME auf `public.…` — das Ideal |
| `cname_indirekt` | CNAME auf einen anderen unserer Namen (z. B. `kooperation.…`). In Ordnung, Umhängen optional |
| `a` / `aaaa` | Zeigt korrekt, aber über einen festen Eintrag — hier wird der CNAME empfohlen |
| `null` | Zeigt nicht auf uns |

An der **Zonenwurzel** ist kein CNAME erlaubt; dort nennt die Prüfung die
aktuelle Adresse zum Eintragen und sagt, dass sie von Hand nachgezogen
werden muss.

### Zwei Fallen, in die die Prüfung selbst getappt ist (6.9.2026)

**Sie kannte unsere eigene Adresse nicht.** `ROSENWEG_PUBLIC_IPV4/_IPV6` sind
nicht gesetzt, also konnte sie nur einen CNAME auf exakt `public.…`
erkennen — jeder A-Record und jeder CNAME auf einen anderen unserer Namen
galt als «zeigt nicht auf uns». Sie löst die Adresse jetzt aus
`cname_target` auf; eine zweite Stelle mit derselben IP braucht es nicht,
dasselbe Argument wie für den CNAME der Nutzer.

**Sie fragte den falschen Resolver.** Das interne DNS ist geteilt:
`kooperation.rosenweg4303.ch` zeigt drinnen auf `100.64.2.40`, draussen auf
`37.17.232.133`. Im Container gefragt, galt `isp.rosenweg4303.ch` als
fehlerhaft. Die Prüfung fragt jetzt `1.1.1.1`/`8.8.8.8` — die Frage lautet ja,
was die Welt sieht — mit Rückfall auf den System-Resolver, der im Ergebnis
vermerkt wird.

### Namen in unseren eigenen Zonen: automatisch

Die Anwendung hat Cloudflare-Zugang und verwaltet die Zonen
`rosenweg4303.ch` und `rosenweg9.ch`. Liegt der Hostname einer Route dort,
muss ihn niemand von Hand eintragen — im DNS-Dialog erscheint **«DNS jetzt
einrichten»**, und der Server legt den CNAME auf `public.rosenweg4303.ch`
an, prüft sofort nach und schaltet die Route frei.

Zwei Grenzen mit Absicht:

- **Ein vorhandener Eintrag wird nie überschrieben.** Er könnte zu einem
  Dienst gehören, von dem die Route nichts weiss. Der Server meldet
  stattdessen, was dort steht (`Es gibt bereits einen Eintrag — den fassen
  wir nicht an`).
- **`proxied = false` als Vorgabe**, aber frei wählbar. Auf die Zertifikate
  hat das keinen Einfluss: Traefik holt sie per DNS-Challenge über Cloudflare
  (`certificatesResolvers.cf.acme.dnsChallenge`), nicht über den Namen selbst
  — `mcp.` und `noc.` laufen proxied und haben gültige Zertifikate. Der
  Unterschied liegt woanders: proxied verbirgt unsere Adresse und bringt
  Cloudflares Schutz mit, begrenzt aber Uploads und puffert lange
  Verbindungen; ohne Proxy geht es direkt an unseren Edge, ohne Grössen- oder
  Protokollgrenzen, dafür ist die Adresse sichtbar. Für beliebige
  Nutzerdienste ist «ohne» die überraschungsärmere Vorgabe.

### Proxied-Einträge waren ein blinder Fleck

Bei `proxied = true` verbirgt Cloudflare den CNAME und antwortet mit eigenen
Adressen. Eine Prüfung über öffentliches DNS sieht dann weder unseren
Zielnamen noch unsere IP. Am 6.9.2026 galten `noc.`, `mcp.` und `chat.`
darum als «zeigt nicht auf uns», obwohl alle drei tadellos laufen.

Für Namen in unseren Zonen fragt `ispCheckDns` jetzt **Cloudflare direkt**
(`trifft_ueber = 'cloudflare'`, dazu `proxied`), statt aus dem öffentlichen
DNS zu raten. Für fremde Domains bleibt es beim öffentlichen Resolver — dort
ist das die einzige Wahrheit, die zählt.

## Wem ein Eintrag gehört

Reverse-Proxy-Routen, Weiterleitungen und Mail-Relays haben neben
`owner_email` eine Spalte **`owner_group`**. Ist sie gesetzt, gehört der
Eintrag der Gruppe: Wer darin ist, sieht und ändert ihn, und beim Wechsel der
Zuständigkeit wandert er mit — statt an der Adresse dessen zu hängen, der ihn
einmal angelegt hat. Beim Anlegen wählt man im Dialog «mir persönlich» oder
eine Gruppe, in der man selbst ist; eine fremde Gruppe lehnt der Server ab.

Aufgeräumt am 6.9.2026. Vorher standen vier Konventionen nebeneinander:

| vorher | nachher |
|---|---|
| Platzhalter `owner_email = 'system'` (19) | `owner_group = 'technik'` |
| `owner_email = 'technik@rosenweg4303.ch'` (1) | `owner_group = 'technik'` |
| ohne Besitzer (9: `mcp.`, `meg.`, `stweg1–7`) | `owner_group = 'technik'` |
| persönlich auf Stefans Adresse (2) | `whatsapp.` → technik, `test.` bleibt persönlich |
| Mail-Relays auf einer privaten Gmail-Adresse (2) | alle drei `owner_group = 'technik'` |

Der letzte Punkt war der unangenehmste: Zwei Mail-Relays der Siedlung hingen
an einer privaten Gmail-Adresse.

### Falle beim Erweitern des Schemas

Die Spalten kamen über `ALTER TABLE … ADD COLUMN IF NOT EXISTS` **innerhalb**
eines bestehenden `DO`-Blocks. Ein eigener verschachtelter `DO`-Block geht
nicht: Das innere Dollar-Anführungspaar beendet das äussere, und die
Schema-Initialisierung scheitert — die API startet dann gar nicht mehr. Das
gilt auch für ein Dollar-Paar in einem `--`-Kommentar, denn innerhalb eines
dollar-quotierten Blocks ist alles nur Text. Beides ist an diesem Tag
nacheinander passiert.

Wiederherstellung im Ernstfall, ohne auf einen neuen Build zu warten — jeder
Commit liegt in der Registry unter seiner SHA:

```bash
pct exec 128 -- bash -c 'cd /opt/rosenweg-core
  docker pull ghcr.io/rosenweg/rosenweg-api:<letzte-gute-sha>
  docker tag ghcr.io/rosenweg/rosenweg-api:<sha> ghcr.io/rosenweg/rosenweg-api:latest
  docker compose up -d api'
```
