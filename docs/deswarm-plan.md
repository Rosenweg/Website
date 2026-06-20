# De-Swarm-Migrationsplan — api + Frontends raus aus Docker Swarm in LXCs

## Warum
Docker-Swarm-**Overlay auf LXC** ist die Wurzel der wiederkehrenden 502/504/Flap-Probleme:
auf LXC erben die Container-netns das Host-`ip_forward` nicht, dazu kommen ipvs-/VXLAN-FDB-
Races bei Task-Reschedules. Der `docker-ipvs-fix` ist nur ein Pflaster. **Nextcloud (CT104),
Authentik (CT114), WhatsApp-Bridge (CT116)** sind bereits erfolgreich aus dem Swarm in eigene
LXCs gezogen — der Rest ist der logische nächste Schritt. Ergebnis: **direkte LXC-IPs, kein
VXLAN, kein Overlay-Race, einfacheres Routing** über die edge-traefik (CT245).

## Prinzipien
- Jeder Dienst (oder logische Gruppe) → eigenes **LXC mit docker-compose innen** (Muster CT114).
- Disk auf **Ceph `lxcs`** (rbd, Block — unbedenklich für DB/LevelDB), **HA-float** ohne Node-Pin.
- LXC: `unprivileged`, `features: nesting=1`, `lxc.apparmor.profile: unconfined` (für Docker).
- Netz: **direkte IPs `100.64.2.x`** auf vmbr2, kein Overlay.
- Routing: **edge-traefik (CT245)** → LXC-IP (Einträge in `isp_reverse_proxy_routes`), ersetzt den Swarm-Traefik.
- Deploy: pro LXC `docker compose pull && docker compose up -d` statt `docker service update`.
- **Inkrementell + parallel:** neuer LXC neben dem laufenden Swarm-Service aufbauen, **Cutover spät + kurz**, Rollback = Swarm-Service `scale=1` + Routing zurück.
- **Lehre [[nextcloud-ct104]]:** den laufenden Swarm-Stack **NIE löschen**, bevor der Ersatz die Public-URL bedient.

## Aktueller Swarm-Bestand (zu migrieren)
- **Core:** `rosenweg_api`, `rosenweg_postgres`, `rosenweg_energy-collector`, `rosenweg_energy-db`,
  `rosenweg_doc-converter`, `rosenweg_shepherd`, `rosenweg_shelly-emulator`, `rosenweg_syslog-collector`,
  `rosenweg_traefik`, `rosenweg_whatsapp-bot` (bereits scale=0, Bridge läuft in CT116).
- **Frontends (Image `rosenweg-website` / `rosenweg-isp` / `rosenweg-stweg`):**
  `rosenweg_website`, `rosenweg_isp`, `stweg1..7`, `meg`.

## Reihenfolge (risikoarm → Kern zuletzt)
1. **Frontends** (stateless, am einfachsten). Ein LXC „CT frontends" mit nginx-Images
   (website + isp + stweg/meg) — proxyt `/api/` an die **api-LXC-IP** statt `api:3000`.
   `$site`-Map in `nginx.stweg.conf` bleibt; nur das `/api/`-Upstream-Ziel ändert sich.
2. **api** (`rosenweg_api`) → eigenes LXC (Muster CT114). Env aus `/root/.env`. **In-Memory-
   OAuth-State** unproblematisch (1 Instanz). Host-published `:3000` → einfach die LXC-IP.
3. **DB** (`rosenweg_postgres`, `energy-db`) → LXC(s). api/energy zeigen auf die DB-LXC-IP.
   Daten: `pg_dump`/Volume-Move im Wartungsfenster.
4. **Supporting** (energy-collector, doc-converter, shepherd, shelly-emulator, syslog-collector)
   → je LXC oder gruppiert.
5. **Swarm abbauen** — wenn alles migriert + Soak ok: Swarm-Services `scale=0` (Rollback halten),
   dann Stack/Volumes archivieren + entfernen.

## Pro-Service-Template
1. LXC anlegen (Ceph, nesting+apparmor, IP, HA-float), Docker+compose installiert.
2. `compose.yml` (Image, Env aus `/root/.env`, Volumes lokal, Ports auf der LXC-IP).
3. Abhängige Dienste auf die neue LXC-IP zeigen (DB-Host, api-Upstream …).
4. **edge-traefik-Route** (`isp_reverse_proxy_routes`) Host → neue LXC-IP.
5. Test (Health + ein echter Pfad) → Cutover → Soak (Tage) → Swarm-Service raus.

## Routing-Umbau
- Heute: CF/DNS → edge-traefik → Swarm-Traefik (VIP `.27`) → Service. 
- Nachher: CF/DNS → edge-traefik → **direkt LXC-IP**. Pro migriertem Host die Route in
  `isp_reverse_proxy_routes` umbiegen (die liefert die edge-traefik-Dynamic-Config).
- Mail/SMTP/IMAP unverändert (PMG/Mailcow sind eh LXC).

## Deploy-Flow nachher
- GHA baut die Images weiter (`ghcr.io/rosenweg/...`).
- Statt `docker service update --force`: pro LXC `docker compose pull && docker compose up -d`
  (ggf. ein kleines `deploy.sh` je LXC, analog WhatsApp-CT116).

## Rollback je Schritt
Swarm-Service bleibt `scale=0` als Sofort-Rollback (`scale=1` + Route zurück). Erst nach
stabilem Soak des LXC-Pendants entfernen.

## Zwischenstand (Band-Aid bis zur Migration)
`rosenweg_isp` ist auf `node.hostname==docker-pve1` gepinnt (zur api) → isp→api lokal, Login
stabil. **Wenn die api den Node wechselt, neu pinnen** — oder die Frontends als ersten
Migrationsschritt ziehen, dann ist's erledigt.

## Status 2026-06-21: Schritt 1 (Frontends) ABGESCHLOSSEN
Alle 13 Frontends laufen als **native-nginx-LXCs** (kein Docker), Artefakte unter
`frontends-lxc/`, CT118-127 / `100.64.2.41-.50` + edge CT245 `.40`. Doppelt-Stack:
statische **IPv6** `2a02:16a:1400:9::40-::50` (persistent), pve-Hosts `::20-::22`.

- **Routing:** edge-traefik (CT245, `.40`/`::40`) terminiert TLS, routet Host→LXC.
  DB-Routen (`isp_reverse_proxy_routes`) für isp/noc/stweg1-7, `extra-routes.yml`
  für www/apex→CT118 + rosenweg9→CT122.
- **Public-DNS (rosenweg4303.ch):** alle Frontends `CNAME → kooperation` (DynDNS .133).
  **proxied=true (CF-WAF)** für www/apex/noc/stweg1-7/meg — **erfordert SSL-Mode `Full`**
  (Flexible → Redirect-Loop!). **isp = grey** (proxied=false) wegen IPTV-`/tv-stream/`.
- **Internes Split-Horizon (UDM, UniFi-API `static-dns`):** alle Frontend-Hosts →
  A `100.64.2.40` + AAAA `2a02:16a:1400:9::40` (edge). Kein WAN-Hairpin, kein CF-AAAA-Leak.
- **KEIN CF-Tunnel** im Frontend-Pfad (frühere Annahme war falsch).
- energy-collector `:3001` host-published (`.27:3001`) für `/api/energy/`.

**OFFEN:** Swarm-Frontend-Services (`website`, `isp`, `stweg1-7`, `meg`) laufen noch als
**Hot-Rollback** — nach Soak (1-2 Tage) `scale=0`, dann entfernen. api/postgres/energy/
doc-converter/syslog/traefik/shepherd bleiben Swarm (= De-Swarm Schritt 2-5).
Follow-ups: hardcoded `UNIFI_API_KEY`/CF-Token in `api/server.js` → rotieren + Env;
isp `/tv-stream/` erreicht VLAN9 (100.64.9.250) nicht aus dem LXC.
