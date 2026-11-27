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

## Anmeldeseite: Deutsch, ohne „Registrieren“ (Befunde B1, B2, offen)

Stand 27.11.2026, **nicht live geändert**. Die Anmeldeseite zeigt „Welcome to
authentik!“, „Log in to continue …“, „Enter the email address …“, das Wort
„authentik“ und auf „Passwort zurücksetzen“ den Link „Noch kein Konto?
Registrieren.“ Konten legen Ausschuss und Technik an; Selbst-Registrierung ist
nicht vorgesehen.

Nichts davon steht in diesem Repo: Es gibt keine Blueprints (in der Compose ist
kein `/blueprints/custom` eingebunden), Flows, Stages und Brand liegen nur in der
Authentik-Datenbank. Darum hier das Vorgehen – in der Admin-Oberfläche
(`https://authentik.rosenweg4303.ch/if/admin/`, Technik) oder per API
(`/api/v3/…`, Token mit Admin-Recht). Erst lesen, dann ändern; jede Änderung im
JOURNAL vermerken.

1. **Welche Flows sind im Einsatz?** System → Brands → Brand für
   `auth.rosenweg4303.ch`/`authentik.rosenweg4303.ch` (meist `authentik-default`)
   → Abschnitt Default flows: Authentication flow, Recovery flow, (Enrollment
   gibt es dort nicht). Per API: `GET /api/v3/core/brands/` → Felder
   `flow_authentication`, `flow_recovery`.
2. **Titel „Welcome to authentik!“** ist der Titel des Authentication-Flows
   (Standard `default-authentication-flow`). Flows & Stages → Flows → Flow
   bearbeiten → **Title** z. B. „Mit dem Rosenweg-Konto anmelden“. Gleich beim
   Recovery-Flow (Titel z. B. „Passwort zurücksetzen“). API:
   `PATCH /api/v3/flows/instances/<slug>/` mit `{"title": "…"}`.
3. **Sprache.** Die festen Texte („Log in to continue to …“, „Enter the email
   address …“) kommen aus der Oberfläche von Authentik und folgen der Sprache des
   Browsers bzw. der Einstellung `settings.locale`. Für alle Besucher Deutsch:
   im Brand unter **Attributes** `settings: {locale: de}` setzen (gilt als
   Vorgabe für Nutzer dieses Brands; vorher prüfen, dass die Version 2026.5 das
   so auswertet – sonst bleibt nur die Browser-Sprache). Texte, die Authentik
   auf Deutsch nicht übersetzt, lassen sich nur über die Stage-Felder (z. B. im
   Recovery-Flow den Text der E-Mail-Stage) oder eigene Vorlagen unter
   `./templates` ersetzen.
4. **Wort „authentik“.** Im Brand **Branding title** auf „Rosenweg“ setzen,
   Logo und Favicon auf das Rosenweg-Logo (`/media/…`, im Volume `./media`).
   Der Fuss „Powered by authentik“ lässt sich über die Footer-Links/Custom CSS
   des Brands ausblenden, falls die Version das anbietet.
5. **„Registrieren“ entfernen.** Der Link erscheint, weil in der
   Identification-Stage ein **Enrollment flow** eingetragen ist. Flows & Stages →
   Stages → die Identification-Stage des Authentication-Flows (Standard
   `default-authentication-identification`) **und** die des Recovery-Flows
   bearbeiten → Flow settings → **Enrollment flow leeren**. API:
   `PATCH /api/v3/stages/identification/<pk>/` mit `{"enrollment_flow": null}`.
   Danach den Enrollment-Flow selbst prüfen (Flows mit Designation
   „Enrollment“): Wird er nirgends gebraucht (Website, Nextcloud, PVE, ISP
   nutzen ihn nicht), **deaktivieren statt löschen** – z. B. Authentication
   „Require superuser“ –, damit er auch über die direkte Adresse
   `/if/flow/<slug>/` nicht erreichbar ist.
6. **Prüfen:** privates Browserfenster auf `https://www.rosenweg4303.ch` →
   „Anmelden“: deutscher Titel, kein „Registrieren“, Anmeldung mit Konto und mit
   Karte geht weiter; „Passwort vergessen?“ schickt die Mail wie bisher.

Wer das später reproduzierbar haben will: dieselben Werte als Blueprint unter
`authentik-ct/blueprints/` ablegen und in der Compose bei server und worker
`./blueprints:/blueprints/custom` einbinden.
