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

Container läuft als Docker-Swarm-Service `rosenweg_shelly-emulator`.

```bash
# Build + Push lokal
cd shelly-emulator/
docker build -t ghcr.io/rosenweg/shelly-emulator:latest .
docker push ghcr.io/rosenweg/shelly-emulator:latest

# Deploy via Stack (siehe docker-stack.yml)
```

Env-Vars:

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
- **Port 80**: läuft im Container auf 80, im Swarm-Stack auf einen freien Host-Port mappen
  oder im Overlay nur intern

## Variante A (Shelly-Script)

Wer keinen extra Service hosten will und einen Plus/Pro-Shelly verfügbar hat,
verwendet [Variante A](shelly-virtual-pv-ueberschuss.md) — gleicher Effekt aber
ohne Container.
