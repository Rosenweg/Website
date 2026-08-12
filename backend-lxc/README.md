# Backend-LXCs (De-Swarm Schritt 2-4)

api/energy/support aus dem Swarm in dedizierte LXCs (vgl. `docs/deswarm-plan.md`).

- **core/** → CT128 (.52, noch privilegiert) `/opt/rosenweg-core/`:
  api + postgres + doc-converter + shelly-emulator + syslog-collector.
  Secrets via `env_file: .env` (Kopie von `/root/.env`).

  `/mnt/documents` kommt als **Proxmox-Einhängepunkt** direkt aus dem CephFS:

  ```
  pct set 128 -mp0 /mnt/pve/docs,mp=/mnt/documents
  ```

  Ohne die ist der ganze Dokumentenbereich der API leer — Aushänge, Briefe,
  Dateiliste. Sie steht in der Container-Konfiguration und **nicht** im Repo;
  wer CT128 neu aufsetzt, muss sie von Hand setzen. Nachsehen mit
  `pct config 128 | grep ^mp`.

  Vorher war es eine CIFS-Einhängung (`//100.64.2.28/api`, fstab am LXC), und
  nur dafür lief der Container privilegiert. Am 12. August 2026 war sie nach
  dem CephFS-Umbau nicht mehr eingehängt: die API sah ein leeres
  `/documents`. Aufgefallen ist es an einem einzigen kaputten Bild auf der
  Anzeigetafel im Treppenhaus — der gesamte Dokumentenbereich war seit dem
  Umbau tot, ohne dass irgendetwas Alarm geschlagen hätte.

  Weg damit, aus drei Gründen: die fstab-Zeile trug das Dienstpasswort im
  Klartext; die API hing am Samba-Stack, der seine Dateien selbst aus
  demselben CephFS holt (ein Umweg über zwei Schichten, die beide ausfallen
  können); und CT104 macht es längst direkt. Der Grund für die Privilegierung
  ist damit entfallen — beim nächsten Neuaufsetzen kann der Container
  unprivilegiert laufen.

  **WICHTIG:** der `api`-`environment:`-Block enthält Vars die NUR in der alten
  docker-stack.yml standen (NICHT in .env): `NODE_TLS_REJECT_UNAUTHORIZED=0` (self-signed
  UniFi/Mailcow!), `SITE_URL`, `AUTHENTIK_URL`, `ENERGY_DB_HOST=.53`, `PVE_API_URL`,
  `WG_CONTROL_URL`, `SMTP_*`, `MAIL_FROM`, `DOCS_PATH`.
- **energy/** → CT129 (.53, unprivileged) `/opt/rosenweg-energy/`: energy-db (Port 5432
  published fuer api-energyPool) + energy-collector. NUR EIN Collector pollen lassen!

Deploy pro LXC: `docker compose pull && docker compose up -d`.
