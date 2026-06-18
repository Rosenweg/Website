# Authentik — dedizierte HA-LXC (CT 114)

Authentik läuft **nicht mehr im Docker-Swarm**, sondern in einer eigenen LXC — raus aus dem
fragilen Overlay (Failover/502-Probleme). Migriert 2026-06-18, dabei **2024.12 → 2026.5.3**.

## CT 114
- Debian 13, **IP 100.64.2.37**, Disk auf **Ceph `lxcs`** (HA-fähig), `features: nesting=1,keyctl=1`
  + `lxc.apparmor.profile: unconfined` (für Docker im LXC), unprivileged.
- **Proxmox-HA aktiv** (CRS-Float, kein Pin): `ha-manager add ct:114 --state started`.
  Bei Node-Ausfall startet die CT auf einem anderen Node neu (Ceph-Disk floatet), ~1-3 min.
- Stack: `docker compose` in `/opt/authentik/` (server + worker + postgresql:17 + redis:7 + ldap-Outpost).
  `docker-compose.yml` hier im Repo; **`/opt/authentik/.env`** hält die Secrets (PG_PASS,
  AUTHENTIK_SECRET_KEY, LDAP_TOKEN) — NICHT im Repo (siehe `.env.example`).

## Routing (Edge-Traefik, CT 245)
`auth.rosenweg4303.ch` + `authentik.rosenweg4303.ch` → `edge-traefik` Service
`authentik-hosts-svc` → **`http://100.64.2.37:9000`** (siehe `edge-traefik/extra-routes.yml`).
Für **interne** Clients (PVE etc.) zusätzlich `isp_reverse_proxy_routes`-Zeilen (Swarm-Traefik .27).

## Wichtige Gotchas
- **Trusted-Proxy / CGNAT:** Traefik erreicht die CT aus `100.64.2.x` (= `100.64.0.0/10`, CGNAT).
  Authentik vertraut dem per Default NICHT → `X-Forwarded-Proto` ignoriert → **http-Issuer** (OIDC kaputt).
  Fix in der Compose: `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS` inkl. `100.64.0.0/10`.
- **Upgrade nur stufenweise:** direkter Sprung 2024.12→2026.5.3 scheitert (`core/0058_setup`,
  `reputation_lower_limit`/`pagination_default_page_size`). Pfad: 2024.12 → 2025.10.4 → 2025.12.6
  → 2026.2.4 → 2026.5.3 (DB-Reset zwischen Fehlversuchen, sonst Teil-Migration).
- **api → Authentik:** `rosenweg_api` env `AUTHENTIK_URL=http://100.64.2.37:9000` (war `https://server:9443`).
- **Consumer:** Nextcloud (user_oidc), PVE (Issuer ohne `:9443`!), Website/ISP (Rosenweg-Website-Provider),
  UniFi (LDAP-Outpost → `100.64.2.37:389/636`), Samba-Passwort-Sync (Expression-Policy → Webhook .28:8445).

## Rollback
Alter Swarm-Stack `authentik` ist **gestoppt (scale 0)**, NFS-Daten unter `/mnt/nfs-shared/authentik_pgdata`
unangetastet. Zurück: Routing/`AUTHENTIK_URL` zurück + `docker stack deploy -c /opt/authentik/docker-stack.yml authentik`.
