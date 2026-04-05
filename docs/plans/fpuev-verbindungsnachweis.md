# FPÜV Verbindungsnachweis

## Anforderung

Gemäss Schweizer Fernmeldeüberwachungsverordnung (FPÜV/BÜPF) muss als Internetzugangs-Anbieter nachgewiesen werden können, welcher Nutzer/Haushalt zu welchem Zeitpunkt verbunden war.

## Ist-Zustand

### Was UniFi liefert
- **Aktive Clients** (`stat/sta`): MAC, IP, Netzwerk, `assoc_time`, `first_seen`, `last_seen`
- **Alle bekannten Clients** (`stat/alluser`): 232 Geräte, letzte Verbindung, letztes Netzwerk
- **PPSK-Zuordnung**: Jedes Passwort → ein VLAN → ein Haushalt/Gebäude

### Was fehlt
- **Session-History**: UniFi speichert keine langfristige Verbindungshistorie per API
- **Zuordnung MAC → Person**: Nur über PPSK → Netzwerk → Gebäude möglich (nicht Einzelperson)

## Lösung: Syslog + Polling Hybrid

### Konzept

Zwei Datenquellen für maximale Abdeckung:

1. **UDM Remote Syslog** (Primär): Echtzeit connect/disconnect Events, sekundengenau
2. **UniFi API Polling** (Ergänzend): Alle 5 Min Snapshot aller verbundenen Clients als Fallback

```
UDM-Pro
    │
    ├── Syslog (UDP 514) ──► Syslog Collector (Docker Service)
    │   connect/disconnect       │
    │   Events in Echtzeit       │
    │                            ▼
    └── API (stat/sta) ──► API Server (Cronjob alle 5 Min)
        aktive Clients           │
                                 ▼
                          PostgreSQL (connection_log)
                                 │
                                 ▼
                          API Endpoint → Admin-Seite
                          (Abfrage, CSV-Export)
```

### UDM Syslog Konfiguration

In der UDM unter **Settings → System → Remote Logging**:
- **Syslog Server**: `100.64.2.24` (CT 201, Docker Swarm)
- **Port**: `5514` (non-privileged, Docker published)
- **Level**: `Information` (enthält connect/disconnect)

### Syslog Event-Formate (UniFi)

Connect:
```
<TIMESTAMP> UDM-Pro kernel: [UFW] ALLOW IN=br99 SRC=100.64.99.x ...
```

WiFi Associate/Disassociate:
```
<TIMESTAMP> UDM-Pro hostapd: wlan0: STA xx:xx:xx:xx:xx:xx IEEE 802.11: associated
<TIMESTAMP> UDM-Pro hostapd: wlan0: STA xx:xx:xx:xx:xx:xx IEEE 802.11: disassociated
```

DHCP Lease:
```
<TIMESTAMP> UDM-Pro dnsmasq-dhcp: DHCPACK(br99) 100.64.99.x xx:xx:xx:xx:xx:xx hostname
```

### Syslog Collector (Docker Service)

Leichtgewichtiger Container der:
1. UDP 5514 empfängt
2. Events parst (Regex für associate/disassociate/DHCP)
3. In PostgreSQL `connection_log` schreibt

Optionen:
- **Custom Python Script** (einfach, volle Kontrolle)
- **rsyslog + ompgsql** (rsyslog schreibt direkt in PostgreSQL)
- **Vector/Fluentd** (Log-Pipeline, overhead)

### Datenmodell

```sql
CREATE TABLE connection_log (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    mac VARCHAR(17) NOT NULL,
    ip VARCHAR(45),
    hostname VARCHAR(255),
    network_name VARCHAR(100),       -- z.B. "RW9-Clients"
    vlan INT,
    ap_name VARCHAR(100),            -- z.B. "WLAN-AP R9 Heizungsraum"
    ap_mac VARCHAR(17),
    is_wired BOOLEAN DEFAULT FALSE,
    signal INT,                      -- RSSI (nur WLAN)
    rx_bytes BIGINT,
    tx_bytes BIGINT
);

CREATE INDEX idx_connlog_mac ON connection_log(mac);
CREATE INDEX idx_connlog_network ON connection_log(network_name);
CREATE INDEX idx_connlog_timestamp ON connection_log(timestamp);
```

### PPSK → Haushalt Zuordnung

Da PPSK ein Gerät automatisch ins richtige VLAN setzt, können wir aus dem `network_name` den Haushalt ableiten:

| Netzwerk | VLAN | Gebäude |
|----------|------|---------|
| RW1-Clients | 19 | Rosenweg 1 |
| RW2-Clients | 29 | Rosenweg 2 |
| ... | ... | ... |
| RW18-Clients | 189 | Rosenweg 18 |
| MUELLER-911 | 911 | Bewohner-VLAN (individuell) |

Für Bewohner-VLANs (911+) ist die Zuordnung 1:1 zu einer Person.
Für Gebäude-VLANs ist die Zuordnung zum Haushalt/Gebäude.

### Collector Script

Mögliche Implementierung:
1. **Im API-Server** (Node.js): Neuer Cronjob der alle 5 Min `stat/sta` pollt
2. **Separater Service**: Python-Script als Docker Service oder Cron auf CT 201
3. **Syslog**: UniFi kann Events an einen Syslog-Server senden (connect/disconnect)

#### Empfehlung: Custom Python Syslog Collector
- Einfach, keine externen Dependencies
- Volle Kontrolle über Parsing und DB-Schema
- Als Docker Service im Swarm (1 Replica)
- Nutzt bestehende `rosenweg_postgres` DB

#### API-Server Polling (Ergänzend)
- Neuer Cronjob im API-Server
- Alle 5 Min Snapshot als Fallback (falls Syslog-Packet verloren)
- Fängt auch kabelgebundene Clients ab die kein WiFi-Event haben

### Aufbewahrung
- FPÜV verlangt **6 Monate** Aufbewahrung
- Bei 60 Clients × 288 Polls/Tag (alle 5 Min) = ~17'280 Einträge/Tag
- 6 Monate ≈ 3.1 Mio Einträge → ca. 500MB
- Automatisches Löschen nach 6 Monaten per Cronjob

### API Endpoint (Admin)

```
GET /api/connections?mac=xx:xx:xx&from=2026-01-01&to=2026-03-29
GET /api/connections?network=RW9-Clients&from=2026-03-01&to=2026-03-29
```

Nur für Technik-Gruppe zugänglich.

### Admin-Seite

Einfache Suchmaske:
- Zeitraum (von/bis)
- MAC-Adresse (optional)
- Netzwerk/Gebäude (Dropdown)
- Exportmöglichkeit als CSV

## Umsetzung

### Phase 1: Syslog Collector
- [ ] `connection_log` Tabelle in `rosenweg_postgres` erstellen
- [ ] Python Syslog Collector als Docker Service (`rosenweg_syslog-collector`)
- [ ] Dockerfile + Image bauen, in `ghcr.io/rosenweg/syslog-collector`
- [ ] Port 5514/UDP im Docker Swarm publishen
- [ ] UDM Remote Syslog auf `100.64.2.24:5514` konfigurieren
- [ ] Testen: connect/disconnect Events kommen an und werden in DB geschrieben

### Phase 2: API Polling (Fallback)
- [ ] Cronjob im API-Server: alle 5 Min UniFi `stat/sta` pollen
- [ ] Snapshot in `connection_log` schreiben (source=`poll`)
- [ ] Deduplizierung: nur schreiben wenn Client neu oder Netzwerk gewechselt

### Phase 3: API Endpoint + Admin-Seite
- [ ] `GET /api/connections` Endpoint (Admin-only)
- [ ] Filter: Zeitraum, MAC, Netzwerk/Gebäude, IP
- [ ] CSV-Export für Behördenanfragen
- [ ] Admin-Seite `verbindungen.html` mit Suchmaske

### Phase 4: Aufräumen + Monitoring
- [ ] Cronjob: Einträge älter als 6 Monate automatisch löschen
- [ ] Service Watchdog überwacht den Collector
- [ ] Alert (Email) wenn länger als 15 Min keine Events ankommen

## Datenmodell (erweitert)

```sql
CREATE TABLE connection_log (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type VARCHAR(20) NOT NULL,  -- 'connect', 'disconnect', 'dhcp', 'snapshot'
    source VARCHAR(10) NOT NULL,       -- 'syslog' oder 'poll'
    mac VARCHAR(17) NOT NULL,
    ip VARCHAR(45),
    hostname VARCHAR(255),
    network_name VARCHAR(100),
    vlan INT,
    ap_name VARCHAR(100),
    ap_mac VARCHAR(17),
    is_wired BOOLEAN DEFAULT FALSE,
    signal_dbm INT,
    rx_bytes BIGINT,
    tx_bytes BIGINT,
    raw_message TEXT                    -- Original Syslog-Zeile (für Audit)
);

CREATE INDEX idx_connlog_timestamp ON connection_log(timestamp);
CREATE INDEX idx_connlog_mac ON connection_log(mac);
CREATE INDEX idx_connlog_network ON connection_log(network_name);
CREATE INDEX idx_connlog_event ON connection_log(event_type);
CREATE INDEX idx_connlog_ip ON connection_log(ip);

-- Automatisches Löschen nach 6 Monaten
CREATE OR REPLACE FUNCTION cleanup_old_connections() RETURNS void AS $$
BEGIN
    DELETE FROM connection_log WHERE timestamp < NOW() - INTERVAL '6 months';
END;
$$ LANGUAGE plpgsql;
```

## Speicherbedarf

| Szenario | Einträge/Tag | 6 Monate | Grösse |
|----------|-------------|----------|--------|
| Syslog (60 Clients, ~10 Events/Client/Tag) | ~600 | ~110'000 | ~30MB |
| Polling (60 Clients, 288 Polls/Tag) | ~17'280 | ~3.1 Mio | ~500MB |
| Kombiniert | ~18'000 | ~3.2 Mio | ~530MB |

## PPSK → Haushalt Mapping

| Netzwerk | VLAN | Gebäude | Identifikation |
|----------|------|---------|---------------|
| RW1-Clients | 19 | Rosenweg 1 | Gebäude-Level |
| RW2-Clients | 29 | Rosenweg 2 | Gebäude-Level |
| RW4-Clients | 49 | Rosenweg 4 | Gebäude-Level |
| RW5-Clients | 59 | Rosenweg 5 | Gebäude-Level |
| RW6-Clients | 69 | Rosenweg 6 | Gebäude-Level |
| RW8-Clients | 89 | Rosenweg 8 | Gebäude-Level |
| RW9-Clients | 99 | Rosenweg 9 | Gebäude-Level |
| RW10-Clients | 109 | Rosenweg 10 | Gebäude-Level |
| RW12-Clients | 129 | Rosenweg 12 | Gebäude-Level |
| RW13-Clients | 139 | Rosenweg 13 | Gebäude-Level |
| RW14-Clients | 149 | Rosenweg 14 | Gebäude-Level |
| RW16-Clients | 169 | Rosenweg 16 | Gebäude-Level |
| RW17-Clients | 179 | Rosenweg 17 | Gebäude-Level |
| RW18-Clients | 189 | Rosenweg 18 | Gebäude-Level |
| MUELLER-911+ | 911+ | Bewohner-VLAN | Einzelperson |
| Rosenweg-Guest | 8 | Gast-WLAN | Nur MAC/IP |

## Rechtliche Aspekte

### FPÜV/BÜPF Anforderungen
- **Aufbewahrungsfrist**: 6 Monate
- **Auskunftspflicht**: Auf Anfrage der Behörden muss nachgewiesen werden können, welcher Anschlussinhaber (Haushalt) zu einem bestimmten Zeitpunkt eine bestimmte IP hatte
- **DHCP-Logs**: IP-Zuweisungen sind der Kern — welche IP zu welcher MAC zu welchem Zeitpunkt

### Datenschutz (DSG)
- Bewohner müssen über die Protokollierung informiert werden
- Zweckbindung: nur für Behördenanfragen, nicht für Überwachung
- Zugriff nur für Technik-Gruppe (Admin)
- Automatische Löschung nach 6 Monaten

### Empfehlung
- Datenschutz-Hinweis in den Nutzungsbedingungen des WLAN
- Information an Bewohner bei Einführung
- Technische Zugangskontrolle: nur Technik-Admins sehen die Logs

## Offene Fragen
- [ ] Müssen Gast-WLAN Verbindungen auch protokolliert werden? (Captive Portal mit Akzeptanz der AGB?)
- [ ] Braucht es eine Vereinbarung mit den Bewohnern?
- [ ] Soll der Syslog Collector auch andere UDM-Events speichern (Firewall, IDS)?
