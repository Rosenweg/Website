# ioBroker-Artefakte (CT901, 100.64.90.50)

## heizung-operator.html — Operator-Ansicht Heizungsraum (DeltaV-Stil)
Eigene HMI-Seite (SVG-Anlagenschema), ausgeliefert vom ioBroker **web**-Adapter (Port 8082),
**live via socket.io** (web.0, auth=false → anonym). Liest States: Shelly-Kessel oben/unten,
Heizstab-Leistung (mqtt.0.energy.r9.heizstab.power_w / SmartFox), Lüfter, Gaswarner, Raumklima.

**Deploy** (Quelle = diese Datei): auf CT901
`iobroker file write <lokal>/heizung-operator.html /web.0/heizung/index.html`
**URL:** http://100.64.90.50:8082/web.0/heizung/index.html

## heizstab-bridge (Heizstab Manuell/Auto -> SmartFox Modbus)
systemd-Dienst auf CT901 (`/opt/heizstab-bridge.py`, Unit `heizstab-bridge.service`).
Liest Modus aus ioBroker via **simple-api** (REST :8087, `0_userdata.0.heizstab.mode` / `.manual_on`),
stellt **SmartFox 100.64.90.62** per Modbus TCP (FC 0x10!) self-healing (alle 3 s, nur bei Abweichung):
- AUTO -> HReg **40400=0** (Control via Modbus aus -> SmartFox regelt per PV)
- MANUELL -> **40400=1**, **40401**=Stellwert (0.1%-Schritte: 1000=100%/EIN, 0=AUS)
- Ist-Leistung lesbar in 41047 (Aout %). Adressen literal (kein Modicon-Offset). SmartFox quittiert Writes verzögert -> Read-Back zählt. NIE zwei Modbus-Clients gleichzeitig (Race).
Deploy: Datei nach /opt/heizstab-bridge.py + Unit nach /etc/systemd/system/, `systemctl enable --now heizstab-bridge`.
