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

## Fehlanmeldungen an CrowdSec (seit 18.11.2026)

`authentik-crowdsec-melder` (nach `/usr/local/sbin/`, mit
`authentik-crowdsec-melder.service`/`.timer` nach `/etc/systemd/system/`,
`systemctl enable --now authentik-crowdsec-melder.timer`) liest jede Minute neue
`login_failed`-Ereignisse aus der Datenbank und schickt je Ereignis nur die
Client-IP per Syslog an CrowdSec auf dem Edge (100.64.2.40:4514/udp). Stand in
`/var/lib/authentik-crowdsec-melder/stand`. Prüfen auf dem Edge:
`cscli metrics show parsers | grep authentik`, `cscli alerts list`.

## Anmeldeseite: Deutsch, ohne „Registrieren“ (Befunde B1, B2, umgesetzt 27.11.2026)

Konten legen Ausschuss und Technik an; Selbst-Registrierung ist nicht vorgesehen.
Nichts davon steht in diesem Repo: Es gibt keine Blueprints (in der Compose ist
kein `/blueprints/custom` eingebunden), Flows, Stages und Brand liegen nur in der
Authentik-Datenbank. Geändert per API (`/api/v3/…`, Token mit Admin-Recht).

**Sicherung vorher:** CT 128, `/root/authentik-sicherung-2026-11-27/` – Flow-Exporte
(`flow-<slug>.yaml`, Format Blueprint) und JSON-Stände (`flow-<slug>.json`,
`brands.json`, `stages-*.json`, `policy-bindings.json`, `flow-bindings.json`,
`sources.json`). Die neuen Werte liegen daneben unter `neu/`. `ak.sh METHOD PFAD
[JSON-DATEI]` ruft die API auf und liest das Token zur Laufzeit aus
`/opt/rosenweg-core/.env` (gibt es nie aus).

**Stand jetzt:**

| Objekt | vorher | jetzt |
|---|---|---|
| Brand `authentik-default`, `attributes.settings.locale` | – | `de` (→ `default_locale: de`; Seite deutsch auch bei englischem Browser) |
| Flow `default-authentication-flow`, Titel | „Welcome to authentik!“ | „Bei Rosenweg anmelden“ |
| Flow `default-source-authentication`, Titel | „Welcome to authentik!“ | „Bei Rosenweg anmelden“ |
| Flows `default-provider-authorization-{explicit,implicit}-consent`, Titel | „Redirecting to %(app)s“ | „Weiter zu %(app)s“ |
| Flow `default-provider-invalidation-flow`, Titel | „You've logged out of %(app)s.“ | „Sie wurden von %(app)s abgemeldet.“ |
| Kerberos-Quelle `ad-kerberos`, Name (Knopf auf der Anmeldeseite) | „SSO Login“ | „SSO-Anmeldung“ |
| Stage `recovery-identification`, `enrollment_flow` | `default-authentication-flow` (ergab „Noch kein Konto? Registrieren.“) | leer |
| Stage `default-authentication-identification` | `enrollment_flow` war schon leer, `recovery_flow` = `password-recovery` | unverändert |
| Flow `default-source-enrollment` (einziger Enrollment-Flow, von keiner Quelle genutzt) | Titel englisch, `policy_engine_mode: any` | Titel „Registrierung ist deaktiviert“, `policy_engine_mode: all`, zusätzlich Policy **`rosenweg-deny-all`** (Expression, `return False` mit Meldung „Registrierung ist nicht möglich …“) gebunden, Reihenfolge 100. Nicht gelöscht. |

Branding-Titel war schon „Rosenweg“; Password- und Consent-Stage haben in 2026.5
keine Textfelder. Der Recovery-Flow (`password-recovery`, Titel „Passwort
zurücksetzen“) bleibt; der Link „Benutzername oder Passwort vergessen?“ steht weiter
auf der Anmeldeseite.

**Geprüft (27.11.2026):** Headless-Chrome mit `--lang=en-US` zeigt „Bei Rosenweg
anmelden“, „Email oder Username“, „Anmelden“, „SSO-Anmeldung“, „Benutzername oder
Passwort vergessen?“, kein „Registrieren“. `/if/flow/default-source-enrollment/`
endet mit „Registrierung ist nicht möglich …“. Anmeldung über
`www.rosenweg4303.ch/api/auth/login` läuft bis zur Passwort-Stage.

**Noch englisch bzw. offen (in der Admin-Oberfläche nicht einstellbar):**
- Recovery-Seite: „Enter the email address or username associated with your
  account.“ – fester Text der Oberfläche, in der deutschen Übersetzung von 2026.5
  nicht übersetzt. Nur über eine eigene Vorlage bzw. ein Upstream-Update lösbar.
- Fuss „Powered by authentik“ und Alt-Text „authentik Logo“; das Logo selbst
  (`https://www.rosenweg4303.ch/logo-rosenweg.png`, 1 MB) lud im headless Chrome
  nicht – im normalen Browser prüfen, ggf. kleineres Logo unter `/media` ablegen.

**Zurück:** Titel und `enrollment_flow` per `PATCH` mit den Werten aus der
Sicherung; Policy-Bindung `rosenweg-deny-all` an `default-source-enrollment`
löschen und `policy_engine_mode` wieder `any`; im Brand `locale` aus
`attributes.settings` entfernen. Oder die `flow-*.yaml` als Blueprint einspielen.

Wer das später reproduzierbar haben will: dieselben Werte als Blueprint unter
`authentik-ct/blueprints/` ablegen und in der Compose bei server und worker
`./blueprints:/blueprints/custom` einbinden.
