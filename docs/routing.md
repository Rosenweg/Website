# Routing-Übersicht — Dienste, Adressen, Pfade

Referenz: welcher Dienst hört auf welche Adresse und wie wird durchgeroutet.
Stand: 2026-06-19. Bei Routing-Bugs zuerst hier nachsehen.

## Grundkette
```
DNS (Cloudflare) → CF-Tunnel ODER direkter A-Record → Traefik (Swarm-VIP 100.64.2.27)
   → Service (nginx im Container) → ggf. Proxy zu api / collector
```
- **CF-proxied** (orange): die meisten HTTP-Hosts laufen über den **CF-Tunnel** auf den Swarm.
- **Direkt** (grau/A-Record): Mail (SMTP/IMAP) — CF kann kein SMTP/IMAP → A direkt auf 37.17.232.133, Router-DNAT.

## HTTP-Hosts → Swarm-Service (Traefik Host-Regeln)
| Host | Service / Image | Notiz |
|---|---|---|
| `www.rosenweg4303.ch`, `rosenweg4303.ch` | `rosenweg_website` (rosenweg-website) | Hauptseite |
| `isp.rosenweg4303.ch` | `rosenweg_isp` (rosenweg-isp) | CF-Tunnel **direkt** auf `tasks.rosenweg_isp:80` (NICHT über Traefik:80 → sonst Redirect-Loop) |
| `stweg1..7.rosenweg4303.ch`, `meg.rosenweg4303.ch` | `stweg1..7` / `meg` (rosenweg-stweg) | ein Image, `$site`-Map in `nginx.stweg.conf` wählt docroot |
| **`rosenweg9.ch`, `www.rosenweg9.ch`** | **`stweg3`** (rosenweg-stweg) | STWEG-3-Eigendomain → `$site=stweg3` |
| `noc.rosenweg4303.ch` | `noc` | Monitoring |
| `whatsapp.rosenweg4303.ch` | **CT 116 (.39)** — NICHT mehr Swarm | Route `isp_reverse_proxy_routes` id=25 → `http://100.64.2.39:8090` |

## Pfad-Routing innerhalb der Frontends (nginx)
Gilt für stweg/website/isp-nginx (`nginx.stweg.conf`, `nginx.conf`, `nginx.isp.conf`):
| Pfad | Ziel | Notiz |
|---|---|---|
| `/api/energy/` | `energy-collector:3001` | **muss VOR** `/api/` stehen (längeres `^~`-Prefix gewinnt) |
| `/api/` | `api:3000` (rosenweg_api) | `X-Forwarded-Proto https` hardcoded |
| `/js/`, `/css/` | shared, am html-Root | host-unabhängig |
| `/solar` | `/$site/pages/solaranlage-live.html` | Kurz-URL (stweg3/rosenweg9.ch) |
| `/zaehler-technik` | `/$site/pages/zaehler-technik.html` | nur stweg3 |
| sonst nicht gefunden | **`@www_fallback` → 302 `www.rosenweg4303.ch$uri`** | erklärt „landet auf Hauptseite" bei unbekannten Pfaden |

> **Debug-Tipp:** „wird auf rosenweg4303.ch umgeleitet" = entweder der Pfad fällt in `@www_fallback` (serverseitig, mit curl reproduzierbar) ODER ein **gecachter 301/302 im Browser** (curl bekommt 200, Browser leitet um → Inkognito testen).

## Mail (direkt, nicht CF)
| Zweck | Endpoint | Backend |
|---|---|---|
| Submission Roamer | `smtp.rosenweg9.ch:587/465` | Router-DNAT → PMG (.31) bzw. Traefik-SNI-Passthrough |
| IMAP Roamer | `imap.rosenweg9.ch:993` | → Mailcow (CT 240) |
| Mailcow-Web/Autoconfig | `mailcow.rosenweg9.ch`, `personen.rosenweg4303.ch` | CT 240 |
| PMG / Quarantäne | `pmg.rosenweg4303.ch`, `quarantine.rosenweg9.ch` | CT 230 (.31) |
| WhatsApp-Inbound | `MX whatsapp.rosenweg4303.ch` → PMG → Transport `smtp:[100.64.2.39]:2525` | CT 116 |

## LXC-Dienste (außerhalb Swarm)
| Dienst | CT / IP | Host |
|---|---|---|
| Mailcow | CT 240 | mailcow.rosenweg9.ch |
| PMG | CT 230 / .31 | pmg.rosenweg4303.ch |
| WhatsApp-Bridge | CT 116 / .39 | whatsapp.rosenweg4303.ch |
| Z-Push (Kontakte) | CT 115 | contacts.rosenweg4303.ch |
| Nextcloud | CT 104 / .36 | (eigenes LXC) |
| Authentik (SSO) | CT 114 | OAuth/OIDC für alle Frontends |
| PBX | — | pbx.rosenweg4303.ch |

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
- **`proxied = false`.** Traefik holt sein Let's-Encrypt-Zertifikat über
  genau diesen Namen; hinter Cloudflares Proxy terminiert Cloudflare TLS.

### Proxied-Einträge waren ein blinder Fleck

Bei `proxied = true` verbirgt Cloudflare den CNAME und antwortet mit eigenen
Adressen. Eine Prüfung über öffentliches DNS sieht dann weder unseren
Zielnamen noch unsere IP. Am 6.9.2026 galten `noc.`, `mcp.` und `chat.`
darum als «zeigt nicht auf uns», obwohl alle drei tadellos laufen.

Für Namen in unseren Zonen fragt `ispCheckDns` jetzt **Cloudflare direkt**
(`trifft_ueber = 'cloudflare'`, dazu `proxied`), statt aus dem öffentlichen
DNS zu raten. Für fremde Domains bleibt es beim öffentlichen Resolver — dort
ist das die einzige Wahrheit, die zählt.
