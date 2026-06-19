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
