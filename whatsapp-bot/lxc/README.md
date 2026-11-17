# WhatsApp-Bridge — eigener LXC (CT 116)

Stand: 17.11.2026. Funktionsbeschreibung, Rollen und Regeln für Mail→WhatsApp:
[`../README.md`](../README.md). Sicherheitsregeln im Überblick:
[`../../docs/sicherheit.md`](../../docs/sicherheit.md) Abschnitt 4.8.

Seit dem 19.06.2026 läuft die WhatsApp-Bridge nicht mehr im Docker-Swarm, sondern
in **CT 116 `whatsapp-bridge`, 100.64.2.39**, Disk auf Ceph `lxcs`,
**HA-schwebend** (kein fester Knoten, im Normalfall pve3). Grund für den
Umzug: Das lokale Session-Volume zwang den Swarm-Dienst auf einen Knoten, und
der langsame Image-Pull liess die Bridge immer wieder abstürzen. Heute wandert
die Sitzung mit der Ceph-Disk mit (Failover getestet, ~48 s, kein neues Koppeln).

`pct`-Befehle funktionieren nur auf dem Knoten, auf dem der Container gerade
läuft. Nachsehen:

```bash
ssh root@100.64.2.20 'ha-manager status | grep ct:116'
```

Die Beispiele unten nehmen pve3 (`100.64.2.22`) an.

## CT 116

- Debian 13, unprivilegiert, `features: nesting=1,keyctl=1`,
  `lxc.apparmor.profile: unconfined` (für Docker und Chromium), 2 Kerne, 3 GB RAM,
  12 GB Ceph-Disk.
- Docker CE + Compose aus dem offiziellen Repo. Anmeldung an ghcr.io in
  `/root/.docker/config.json`.
- `ha-manager add ct:116 --state started`.

## Dateien

| Repo | Ziel in CT 116 | Inhalt |
|---|---|---|
| `compose.yml` | `/opt/whatsapp-bot/compose.yml` | Dienst, Ports 8080/8090/2525, Umgebung ohne Geheimnisse |
| – | `/opt/whatsapp-bot/.env` (0600, **nie im Repo**) | `WHATSAPP_SHARED_SECRET=<im Passwortmanager>`, ggf. `GW_SMTP_PASS`, `GW_NOTIFY_RELAY_PASS` |
| `wa-2525-fw.nft` | `/etc/rosenweg/wa-2525-fw.nft` | nftables-Regeln: 2525 nur von PMG, IPv4 und IPv6 |
| `wa-2525-fw.service` | `/etc/systemd/system/wa-2525-fw.service` | lädt die Regeln beim Start (nach `nftables.service`, vor Docker) |
| – | Volume `whatsapp-bot_whatsapp-data` | gekoppelte WhatsApp-Sitzung + `gateway.sqlite` (Daten siehe [`gateway-data.md`](gateway-data.md)) |

## Ausrollen

### Neues Image

```bash
ssh root@100.64.2.22 'pct exec 116 -- sh -c "cd /opt/whatsapp-bot && docker compose pull && docker compose up -d"'
```

Das Image `ghcr.io/rosenweg/rosenweg-whatsapp-bot:latest` baut GitHub Actions bei
jedem Push. Eine geänderte `compose.yml` vorher nach `/opt/whatsapp-bot/`
kopieren (seit 17.11.2026 neu darin: `GW_SMTP_STRENG_IPS: "100.64.2.31"`).

### Firewall für Port 2525 (einmalig, seit 17.11.2026)

Bis zum 17.11.2026 schützte eine iptables-Regel nur IPv4; über IPv6 war 2525
offen. Die nftables-Tabelle `inet rw_wa_2525` filtert beide Protokolle (Hooks
`forward` für Dockers IPv4-DNAT und `input` für den IPv6-docker-proxy).
**IPv6 bleibt eingeschaltet** – PMG liefert über IPv4 ein; soll PMG einmal per
IPv6 einliefern, seine IPv6-Adresse in das Set `smtp_clients6` eintragen.

```bash
# vom Repo-Wurzelverzeichnis aus
scp whatsapp-bot/lxc/wa-2525-fw.nft whatsapp-bot/lxc/wa-2525-fw.service root@100.64.2.22:/tmp/
ssh root@100.64.2.22 '
  pct exec 116 -- mkdir -p /etc/rosenweg
  pct push 116 /tmp/wa-2525-fw.nft /etc/rosenweg/wa-2525-fw.nft
  pct push 116 /tmp/wa-2525-fw.service /etc/systemd/system/wa-2525-fw.service
  pct exec 116 -- sh -c "systemctl daemon-reload && systemctl enable --now wa-2525-fw && systemctl restart wa-2525-fw"
  # alte iptables-Regel einmalig entfernen (Fehlermeldung, falls schon weg, ist harmlos)
  pct exec 116 -- iptables -D DOCKER-USER -p tcp --dport 2525 ! -s 100.64.2.31 -j DROP'
```

## Prüfen

```bash
# Container und Dienste
ssh root@100.64.2.22 'pct exec 116 -- sh -c "docker ps --filter name=whatsapp-bot; curl -s localhost:8080/health; curl -s localhost:8090/gateway/health"'
# Firewall aktiv?
ssh root@100.64.2.22 'pct exec 116 -- nft list table inet rw_wa_2525'
ssh root@100.64.2.22 'pct exec 116 -- systemctl is-active wa-2525-fw'
# Von einem anderen Host im LAN (nicht PMG) muss 2525 abgewiesen werden, IPv4 und IPv6:
nc -vz -w 3 100.64.2.39 2525          # erwartet: Connection refused
nc -vz -w 3 -6 <IPv6 von CT 116> 2525  # erwartet: Connection refused
# Proxy-Positivliste: alles ausser den Anmelde-Pfaden -> 404
curl -s -o /dev/null -w '%{http_code}\n' https://whatsapp.rosenweg4303.ch/api/reklamationen/oeffentlich   # 404
curl -s -o /dev/null -w '%{http_code}\n' https://whatsapp.rosenweg4303.ch/api/auth/me                     # 401 (ohne Anmeldung)
# Ablehnungen im Log
ssh root@100.64.2.22 'pct exec 116 -- docker logs --since 1h whatsapp-bot 2>&1 | grep -E "abgewiesen|Empfaenger abgewiesen"'
```

Eine Testmail über PMG an einen Alias (z. B. `stefan-test@whatsapp.rosenweg4303.ch`)
von einer Adresse aus `smtp_senders` muss ankommen; dieselbe Mail an
`41790000000@whatsapp.rosenweg4303.ch` muss mit `550` abgewiesen werden.

## Verdrahtung (wer auf .39 zeigt)

- **Edge-Route** `isp_reverse_proxy_routes` id=25: `whatsapp.rosenweg4303.ch` →
  `http://100.64.2.39:8090`.
- **PMG-Transport** (CT 230): `whatsapp.rosenweg4303.ch` → `intern:[100.64.2.39]:2525`
  (eigener Transport ohne Ausweich-Relay, gepflegt von `pmg-restore-relay.sh`,
  siehe `pmg/README.md`).
- **API → Gateway** (`/opt/rosenweg-core/.env` auf CT 128):
  `GATEWAY_SEND_URL=http://100.64.2.39:8090/gateway/send`,
  `GATEWAY_GROUPS_URL=http://100.64.2.39:8080/groups`.
- **Gateway → API:** `API_BASE`/`MAIN_API_BASE` = `http://100.64.2.52:3000` (CT 128).
- **PBX-Voicemail** (CT 220): `https://whatsapp.rosenweg4303.ch/gateway/send` mit
  Schlüssel `mg_…` (`GATEWAY_API_KEY` in `/etc/default/pbx-api`).

## Zurückbauen

- **Image:** in `compose.yml` statt `:latest` ein früheres Tag (Git-SHA) eintragen,
  `docker compose up -d`.
- **Absender-/Empfängerregel (17.11.2026):** `GW_SMTP_STRENG_IPS` auf einen Wert
  setzen, der keine echte Quelle ist (z. B. `127.0.0.2`), dann gilt PMG wieder als
  vertrauenswürdige Quelle. Achtung: Dann kann **jede** Mail aus dem Internet über
  PMG in Gruppen posten und beliebige Nummern anschreiben – nur als
  Notmassnahme.
- **Firewall:** `systemctl stop wa-2525-fw` löscht die Tabelle (Port dann für alle
  offen). Die frühere Unit liegt als
  `/etc/systemd/system/wa-2525-fw.service.vor-sicherheit-2026-11-17`.
- **Swarm-Rückweg** gibt es nicht mehr (Swarm abgebaut).
