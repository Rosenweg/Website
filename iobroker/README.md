# ioBroker-Artefakte (CT901, 100.64.90.50)

## heizung-operator.html — Operator-Ansicht Heizungsraum (DeltaV-Stil)
Eigene HMI-Seite (SVG-Anlagenschema), ausgeliefert vom ioBroker **web**-Adapter (Port 8082),
**live via socket.io** (web.0, auth=false → anonym). Liest States: Shelly-Kessel oben/unten,
Heizstab-Leistung (mqtt.0.energy.r9.heizstab.power_w / SmartFox), Lüfter, Gaswarner, Raumklima.

**Deploy** (Quelle = diese Datei): auf CT901
`iobroker file write <lokal>/heizung-operator.html /web.0/heizung/index.html`
**URL:** http://100.64.90.50:8082/web.0/heizung/index.html

## heizstab-bridge.js — Heizstab Manuell/Auto -> SmartFox Modbus (ioBroker-JS)
systemd-Dienst auf CT901 (`/opt/heizstab-bridge.py`, Unit `heizstab-bridge.service`).
Liest Modus aus ioBroker via **simple-api** (REST :8087, `0_userdata.0.heizstab.mode` / `.manual_on`),
stellt **SmartFox 100.64.90.62** per Modbus TCP (FC 0x10!) self-healing (alle 3 s, nur bei Abweichung):
- AUTO -> HReg **40400=0** (Control via Modbus aus -> SmartFox regelt per PV)
- MANUELL -> **40400=1**, **40401**=Stellwert (0.1%-Schritte: 1000=100%/EIN, 0=AUS)
- Ist-Leistung lesbar in 41047 (Aout %). Adressen literal (kein Modicon-Offset). SmartFox quittiert Writes verzögert -> Read-Back zählt. NIE zwei Modbus-Clients gleichzeitig (Race).
Deploy: Datei nach /opt/heizstab-bridge.py + Unit nach /etc/systemd/system/, `systemctl enable --now heizstab-bridge`.

## shelly-ble-gateway-v1.2.js — Shelly BLU lesen (BLE-Gateway-Script)
Gen2-Shelly als BLE-Gateway für BLU-Geräte (H&T/Motion). **Version MUSS zum Adapter passen**: shelly 10.6.1 → **v1.2** (v1.3 erst ≥11). Quelle: iobroker.shelly-Doku am Tag v10.3.0. Deploy auf die netzbetriebenen Plus1PM via RPC `Script.Stop`→`PutCode`(chunked)→`SetConfig enable`→`Start`. Werte: `shelly.0.ble.<mac>.{temperature,humidity,battery,…}`.

## heizraum-temp.js — Heizraum-Temp-Wächter (eigenständig im ioBroker, OHNE Kern-API)
ioBroker-JavaScript `script.js.Heizung.heizraum_temp` (CT901). Liest beide H&T (BLU `0c:ef:f6…` + WiFi `08b61fccf7a0`) nativ, postet bei Übertemperatur **direkt** an den WhatsApp-Gateway `http://100.64.2.39:8090/gateway/send` (Header `X-Messaging-Key`, Body `{channel,to,body}`), Ziel = Technik-Gruppe `120363407257445046@g.us`. Warn 40 °C / Alarm 45 °C, Anti-Spam (Flanke + 6h-Reminder nur im Alarm + Entwarnung, State in `0_userdata.0.heizraum.*`), Redundanz/blind-Erkennung. Bewusst NICHT in der Kern-API (kein Single Point of Failure). Deploy: `iobroker object set <id> '{minimal}'` dann `iobroker object set <id> "common.source=$(cat ...)"` (CLI splittet am ERSTEN `=`), dann `common.enabled=true`.

**Update:** Der Heizstab läuft jetzt als ioBroker-JavaScript `script.js.Heizung.heizstab` (Repo `iobroker/heizstab-bridge.js`, Modbus via `require('net')`, `on()`-Trigger + 3s-Self-Heal) — der frühere Python-systemd-Dienst (heizstab-bridge.service) ist **gestoppt + disabled** (durch den 2-Schritt-Script-Trick nicht mehr nötig). Einheitlich „alles im ioBroker".
