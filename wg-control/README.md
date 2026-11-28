# wg-control

Stand: 17.11.2026. Sicherheitsregeln im Überblick:
[`../docs/sicherheit.md`](../docs/sicherheit.md) (Variablen Abschnitt 6.3,
Grenzwerte für VPN-Konten und Stations-Tunnel Abschnitt 5).

Der Dienst, der die WireGuard-Zugänge des Hauses ausgibt. Er läuft auf
**CT 113 (`vpn-wg`, pve1)** unter `/opt/wg-control` als systemd-Dienst
`wg-control` und hört auf Port `3001` (`100.64.2.34:3001`).

Er verwaltet die Peers, schreibt `wg0.conf`, hält die Schnittstelle im
Gleichstand und liefert jedem Zugang seine fertige Client-Konfiguration.

## Wer ihn ruft

| Aufrufer | Weg | Route im Tunnel |
|---|---|---|
| ISP-Bereich, Zugang für eine Person | `POST /api/isp/vpn-accounts` | `0.0.0.0/0, ::/0` — alles |
| Laptop-Station bei der Anmeldung | `POST /api/stations/:id/tunnel` | `100.64.0.0/16` — nur das Hausnetz |

Grenzen auf der API-Seite (Haupt-API): VPN-Konten 10 pro Stunde und höchstens
10 Konten; Stations-Tunnel 10 pro Stunde und höchstens 20 je Konto.

Den Unterschied der Routen macht ein optionales `allowed_ips` im Rumpf von
`POST /peers`. Wer es weglässt, bekommt den vollen Tunnel — der ISP-Weg
übergibt es nicht.

**Tunnelnetz `192.168.2.0/24`.** Es existiert nur in CT 113 (`wg0`, Server
`192.168.2.1`, Peers ab `.10`) und ist kein UniFi-Netz: Jeder Peer wird über die
Tabelle seines Heim-VLANs geroutet und dort genatet (Absender
`100.64.<VLAN>.250`), die UDM sieht ihn wie ein Gerät dieses VLANs. Dasselbe
Subnetz hat in UniFi das Gast-WLAN (VLAN 8, `docs/unifi.md`); das ist kein
Widerspruch in der Doku, sondern eine echte Überschneidung, die nicht stört,
solange `192.168.2.x` CT 113 nie verlässt (am 28.11.2026 nachgesehen: nur
Masquerade auf `eth1`–`eth15`, keine Route nach aussen). Die WireGuard-Server
der UDM selbst nutzen `192.168.9.0/24` und `192.168.14.0/24`.

**Schlüssel.** Bringt der Aufrufer `public_key` mit, erzeugt wg-control keinen
privaten Schlüssel; `GET /peers/:id/config` und `/qr` antworten dann 409. Der
ISP-Weg reicht den Schlüssel seit 28.11.2026 weiter (`schluessel_ort = 'geraet'`);
ohne ihn bleibt der Server-Weg als gekennzeichneter Rückfall (`'server'`).
Beim Auszug oder bei der Kontolöschung entfernt die Haupt-API den Peer
(`DELETE /peers/:id`), die Zeile in `isp_vpn_accounts` bleibt als „gesperrt“.

**Das Tunnelnetz gehört immer dazu.** Wer `allowed_ips` setzt, bekommt
`192.168.2.0/24` automatisch angehängt. `AllowedIPs` ist bei WireGuard nicht
nur eine Route, sondern auch der Filter für erlaubte Absender: fehlt das
Tunnelnetz, verwirft der Client jede Antwort des Servers und erreicht dessen
Adresse `192.168.2.1` gar nicht. Der Tunnel steht dann, der Zähler bleibt bei
null empfangen — am 12. August 2026 genau so aufgetreten.

Warum ein Laptop nur das Hausnetz bekommt: er soll ausser Haus sein Internet
direkt behalten. Alles durch den Tunnel zu schicken wäre langsamer, fiele bei
jedem Unterbruch ganz aus, und niemand hat darum gebeten.

## Eingabeprüfung (seit 17.11.2026)

Der Name eines Peers landet als Kommentarzeile in `wg0.conf`; ein Zeilenumbruch
darin hätte eigene `[Peer]`-Blöcke einschleusen können. Darum:

| Feld in `POST /peers` | Regel | Fehler |
|---|---|---|
| `name` | Nur Buchstaben, Ziffern, Leerzeichen und `. _ @ + ( ) ' -`; alles andere wird zu Leerzeichen, höchstens 80 Zeichen. Auch beim Schreiben von `wg0.conf` für Altbestand angewendet. | `400 name required`, wenn nichts übrig bleibt |
| `email` | `^[^@\s]{1,64}@[^@\s]{1,190}$` | `400 email ungueltig` |
| `allowed_ips` | nur `0-9 A-F a-f : . / ,` und Leerzeichen, höchstens 200 Zeichen | `400 allowed_ips ungueltig` |
| `vlan` | muss in der VLAN-Tabelle des Dienstes stehen | `400 unknown vlan <n>` |

Der Token (`Authorization: Bearer <WG_CONTROL_TOKEN>`) wird zeitkonstant
verglichen. Ohne gesetzten Token startet der Dienst nicht
(`FATAL: WG_CONTROL_TOKEN not set`). Falscher Token → `401 unauthorized`.
Nur `/health` ist ohne Token erreichbar.

## Konfiguration

`/etc/wg-control/env` (Modus 0600, **nicht** im Repo; `setup.sh` legt sie beim
ersten Mal mit einem Zufallstoken an):

| Variable | Standard | Bedeutung |
|---|---|---|
| `WG_CONTROL_TOKEN` | – (Pflicht) | Bearer-Token; derselbe Wert steht als `WG_CONTROL_TOKEN` in `/opt/rosenweg-core/.env` (CT 128) |
| `WG_CONTROL_PORT` | `3001` | HTTP-Port |
| `WG_CONTROL_BIND` | `0.0.0.0` | Adresse, auf der gelauscht wird. **Empfohlen: `100.64.2.34`** (nur LAN) |
| `WG_LISTEN_PORT` | `51830` | WireGuard-Port |
| `WG_ENDPOINT_HOST` | `kooperation.rosenweg4303.ch` | Endpunkt in den Client-Konfigurationen |
| `WG_CLIENT_DNS` | `100.64.2.1` | DNS in den Client-Konfigurationen |
| `WG_CONTROL_STATE` | `/var/lib/wg-control/state.json` | Zustand (Peers, Schlüssel) |

Die API kennt die Adresse als `WG_CONTROL_URL` (`http://100.64.2.34:3001`, in
`backend-lxc/core/compose.yml`).

## Wie es hierher kam

Bis zum 12. August 2026 stand `server.js` **nur** auf dem Container — eine
einzelne Datei, unter keiner Versionsverwaltung, und sie entscheidet, wer ins
Netz kommt. Bei der ersten Änderung fiel das auf; seither liegt sie hier.

## Ausrollen

```bash
scp wg-control/server.js wg-control/wg-control.service root@100.64.2.20:/tmp/
ssh root@100.64.2.20 'pct push 113 /tmp/server.js /opt/wg-control/server.js
  pct push 113 /tmp/wg-control.service /etc/systemd/system/wg-control.service
  pct exec 113 -- bash -c "node --check /opt/wg-control/server.js && systemctl daemon-reload && systemctl restart wg-control"'
```

`WG_CONTROL_BIND` setzen (einmalig):

```bash
ssh root@100.64.2.20 'pct exec 113 -- bash -c "grep -q ^WG_CONTROL_BIND= /etc/wg-control/env || echo WG_CONTROL_BIND=100.64.2.34 >> /etc/wg-control/env; systemctl restart wg-control"'
```

**Vor jedem Neustart prüfen, was danach gleich sein muss.** Ein Neustart
trifft alle, die gerade über den VPN drin sind. Der Ablauf, der sich bewährt
hat (im Container; mit `WG_CONTROL_BIND=100.64.2.34` ist der Dienst **nicht**
mehr auf `127.0.0.1` erreichbar, darum die LAN-Adresse):

```bash
. /etc/wg-control/env
U=http://${WG_CONTROL_BIND:-127.0.0.1}:3001
# vorher: Konfiguration eines bestehenden Peers festhalten
curl -sS -K - "$U/peers/<id>/config" <<< "header = \"Authorization: Bearer $WG_CONTROL_TOKEN\"" | sha256sum
wg show all latest-handshakes | awk '$2>0' | wc -l
# nachher: beides muss gleich sein
```

(`-K -` liest den Header von stdin, damit der Token nicht in der Prozessliste
steht.) Am 12. August 2026 so gemessen: Prüfsumme identisch, beide aktiven
Verbindungen überstanden Neustart, Anlegen und Löschen eines Testpeers.

## Prüfen

```bash
ssh root@100.64.2.20 'pct exec 113 -- bash -c "systemctl is-active wg-control; ss -ltnp | grep :3001; curl -s http://100.64.2.34:3001/health"'
# {"ok":true,"peers":N,"listen_port":51830}
```

`ss` muss nach dem Setzen von `WG_CONTROL_BIND` `100.64.2.34:3001` zeigen, nicht
`0.0.0.0:3001`. Im ISP-Bereich einen Test-VPN-Zugang anlegen und wieder löschen.

## Zurückbauen

Die beim Rollout am 17.11.2026 ersetzte `server.js` liegt als
`/opt/wg-control/server.js.vor-sicherheit-2026-11-17` daneben; zurückkopieren,
`systemctl restart wg-control`. `WG_CONTROL_BIND` aus `/etc/wg-control/env`
entfernen, falls die API den Dienst nicht mehr erreicht.
