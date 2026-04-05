# Energie-Monitoring — Rosenweg

## Übersicht

Erfasst Stromzähler-Daten der Rosenweg-Kooperation und stellt sie auf der Website dar.

```
Stromzähler (Modbus/API)
    │
    ▼
Energy Collector (Docker Service)
    │
    ▼
Energy DB (PostgreSQL)
    │
    ▼
API Server → Website (energie-monitor.html)
```

## Komponenten

### Energy Collector
- **Image**: `ghcr.io/rosenweg/energy-collector:latest`
- **Replicas**: 1
- Liest Zählerwerte und schreibt in die Energy-DB

### Energy DB
- **Image**: `postgres:17-alpine`
- **User**: `energy`
- **Password**: `energy2026`
- **DB**: `energy`
- **Host**: `energy-db` (Docker-intern)

### API Endpunkte
- `GET /api/energy/meters` — Zähler-Liste
- `GET /api/energy/readings` — Messwerte
- `GET /api/energy/tariffs` — Tarife

### Tarife
- **Netztarif**: Netzstrom-Tarif
- **Solartarif**: Solar-Eigenstrom-Tarif

## Website-Seiten
- `/energie-monitor.html` — Verbrauch, Charts, Tarife (Bewohner)
- `/energie-config.html` — Tarife/Zähler konfigurieren (Admin)
- `/zaehler.html` — Zähler-Verwaltung
