# Edge-Traefik (LXC 245)

Zentraler Reverse-Proxy fuer den Rosenweg-Stack. Lebt in LXC 245 auf
`100.64.2.40` (VLAN 2). Loest langfristig den CF Tunnel ab — der bleibt
parallel bis alles migriert ist.

## Architektur

```
WAN :80/:443   ─DNAT─►  100.64.2.40:80/:443
                            │
                            ▼
                       Traefik 3.5
                            │  HTTP-Provider polled DB-Routes
                            ▼
                  rosenweg_api /api/traefik/dynamic
                            │
                            ▼
                    Backends (Swarm-VIP, LXCs, externe Hosts)
```

## Komponenten

- **traefik.yml** — statische Config (entrypoints, ACME, providers)
- **dynamic-static.yml** — File-Provider Notfall-Routes (Dashboard, sec-headers)
- **traefik.service** — systemd unit
- **deploy.sh** — push Files in den LXC + start service

## ACME

- `cf-dns01` Challenge gegen Cloudflare (Token in `/etc/default/traefik`)
- Wildcards koennen jederzeit ausgestellt werden (`Host:*.rosenweg4303.ch`)
- Storage `/var/lib/traefik/acme.json` (chmod 600)

## Dashboard

Nur intern via `Host: traefik.rosenweg4303.ch` (BasicAuth, htpasswd in
`/etc/traefik/.htpasswd`). Wird erst erreichbar wenn der Hostname DNS-only
auf 100.64.2.40 (via WAN) zeigt.

## Initial Deployment

```bash
# 1) LXC anlegen (einmalig)
# pct create 245 ... debian-13-standard ... 100.64.2.40/24

# 2) CF Token setzen (manueller Schritt — Secret nicht in Repo)
ssh root@100.64.2.20 'pct exec 245 -- bash -c "echo CF_DNS_API_TOKEN=... > /etc/default/traefik && chmod 600 /etc/default/traefik"'

# 3) Deploy
./deploy.sh

# 4) htpasswd fuer Dashboard
ssh root@100.64.2.20 'pct exec 245 -- htpasswd -bc /etc/traefik/.htpasswd admin <PASSWORD>'
```

## Logs

- `/var/log/traefik/traefik.log` — Component-Logs
- `/var/log/traefik/access.log` — Request-Log (JSON)
- `journalctl -u traefik -f` — systemd
