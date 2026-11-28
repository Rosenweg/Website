# Infrastruktur — Rosenweg 4303 Kaiseraugst

Stand: 17.11.2026. Diese Seite ist der Einstieg für Techniker: wo welcher Dienst
läuft, wie man hinkommt, wo die Betriebsanleitung liegt. Sicherheitsregeln,
Pflichtvariablen, Reihenfolge beim Ausrollen und offene Punkte stehen zentral
in [`sicherheit.md`](sicherheit.md).

> **Der Docker Swarm ist abgebaut** (Juni 2026). Die Container CT 201–203
> (`docker-pve1..3`, `100.64.2.24–26`) und die Swarm-Adresse `100.64.2.27` gibt
> es nicht mehr; ebenso den Cloudflare-Tunnel auf den Swarm. Jeder Dienst hat
> heute einen eigenen LXC. Anleitungen mit `docker service …`,
> `docker stack deploy` oder `ssh root@100.64.2.24` sind veraltet.

## Überblick

```
Internet (Init7, öffentliche Adresse dynamisch, Name public.rosenweg4303.ch)
    │  Cloudflare: DNS für rosenweg4303.ch / rosenweg9.ch, teils Proxy
    ▼
UDM-Pro ── DNAT 80/443/465/587/993/25/8883 ──▶ CT 245 edge-traefik (100.64.2.40)
    │                                              │ TLS (Let's Encrypt über Cloudflare-DNS)
    │                                              ├─▶ Frontend-LXCs CT 118–127, 130 (nginx)
    │                                              │        └─ /api ─▶ CT 128 core-backend (API, Postgres)
    │                                              │        └─ /api/energy (offen) ─▶ CT 129 energy-stack
    │                                              ├─▶ Authentik CT 114, Nextcloud CT 104, WhatsApp CT 116, PBX CT 220 …
    │                                              └─▶ TCP-SNI: Mail (Mailcow CT 240 / PMG CT 230), Kontakte (CT 115)
    └── udp/5060 (nur peoplefone) ──▶ CT 220 asterisk-pbx
```

## Proxmox-Knoten

| Knoten | LAN | Rolle (Normalfall) |
|------|-----------|-------|
| pve1 | 100.64.2.20 | API, Energie, Frontends, Mail, VPN, TV, Router-CTs |
| pve2 | 100.64.2.21 | Fileserver, Domänencontroller dc1, Authentik |
| pve3 | 100.64.2.22 | Edge-Traefik, PBX, Druck, PMG, WhatsApp, Z-Push, dc2 |

Viele Container sind HA-schwebend; ihr Knoten kann sich ändern. `pct exec`
funktioniert nur auf dem Knoten, der den Container gerade hat. Nachsehen:

```bash
ssh root@100.64.2.20 'ha-manager status'                     # HA-Dienste mit Knoten
ssh root@100.64.2.20 'pvesh get /cluster/resources --type vm --output-format json'
```

Zugang zu den Knoten: SSH als root (Notweg `/root/.ssh/authorized_keys`) oder
mit einem Portal-Schlüssel (siehe [`ssh-zugang.md`](ssh-zugang.md)). Von
ausserhalb über den Sprunghost `ssh -J stefan@10.0.10.149 …`.

## Dienste und Container (Stand 17.11.2026)

| CT | Name | Knoten | Adresse | Dienst | Betriebsanleitung |
|----|------|--------|---------|--------|-------------------|
| 128 | core-backend | pve1 | 100.64.2.52 | API (3000), Postgres, Gotenberg, Syslog-Collector, Shelly-Emulator | [`../backend-lxc/README.md`](../backend-lxc/README.md) |
| 129 | energy-stack | pve1 | 100.64.2.53 | Energie-Collector (3001), Energie-DB (5432) | dito |
| 118 | fe-www | pve1 (HA) | 100.64.2.41 | Hauptseite | [`../frontends-lxc/README.md`](../frontends-lxc/README.md) |
| 119 | fe-isp | pve1 (HA) | 100.64.2.42 | `isp.`, `noc.` | dito |
| 120–126 | fe-stweg1..7 | pve1 (HA) | 100.64.2.43–.49 | STWEG-Seiten | dito |
| 127 | fe-meg | pve1 (HA) | 100.64.2.50 | MEG | dito |
| 130 | fe-pwa | pve1 (HA) | 100.64.2.54 | `pwa.` (Reparatur-Meldung) | dito |
| 245 | edge-traefik | pve3 | 100.64.2.40 | Reverse-Proxy, TLS | [`../edge-traefik/README.md`](../edge-traefik/README.md) |
| 116 | whatsapp-bridge | pve3 (HA) | 100.64.2.39 | WhatsApp-Bot und Gateway (8080/8090/2525) | [`../whatsapp-bot/lxc/README.md`](../whatsapp-bot/lxc/README.md) |
| 220 | asterisk-pbx | pve3 | 100.64.2.55 | Telefonanlage, PBX-API (8095) | [`../pbx/README.md`](../pbx/README.md) |
| 115 | zpush | pve3 | 100.64.2.38 | ActiveSync-Kontakte | [`../zpush/README.md`](../zpush/README.md) |
| 113 | vpn-wg | pve1 | 100.64.2.34 | WireGuard, `wg-control` (3001) | [`../wg-control/README.md`](../wg-control/README.md) |
| 250 | tv7-streamer | pve1 | 100.64.9.23 | TV-Proxy (3000) | [`../tv7-streamer/README.md`](../tv7-streamer/README.md) |
| 109 | tv-proxy | pve1 | 100.64.9.24 | udpxy (4022) | – |
| 240 | mailcow | pve1 | 100.64.2.33 | Mailserver | [`email.md`](email.md) |
| 230 | pmg | pve3 | 100.64.2.31 | Mail-Gateway, Relay | [`../pmg/README.md`](../pmg/README.md) |
| 111 | cups-server | pve3 | 100.64.2.32 | Druck-API (8080) | [`email.md`](email.md#druck-per-mail-druckerr9-druckerr13) |
| 114 | authentik | pve2 | 100.64.2.37 | SSO (9000/9443), LDAP-Outpost (389/636) | – |
| 104 | nextcloud | pve1 | 100.64.2.36 | Nextcloud | – |
| 105 | rk-mqtt-server | pve1 | 100.64.2.51 | MQTT-Broker (1883, 9001) | `mqtt-*.md` |
| 106 | fileserver | pve2 | 100.64.2.28 (Dienstadresse `files.ad…` = 100.64.2.29, keepalived) | Samba, Dokumentenablage, Git-Backup | [`active-directory.md`](active-directory.md), [`../fileserver-lxc/README.md`](../fileserver-lxc/README.md) |
| 139 | euro-office | pve2 | 100.64.2.58 | Euro-Office DocumentServer für Nextcloud | [`euro-office.md`](euro-office.md) |
| 206 | fileserver2 | pve2 | 100.64.2.27 | Replikat (BACKUP für `.29`) | dito |
| 108 | dc1 | pve2 | 100.64.2.30 | Samba-AD-DC, Passwort-API (8446), Avatar-Sync | [`active-directory.md`](active-directory.md) |
| 136 | dc2 | pve3 | – | zweiter DC | [`../ad-dc/README.md`](../ad-dc/README.md) |
| 131 | core-messenger | pve2 | 100.64.2.56 | Messenger-Backend | – |
| 146 | speedtest | pve2 | 100.64.2.64 | LibreSpeed (nginx + php-fpm, ohne Telemetrie/DB, kein Zugriffslog) für die Rosenweg-Internet-App; `https://speedtest.rosenweg4303.ch/backend/` (`empty.php`, `garbage.php`, `getIP.php`), nur intern (Name nur im internen DNS, Traefik `ipAllowList` 100.64.0.0/10) | [`../edge-traefik/README.md`](../edge-traefik/README.md) |
| 260 | nfs-shared | pve2 | 100.64.2.35 | NFS | – |
| 500–518 | rw*-usernetze-router | pve1 | 100.64.x.250 | je ein Router pro Haus (`router-api`) | `routing.md` |
| 901 | iobroker-technik | – | 100.64.90.50 | ioBroker (Heizung), nur hinter Authentik | `edge-traefik/README.md` |

Die Adresse `100.64.2.27` gehörte früher der Swarm-VIP und ist heute CT 206.
Knoten in Klammern „(HA)“ und Einträge „–“ beim Knoten: vor `pct`-Befehlen
nachsehen.

## Geheimnisse und Umgebungsvariablen

- **Werte stehen nie im Repo und nie in der Doku**, nur im Passwortmanager und
  in den Dateien auf den Containern (`.env`, `/etc/default/*`, Modus 0600).
- Das Repo `github.com/Rosenweg/Website` ist öffentlich, und seine Historie
  enthält ältere Klartext-Geheimnisse. Sie gelten bis zur Rotation als bekannt
  (Liste und Reihenfolge: `sicherheit.md` Abschnitt 7.1).
- Fehlt eine Pflichtvariable, schaltet sich die Funktion ab (fail closed). Liste
  je Dienst: `sicherheit.md` Abschnitt 6.

| Dienst | Datei |
|---|---|
| API | `/opt/rosenweg-core/.env` (CT 128) |
| Energie | `/opt/rosenweg-energy/.env` (CT 129) |
| WhatsApp | `/opt/whatsapp-bot/.env` (CT 116) |
| Edge | `/etc/default/traefik`, `/etc/default/traefik-sync` (CT 245) |
| PBX | `/etc/default/asterisk-env`, `/etc/default/pbx-api`, `/etc/asterisk/manager.conf` (CT 220) |
| wg-control | `/etc/wg-control/env` (CT 113) |
| TV | `/etc/default/tv7-streamer` (CT 250) |
| Avatar-Sync | `/etc/default/sync-avatars-to-ad` (CT 108) |
| SSH-Zugang | `/etc/rosenweg-ssh.conf` (jeder aufgenommene Host) |

## Ausrollen nach Änderungen

Reihenfolge und Rückbau des Sicherheits-Rollouts vom 17.11.2026:
`sicherheit.md` Abschnitt 8. Für den Alltag:

| Was | Wie |
|---|---|
| API | `pct exec 128 -- sh -c "cd /opt/rosenweg-core && docker compose pull api && docker compose up -d api"` ([`website.md`](website.md#api-ausrollen-ct-128)) |
| Frontend-Konfiguration oder ganzer Stand | `/opt/rosenweg/repo/frontends-lxc/deploy.sh` im jeweiligen `fe-*` |
| einzelne Web-Dateien | `scripts/rw-web-ausrollen.sh` |
| Edge-Routen | `extra-routes.yml` nach `/etc/traefik/dynamic/` (CT 245) |
| übrige Dienste | jeweilige README (Tabelle oben) |

GitHub Actions baut bei jedem Push die Images (`rosenweg-api`,
`energy-collector`, `rosenweg-whatsapp-bot` …), rollt aber nichts aus.

## Active Directory, Fileserver

Siehe [`active-directory.md`](active-directory.md). Kurz: Domäne
`AD.ROSENWEG4303.CH`, NetBIOS `ROSENWEG`, dc1 (CT 108, `100.64.2.30`) und dc2
(CT 136). Die Passwort-API auf dc1 (`http://100.64.2.30:8446/`, Header
`Authorization: Bearer <AD_PASSWORD_API_SECRET>`) wird von der API beim
Passwortwechsel und beim Anlegen eines neuen Kontos durch Technik/Präsident
aufgerufen.

## Authentik (SSO)

- **Extern**: `https://authentik.rosenweg4303.ch` (über edge-traefik)
- **Intern** (Server-zu-Server): `http://100.64.2.37:9000` (`AUTHENTIK_URL` der API)
- **LDAP-Outpost**: `100.64.2.37:389` bzw. `:636` (Z-Push, Stationen)
- **Admin-Gruppe**: `Technik` (Prüfung ohne Gross/Klein)
- `grant_type=password` ist im OAuth2-Provider **nicht** aktiviert.
- Anmeldung der Website: OAuth mit signiertem, einmaligem State und
  Browser-Bindung (Cookie `rw_oauth_bind`), siehe `sicherheit.md` Abschnitt 4.1.

## Datenbanken

| DB | Wo | Benutzer | Passwort |
|---|---|---|---|
| `rosenweg` | Container `postgres` in CT 128, nur Docker-intern | `rosenweg` | `DB_PASSWORD` in `/opt/rosenweg-core/.env` |
| `energy` | Container `energy-db` in CT 129, Port 5432 nur für CT 128 (nftables) | `energy` | `ENERGY_DB_PASSWORD` in `/opt/rosenweg-energy/.env` **und** `/opt/rosenweg-core/.env` |

## Passwort-Sync

Passwortwechsel über `profil.html` setzt das Passwort in **Authentik** (Admin-API)
und im **AD** (Passwort-API auf dc1). Bedingungen seit 17.11.2026: Anmeldung
höchstens 15 Minuten alt („Jetzt neu anmelden“), 5 Versuche pro Stunde, danach
werden alle anderen Sitzungen beendet. Fehlt `AD_PASSWORD_API_SECRET`, wird nur
Authentik gesetzt (Meldung „Windows-Anmeldung wird nicht mitgeführt“).

## Überwachung

- **Dienstwacht** (`scripts/rw-dienstwacht.sh` auf jedem Knoten, alle 15 Min):
  meldet fehlgeschlagene oder hängende Units in Knoten und Containern an die API;
  neue Befunde gehen an die Technik-WhatsApp-Gruppe, verstummte Knoten zusätzlich
  per Mail.
- **NOC** `noc.rosenweg4303.ch`: ohne Token gekürzte Sicht; Token per
  `X-Noc-Token` bzw. `#token=` (`sicherheit.md` Abschnitt 4.7).

## HA-Umverteilung: Schwelle 40 % statt 20 % (18.09.2026)

`/etc/pve/datacenter.cfg`:
`crs: ha=dynamic,ha-auto-rebalance=1,ha-auto-rebalance-threshold=40,ha-rebalance-on-start=1`

Mit 20 % pendelten am 18.09.2026 ab 03:19 zwei Gaeste stuendlich zwischen
pve1 und pve2: dc1 (CT 108) 8 Mal, station-test (VM 117) 13 Mal. Der Cluster
war dabei fast leer (CPU 5–13 %, RAM 20–31 %) — die "Unwucht" war Rauschen,
und jede Korrektur kippte sie in die Gegenrichtung.

Fuer einen Container ist das nicht harmlos: **LXC laesst sich nicht live
verschieben, jeder Umzug ist Herunterfahren und Neustart.** dc1 wurde also
stuendlich neu gestartet. Dass es nur zwischen pve1 und pve2 pendelte, liegt
an der Regel `dc-getrennt` — dc2 steht auf pve3, dorthin darf dc1 nicht.

Abgestellt per `pvesh set /cluster/options --crs …`. Kommt das Pendeln
trotz 40 % wieder, ist der naechste Schritt `ha-auto-rebalance=0`:
beim Knotenausfall verteilt `ha=dynamic` weiterhin lastabhaengig, nur im
Normalbetrieb wird dann nichts mehr verschoben.
