# WhatsApp-Bridge — dediziertes LXC (CT 116)

Seit 2026-06-19 läuft die WhatsApp-Mail-Bridge **nicht mehr im Docker-Swarm**, sondern in
einem eigenen **LXC CT 116** (`whatsapp-bridge`, `100.64.2.39`), Disk auf **Ceph `lxcs`**,
**HA-float** (kein Node-Pin). Grund: das lokale Session-Volume zwang den Swarm-Service hart auf
`.24` (kein Failover) + der langsame Swarm-Image-Pull crashloopte die Bridge. Jetzt: Node-Pin weg,
Pull-Falle weg, Session floatet auf der Ceph-rbd-Disk mit (Failover getestet, ~48s, kein Re-Pairing).

## CT 116
- Debian 13, unprivileged, `features: nesting=1,keyctl=1`, `lxc.apparmor.profile: unconfined`
  (für Docker + Chromium/puppeteer), 2 Cores / 3 GB RAM / 12 GB Ceph-Disk.
- Docker-ce + compose (offizielles Repo, wie CT 114). ghcr-Auth in `/root/.docker/config.json`.
- `ha-manager add ct:116 --state started` (frei schwebend).

## Dateien
- `compose.yml` → `/opt/whatsapp-bot/compose.yml` (hier im Repo).
- `/opt/whatsapp-bot/.env` (0600, **nicht** im Repo): `WHATSAPP_SHARED_SECRET=...`.
- `wa-2525-fw.service` → `/etc/systemd/system/` (2525 nur von PMG `.31`).
- Volume `whatsapp-bot_whatsapp-data` = gepairte WA-Session (Nr. **41615510152**) + `gateway.sqlite`.

## Deploy (neuer Flow — KEIN Swarm-Pull-Crashloop mehr)
```
cd /opt/whatsapp-bot && docker compose pull && docker compose up -d
```
(CI baut weiterhin `ghcr.io/rosenweg/rosenweg-whatsapp-bot:latest`.)

## Verdrahtung (Consumer zeigen auf .39)
- **Traefik-Route** `isp_reverse_proxy_routes` id=25: `whatsapp.rosenweg4303.ch` → `http://100.64.2.39:8090`.
- **PMG-Transport** (CT 230): `whatsapp.rosenweg4303.ch` → `smtp:[100.64.2.39]:2525`
  (`pmgsh set /config/transport/whatsapp.rosenweg4303.ch -host 100.64.2.39 -port 2525` + `postmap` + reload).
- **api → Gateway** (`rosenweg_api`-Env, in `/root/.env` + `--env-add`):
  `GATEWAY_SEND_URL=http://100.64.2.39:8090/gateway/send`,
  `GATEWAY_GROUPS_URL=http://100.64.2.39:8080/groups`
  (Code: `api/lib/whatsapp.js` + `api/server.js` env-fähig, Default = alter Overlay-Name).
- **Gateway → api**: `API_BASE=http://100.64.2.27:3000` (Swarm-VIP, api host-published).
- **pbx-Voicemail**: nutzt Public-URL `https://whatsapp.rosenweg4303.ch/gateway/send` → unverändert.

## Rollback
Swarm-Service `rosenweg_whatsapp-bot` bleibt **scale=0** als Rollback. Zurück: Route id=25 +
PMG-Transport + api-Env auf `.24`/Overlay, `docker service scale rosenweg_whatsapp-bot=1`.
Erst nach stabilem Soak entfernen (+ Swarm-Volume archivieren).
