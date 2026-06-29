# ioBroker-Artefakte (CT901, 100.64.90.50)

## heizung-operator.html — Operator-Ansicht Heizungsraum (DeltaV-Stil)
Eigene HMI-Seite (SVG-Anlagenschema), ausgeliefert vom ioBroker **web**-Adapter (Port 8082),
**live via socket.io** (web.0, auth=false → anonym). Liest States: Shelly-Kessel oben/unten,
Heizstab-Leistung (mqtt.0.energy.r9.heizstab.power_w / SmartFox), Lüfter, Gaswarner, Raumklima.

**Deploy** (Quelle = diese Datei): auf CT901
`iobroker file write <lokal>/heizung-operator.html /web.0/heizung/index.html`
**URL:** http://100.64.90.50:8082/web.0/heizung/index.html
