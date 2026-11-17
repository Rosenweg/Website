# Shelly Pro 3EM Emulator: PV-Überschuss Rosenweg 9 (Variante B)

Standalone-Service der ein virtuelles **Shelly Pro 3EM Gen2** Energiemessgerät emuliert
und die zwei Überschuss-Werte als Phase-Leistungen ausspielt. Auto-Discovery via mDNS.

Im Unterschied zu [Variante A](shelly-virtual-pv-ueberschuss.md): braucht **kein Host-Shelly**,
erscheint als eigenständiges Gerät im Shelly-Ökosystem, kann von mehreren Apps/Tools
gleichzeitig genutzt werden.

## Daten-Mapping

| Phase | Datenpunkt | Bedeutung |
|---|---|---|
| **A** (em:0/a_act_power) | `surplus_without_boiler_w` | Real ins Netz gehender Überschuss |
| **B** (em:0/b_act_power) | `surplus_with_boiler_w` | Theoretischer Überschuss wenn Boiler aus |
| **C** (em:0/c_act_power) | `heizstab_w` | Aktueller Boiler-Verbrauch |

Spannung pro Phase fix 230V, Frequenz 50Hz, PF 1.0 — Shelly-EM erwartet diese Felder.

## Architektur

```
                   ┌─────────────────────┐
                   │  energy-collector   │
                   │  /api/energy/shelly │
                   └──────────┬──────────┘
                              │ HTTPS, alle 10s
                              ▼
                   ┌──────────────────────┐
                   │  shelly-emulator     │
                   │  - HTTP-RPC :80      │
                   │  - mDNS announce     │
                   └──────────┬───────────┘
                              │ /rpc/EM.GetStatus
              ┌───────────────┼──────────────────┐
              ▼               ▼                  ▼
      ┌────────────┐  ┌────────────┐    ┌──────────────────┐
      │ Shelly App │  │ Home Asst. │    │ andere Shellys   │
      │ (Cloud)    │  │            │    │ (Scenes/Scripts) │
      └────────────┘  └────────────┘    └──────────────────┘
```

## Deployment

Der Container läuft auf dem Backend-LXC CT 128 als Dienst `shelly-emulator` im
Compose-Projekt `/opt/rosenweg-core/` (Datei im Repo: `backend-lxc/core/compose.yml`),
veröffentlicht auf Host-Port **8089**. Die frühere Docker-Swarm-Variante
(`rosenweg_shelly-emulator`, `docker-stack.yml`) ist abgelöst.

```bash
# Image bauen und veröffentlichen (lokal oder per CI)
cd shelly-emulator/
docker build -t ghcr.io/rosenweg/shelly-emulator:latest .
docker push ghcr.io/rosenweg/shelly-emulator:latest

# Auf CT 128 aktualisieren
cd /opt/rosenweg-core && docker compose pull shelly-emulator && docker compose up -d shelly-emulator
```

Die Datenquelle `/api/energy/shelly` ist eine der offenen Energie-Routen (ohne
Anmeldung, ohne Personendaten); die Sicherheitsänderungen vom 17.11.2026 betreffen
den Emulator nicht. Details: [`docs/energie-api.md`](../docs/energie-api.md).

Env-Vars (Werte in `backend-lxc/core/compose.yml`: `POLL_MS=10000`, `ENERGY_GROUP=r9`,
`SHELLY_HOSTNAME=shellypvrosenweg9`, `PORT=8089`):

| Var | Default | Bedeutung |
|---|---|---|
| `BACKEND_URL` | `https://www.rosenweg4303.ch/api/energy/shelly` | Datenquelle |
| `POLL_MS` | `10000` | Polling-Intervall in ms |
| `ENERGY_GROUP` | `r9` | Gruppe im Energy-Collector |
| `SHELLY_HOSTNAME` | `shellypvrosenweg9` | Hostname für mDNS |
| `SHELLY_MAC` | (deterministisch aus Hostname) | Override falls nötig |
| `PORT` | `80` | HTTP-Port |

## Discovery im Netz

Nach Start ist das Gerät erreichbar:

- **mDNS Hostname**: `shellypvrosenweg9.local`
- **mDNS Service**: `_shelly._tcp.local`
- **Direkter Zugriff**: `http://<container-ip>/` (HTML-Übersicht), `/rpc/Shelly.GetDeviceInfo`, `/rpc/EM.GetStatus?id=0`

In der **Shelly Smart Control App** sollte das Gerät unter „Gerät hinzufügen" als
"Shelly Pro 3EM" mit Namen *Rosenweg 9 PV-Ueberschuss (virtual)* auftauchen.
Wenn nicht — manuell hinzufügen via IP/Hostname.

## Verfügbare Endpunkte (Shelly Gen2 RPC kompatibel)

```
GET  /                                — HTML-Übersicht
GET  /shelly                          — Legacy Discovery
GET  /rpc/Shelly.GetDeviceInfo
GET  /rpc/Shelly.GetStatus
GET  /rpc/Shelly.GetConfig
GET  /rpc/EM.GetStatus?id=0
GET  /rpc/EM.GetConfig?id=0
POST /rpc                             — JSON-RPC 2.0 multiplex
GET  /health                          — Status + Cache-Alter
```

## Was geht / was geht nicht

**Funktioniert:**
- Erkannt als Shelly Pro 3EM in Shelly Smart Control / mobile App
- In Cloud-Scenes als Trigger-Quelle nutzbar (z.B. "Wenn Phase A Power > 1500W")
- Integration in Home Assistant via Shelly-Integration
- Integration in andere Tools die Shelly-RPC sprechen (Node-RED, ioBroker etc.)
- Mehrere Konsumenten gleichzeitig

**Nicht implementiert:**
- WebSocket-Notifications (Notify-Events) — Konsumenten müssen pollen
- Konfiguration via RPC (read-only)
- Energy-Counter (kWh) — nur Live-Werte, keine kumulativen Zähler
- Authentifizierung — read-only, kein Bedarf

## Limits / Was zu beachten

- **Stale-Detection**: Wenn der Backend-Poll seit >30s keinen Erfolg hatte, werden die
  EM-Werte auf 0 gesetzt (statt veraltete Daten zu zeigen)
- **mDNS** funktioniert nur im selben Layer-2-Netz. Wenn der konsumierende Shelly oder
  HA in einem anderen VLAN sitzt, manuelle IP-Eintragung erforderlich
- **Port**: Standard im Code ist 80; auf CT 128 läuft der Dienst mit `PORT=8089` und
  ist unter `http://100.64.2.52:8089/` erreichbar (Hausnetz). Shelly-Clients, die
  Port 80 erwarten, brauchen die Adresse mit Port.
- **mDNS über Docker**: Der Container läuft im Bridge-Netz von Docker; mDNS-Ankündigungen
  erreichen das Hausnetz darum möglicherweise nicht. Im Zweifel das Gerät manuell
  per IP und Port hinzufügen.

## Variante A (Shelly-Script)

Wer keinen extra Service hosten will und einen Plus/Pro-Shelly verfügbar hat,
verwendet [Variante A](shelly-virtual-pv-ueberschuss.md) — gleicher Effekt aber
ohne Container.
