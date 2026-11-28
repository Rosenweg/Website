# Backend-LXCs (API und Energie)

Stand: 17.11.2026. Die API und der Energie-Stack laufen nicht mehr im Swarm,
sondern als Docker Compose in zwei eigenen LXCs (Hintergrund:
`docs/deswarm-plan.md`). Sicherheitsregeln, Pflichtvariablen und Reihenfolge
beim Ausrollen: [`../docs/sicherheit.md`](../docs/sicherheit.md) Abschnitte 4.6,
6 und 8.

| | core (`core/`) | energy (`energy/`) |
|---|---|---|
| Container | **CT 128 `core-backend`**, pve1 | **CT 129 `energy-stack`**, pve1 |
| Adresse | `100.64.2.52` | `100.64.2.53` |
| Verzeichnis | `/opt/rosenweg-core/` | `/opt/rosenweg-energy/` |
| Dienste | `api` (Port 3000), `postgres` (nur Docker-intern), `doc-converter` (Gotenberg), `shelly-emulator` (8089), `syslog-collector` (5514 udp/tcp), `journal-remote` (19532, Stationsjournal, siehe `journal-remote/README.md`) | `energy-db` (5432), `energy-collector` (3001) |
| Geheimnisse | `/opt/rosenweg-core/.env` (0600, nie im Repo) | `/opt/rosenweg-energy/.env` (0600, nie im Repo) |
| Privilegiert | ja (historisch, siehe unten) | nein |

## core (CT 128)

`compose.yml` → `/opt/rosenweg-core/compose.yml`. Die API liest ihre Umgebung
aus `env_file: .env`; zusätzlich setzt der `environment:`-Block feste,
nicht geheime Werte (`SITE_URL`, `AUTHENTIK_URL`, `ENERGY_DB_HOST=100.64.2.53`,
`ENERGY_COLLECTOR_URL`, `PVE_API_URL`, `WG_CONTROL_URL`, `SMTP_HOST`/`SMTP_PORT`,
`MAIL_FROM`, `DOCS_PATH`, `UDPXY_*`, `NOC_PUBLIC_OPEN`, `TECHNIK_WA_GROUP_ID`).

**Pflichtvariablen in `.env`** (fehlt eine, ist die jeweilige Funktion aus –
nie ein Standardwert): `DB_PASSWORD`, `ENERGY_DB_PASSWORD`,
`ENERGY_ADMIN_API_KEY`, `AD_PASSWORD_API_SECRET`, `PRINT_API_SECRET`,
`PRINT_AR_AUTHSERV_ID`, `PVE_MSG_SECRET`, `GOOGLE_CALENDAR_ICS_URL`,
`TRAEFIK_CONFIG_SECRET`, `TRACKER_SHARED_SECRET`, `WHATSAPP_SHARED_SECRET`,
`PBX_SHARED_SECRET`, `ALARM_SECRET`, `MQTT_AUTH_SECRET`, `SSH_HOST_TOKEN`,
`SCAN_API_KEY`, `EMAIL_INBOUND_SECRET`. Wirkung und optionale Schalter
(`OTP_LOGIN_ENABLED`, `OTP_GLOBAL_MAX_10MIN`, `SSH_GESPERRTE_LOGINS`,
`IMAP_SERVERNAME`, `*_TLS_INSECURE` …): `sicherheit.md` Abschnitt 6.

**`NODE_TLS_REJECT_UNAUTHORIZED: "0"`** steht noch im `environment:`-Block. Es
schaltet die Zertifikatsprüfung für **alle** ausgehenden https-Verbindungen der
API ab (SMTP, Authentik, Cloudflare, GitHub …) und ist nur nötig wegen UniFi,
Mailcow und PVE mit eigenen Zertifikaten. Ziel: deren CA als Datei einbinden
(`NODE_EXTRA_CA_CERTS=/certs/rosenweg-ca.pem` plus Volume) und dann die Zeile
entfernen.

**Dokumente:** `/mnt/documents` kommt als Proxmox-Einhängepunkt direkt aus dem
CephFS:

```
pct set 128 -mp0 /mnt/pve/docs,mp=/mnt/documents
```

Ohne ihn ist der ganze Dokumentenbereich der API leer — Aushänge, Briefe,
Dateiliste. Er steht in der Container-Konfiguration und **nicht** im Repo; wer
CT 128 neu aufsetzt, muss ihn von Hand setzen. Nachsehen mit
`pct config 128 | grep ^mp`.

Geprüft am 28.11.2026: `mp0: /mnt/pve/docs,mp=/mnt/documents`, im Container
`findmnt -T /mnt/documents` → `ceph`, Quelle `100.64.2.20,100.64.2.21,100.64.2.22:/docs`,
der API-Container bindet `/mnt/documents:/documents`. Die API hängt damit an keinem
der beiden Fileserver; das CIFS-Volume in `docker-stack.yml` ist veraltet (Swarm).

Vorher war es eine CIFS-Einhängung (`//100.64.2.28/api`, fstab im LXC), und nur
dafür lief der Container privilegiert. Am 12. August 2026 war sie nach dem
CephFS-Umbau nicht mehr eingehängt: Die API sah ein leeres `/documents`.
Aufgefallen ist es an einem einzigen kaputten Bild auf der Anzeigetafel im
Treppenhaus. Die fstab-Zeile trug das Dienstpasswort im Klartext; sie ist
entfernt (das Passwort gilt als zu ändern). Beim nächsten Neuaufsetzen kann der
Container unprivilegiert laufen.

### Ausrollen, prüfen, zurück

```bash
ssh root@100.64.2.20 'pct exec 128 -- sh -c "cd /opt/rosenweg-core && docker compose pull api && docker compose up -d api"'
ssh root@100.64.2.20 'pct exec 128 -- sh -c "cd /opt/rosenweg-core && docker compose ps && docker compose logs --tail 80 api | grep -iE \"fehlt|error|listening\""'
curl -s https://www.rosenweg4303.ch/api/health
```

Eine geänderte `compose.yml` vorher nach `/opt/rosenweg-core/` kopieren und mit
`docker compose config -q` prüfen. Zurück: früheres Image-Tag (Git-SHA) setzen
(siehe `docs/website.md`, Abschnitt „API ausrollen“) bzw.
`/opt/rosenweg-core/.env.vor-sicherheit-2026-11-17` zurückkopieren.

## energy (CT 129)

`compose.yml` → `/opt/rosenweg-energy/compose.yml`. **Nur ein** Collector darf
die Zähler abfragen.

**Seit dem 16./17.11.2026 abgesichert** (Vorfall: Schein-Zähler über die offene
Collector-API, SSRF – `sicherheit.md` Abschnitt 1.1):

- `ENERGY_DB_PASSWORD` ist Pflicht. Fehlt es in `.env`, bricht
  `docker compose up` ab mit `ENERGY_DB_PASSWORD fehlt (kein Standardpasswort mehr)`.
  Das frühere Standardpasswort aus dem Repo gilt als bekannt und ist zu ändern
  (`sicherheit.md` Abschnitt 7.1, Punkt 12: `ALTER USER energy PASSWORD …` im
  Container `energy-db`, dann `.env` auf CT 129 **und** CT 128).
- **Admin-Endpunkte** (`POST/PUT/DELETE` auf Zähler, Tarife, Zuordnungen,
  `/meters/:id/test`) verlangen `Authorization: Bearer <ADMIN_API_KEY>`; ohne
  gesetzten Schlüssel antworten sie 503. Jeder Aufruf steht im Collector-Log
  (`[admin] ... src=... auth=... status=...`). Der Schlüssel steht als
  `ENERGY_ADMIN_API_KEY` in `/opt/rosenweg-energy/.env` **und** gleichlautend in
  `/opt/rosenweg-core/.env`. `energie-config.html` schreibt über
  `/api/energie-admin/*` der Haupt-API (Anmeldung + Recht `energie-config`/write).
- **Zähler-Ziele** werden geprüft (`energy-collector/meter-target.js`): nur
  Adressen in `METER_NETWORKS` (`100.64.90.0/24`), Modbus nur auf
  `MODBUS_ALLOWED_PORTS` (`502`), nie Loopback/Link-Local/`FORBIDDEN_HOSTS`
  (Collector, API). Auch beim Abfragen.
- **Personenbezogene Lese-Routen** (Lastprofile, Zählerlisten, Zuordnungen)
  liefert der Collector nur an `INTERN_LESER` (= `ENERGY_INTERN_LESER` in
  `.env`, Wert `100.64.2.52`) oder mit Admin-Schlüssel. Leer = wie früher offen.
  **Erst setzen, nachdem alle Frontends mit dem neuen `deploy.sh` ausgerollt
  sind** – vorher schicken die alten nginx-Konfigurationen diese Pfade noch
  direkt zum Collector, und die Seiten bekämen 403.
- **nftables** (`energy/firewall/`): 3001 nur für CT 128 und die Frontend-LXCs
  (`.41`–`.50`, `.54`), 5432 nur für CT 128; IPv4 und IPv6.

  ```
  install -D -m644 energy/firewall/energy-firewall.nft /etc/rosenweg/energy-firewall.nft
  install -m644 energy/firewall/rw-energy-firewall.service /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now rw-energy-firewall
  # nach Aenderung der Datei: systemctl reload rw-energy-firewall
  ```

  Kommt ein neuer Client dazu (neuer Frontend-LXC, Backend-IP/IPv6 ändert sich),
  muss er in die Sets der `.nft`-Datei.

### Ausrollen, prüfen, zurück

```bash
# compose.yml aus dem Repo nach /opt/rosenweg-energy/ kopieren, .env ergänzen:
#   ENERGY_INTERN_LESER=100.64.2.52   (erst nach den Frontends, siehe oben)
ssh root@100.64.2.20 'pct exec 129 -- sh -c "cd /opt/rosenweg-energy && docker compose config -q && docker compose pull && docker compose up -d"'
curl -s https://www.rosenweg4303.ch/api/energy/surplus        # offen, ohne "consumers"
curl -s -o /dev/null -w '%{http_code}\n' http://100.64.2.53:3001/api/energy/meters   # von einem Frontend aus: 403
ssh root@100.64.2.20 'pct exec 129 -- systemctl is-active rw-energy-firewall'
```

Zurück: `/opt/rosenweg-energy/{.env,compose.yml}.vor-sicherheit-2026-11-17`
zurückkopieren und `docker compose up -d`.
