# Frontend-LXCs — De-Swarm Schritt 1

Ersetzt die Swarm-Frontend-Services (`rosenweg_website`, `rosenweg_isp`,
`rosenweg_stweg1..7`, `rosenweg_meg`) durch **kleine native-nginx-LXCs** — ein LXC
pro Frontend, **kein Docker**, kein Overlay. Damit fällt für die statischen
Frontends die komplette Swarm-Overlay-Schicht weg (Wurzel der 502/504/Flaps,
siehe [`../docs/deswarm-plan.md`](../docs/deswarm-plan.md)).

## Architektur

```
Cloudflare/DNS ─▶ edge-traefik (CT245, .40)  ─▶  Frontend-LXC :80 (native nginx)
                  (TLS-Terminierung, cf-cert)      └─ /api/  ─▶ rw_api    (Swarm-VIP .27:3000, später api-LXC)
                                                    └─ /api/energy/ ─▶ rw_energy (.27:3001, später energy-LXC)
```

- edge-traefik terminiert TLS und spricht **HTTP** zur Origin → alle vhosts setzen
  `X-Forwarded-Proto "https"` hart (sonst baut die API http://-OAuth-Callbacks).
- `/api/`-Upstreams kommen aus [`nginx/upstreams.conf`](nginx/upstreams.conf)
  (`upstream rw_api` / `rw_energy`) — **die einzige Stelle**, die beim späteren
  api/energy-LXC-Cutover (De-Swarm-Schritt 2/4) geändert werden muss.

## LXC-Block

| site | CT | IP | type | edge-Hosts |
|------|----|----|------|-----------|
| www | 118 | .41 | website | www.rosenweg4303.ch, rosenweg4303.ch |
| isp | 119 | .42 | isp | isp.rosenweg4303.ch, noc.rosenweg4303.ch |
| stweg1 | 120 | .43 | stweg | stweg1.rosenweg4303.ch |
| stweg2 | 121 | .44 | stweg | stweg2.rosenweg4303.ch |
| stweg3 | 122 | .45 | stweg | stweg3.rosenweg4303.ch, rosenweg9.ch, www.rosenweg9.ch |
| stweg4 | 123 | .46 | stweg | stweg4.rosenweg4303.ch |
| stweg5 | 124 | .47 | stweg | stweg5.rosenweg4303.ch |
| stweg6 | 125 | .48 | stweg | stweg6.rosenweg4303.ch |
| stweg7 | 126 | .49 | stweg | stweg7.rosenweg4303.ch |
| meg | 127 | .50 | stweg | meg.rosenweg4303.ch |

LXC-Spec: Debian 13, unprivileged, 1 Core / 256 MB / 4 GB Ceph-Disk (`lxcs`),
HA-float (kein Node-Pin), **kein** nesting/apparmor-unconfined (kein Docker nötig).

## Dateien

- `provision.sh` — auf einem PVE-Host: legt einen LXC an, installiert nginx, klont
  das Repo, erster Deploy, `ha-manager add`. `./provision.sh <site>`.
- `deploy.sh` — **im** LXC: `git pull` → nginx-Config installieren → docroot bauen
  (entspricht der jeweiligen Dockerfile-Logik) → `nginx -t && reload`.
- `nginx/{website,isp,stweg}.conf` — native vhosts (root `/var/www/rosenweg`).
- `nginx/upstreams.conf` — `rw_api` / `rw_energy` Backend-IPs (single source).
- `sites.tsv` — Belegungstabelle (Referenz; `provision.sh` hat sie als `case`).

## Content-Deploy (kein GHCR mehr für Frontends)

Jeder LXC hat einen flachen Repo-Checkout in `/opt/rosenweg/repo`. Deploy:

```bash
ssh root@<lxc-ip> /opt/rosenweg/repo/frontends-lxc/deploy.sh
```

`deploy.sh` baut den docroot in einem Temp-Verzeichnis und spiegelt ihn atomar
(`rsync --delete`) nach `/var/www/rosenweg`. Repo bleibt Source-of-Truth.
Repo privat → `provision.sh` mit `GIT_URL='https://<token>@github.com/...'` aufrufen.

> GHA (`.github/workflows/deploy.yml`) baut die Frontend-Images bis zum Abbau des
> Swarm weiter — Rollback bleibt so möglich. Nach dem Soak können die
> `build-website/-isp/-stweg`-Jobs raus und ein Push-Deploy (ssh→deploy.sh) rein.

## Provisioning

```bash
# auf einem PVE-Host (oder via ssh root@100.64.2.20 'bash -s' < provision.sh):
scp frontends-lxc/provision.sh root@100.64.2.20:/tmp/
ssh root@100.64.2.20 'TEMPLATE=local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst /tmp/provision.sh meg'
```

## Cutover (pro Host, einzeln, spät & kurz)

edge-traefik (CT245) pollt die dynamische Config alle 15 s. Zwei Quellen:

### A) DB-Routen — `isp`, `noc`, `meg`, `stweg1..7`
Liegen als Rows in `isp_reverse_proxy_routes` (heute `backend_url=https://100.64.2.27`
= Swarm-Traefik). Cutover = backend_url auf die LXC-IP umbiegen:

```sql
-- Beispiel meg (Canary). psql via Swarm-Postgres:
UPDATE isp_reverse_proxy_routes
   SET backend_url='http://100.64.2.50', entry_point='websecure',
       protocol='http', preserve_host=true, ssl=true, cert_resolver='cf'
 WHERE hostname='meg.rosenweg4303.ch';
```
```bash
ssh root@100.64.2.20 "pct exec 201 -- docker exec \$(pct exec 201 -- docker ps -qf name=rosenweg_postgres|head -1) \
  psql -U rosenweg -d rosenweg -c \"UPDATE isp_reverse_proxy_routes SET backend_url='http://100.64.2.50', entry_point='websecure' WHERE hostname='meg.rosenweg4303.ch';\""
```
> Alternativ über die UI: `isp-admin.html` → Reverse-Proxy-Routen → backend_url editieren.

### B) Statische Routen — `www.rosenweg4303.ch` + apex, `rosenweg9.ch` + apex
Liegen in [`../edge-traefik/extra-routes.yml`](../edge-traefik/extra-routes.yml)
(Service `swarm-https-svc → https://100.64.2.27`). Cutover = dort die Service-URL
auf die LXC-IP zeigen (eigener Service pro Ziel, HTTP-Backend):

```yaml
  services:
    www-lxc-svc:    { loadBalancer: { passHostHeader: true, servers: [{ url: http://100.64.2.41 }] } }
    rw9-lxc-svc:    { loadBalancer: { passHostHeader: true, servers: [{ url: http://100.64.2.45 }] } }
# und die Router rw4303-apex-www / rw9-apex-www auf den jeweiligen *-lxc-svc zeigen.
```
Datei nach CT245 deployen (siehe `edge-traefik/` Sync) — `watch: true` lädt sofort.

### Reihenfolge (risikoarm → Kern zuletzt)
1. **meg** (Canary) — Cutover, validieren, Soak.
2. **stweg1, stweg2, stweg4..7** — je einzeln.
3. **stweg3 + rosenweg9** — *vorher* `energy-collector` host-publishen (siehe unten).
4. **isp + noc** — *vorher* `/tv-stream/`-Route (VLAN 9) prüfen.
5. **www** — zuletzt (Haupttraffic), via extra-routes.yml.

### energy-collector erreichbar machen (vor stweg3 + www)
Die `/api/energy/`-Upstream (`rw_energy = .27:3001`) ist im Swarm **nicht**
host-published. Vor dem stweg3/www-Cutover in `docker-stack.yml` ergänzen und via
`/root/deploy-stack.sh` deployen:

```yaml
  energy-collector:
    ports:
      - { target: 3001, published: 3001, mode: ingress }
```
(meg/stweg1-7 ohne Solar-Modul rufen `/api/energy/` nicht auf → für den Canary egal.)

## Validierung (nach jedem Cutover)

```bash
curl -sI https://meg.rosenweg4303.ch/ | head -1            # 200
curl -s  https://meg.rosenweg4303.ch/health                # OK
# Login/OAuth auf einer geschützten Seite testen (XFP=https korrekt?).
```

## Rollback (pro Host, sofort)

- **DB-Route:** `backend_url` zurück auf `https://100.64.2.27` (entry_point bleibt).
- **Statisch:** Service-URL in `extra-routes.yml` zurück auf `swarm-https-svc`.
- Der Swarm-Service läuft bis zum Soak-Ende weiter → Rückweg ist nur die Route.

## Swarm-Abbau (erst nach stabilem Soak, Schritt 5)

```bash
ssh root@100.64.2.20 'pct exec 201 -- docker service scale rosenweg_meg=0'   # je Service
# scale=0 als Sofort-Rollback halten; erst nach Tagen Soak die Services + Images entfernen.
```
