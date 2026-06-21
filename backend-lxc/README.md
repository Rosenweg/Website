# Backend-LXCs (De-Swarm Schritt 2-4)

api/energy/support aus dem Swarm in dedizierte LXCs (vgl. `docs/deswarm-plan.md`).

- **core/** → CT128 (.52, **privilegiert** wg. CIFS) `/opt/rosenweg-core/`:
  api + postgres + doc-converter + shelly-emulator + syslog-collector.
  Secrets via `env_file: .env` (Kopie von `/root/.env`). `/mnt/documents` = CIFS
  (`//100.64.2.28/api`, fstab am LXC, **privilegiert**) → compose-bind.
  **WICHTIG:** der `api`-`environment:`-Block enthält Vars die NUR in der alten
  docker-stack.yml standen (NICHT in .env): `NODE_TLS_REJECT_UNAUTHORIZED=0` (self-signed
  UniFi/Mailcow!), `SITE_URL`, `AUTHENTIK_URL`, `ENERGY_DB_HOST=.53`, `PVE_API_URL`,
  `WG_CONTROL_URL`, `SMTP_*`, `MAIL_FROM`, `DOCS_PATH`.
- **energy/** → CT129 (.53, unprivileged) `/opt/rosenweg-energy/`: energy-db (Port 5432
  published fuer api-energyPool) + energy-collector. NUR EIN Collector pollen lassen!

Deploy pro LXC: `docker compose pull && docker compose up -d`.
