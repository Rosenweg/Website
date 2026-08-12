# wg-control

Der Dienst, der die WireGuard-Zugänge des Hauses ausgibt. Er läuft auf
**CT 113 (`vpn-wg`)** unter `/opt/wg-control` und hört auf `100.64.2.34:3001`.

Er verwaltet die Peers, schreibt `wg0.conf`, hält die Schnittstelle im
Gleichstand und liefert jedem Zugang seine fertige Client-Konfiguration.

## Wer ihn ruft

| Aufrufer | Weg | Route im Tunnel |
|---|---|---|
| ISP-Bereich, Zugang für eine Person | `POST /api/isp/vpn-accounts` | `0.0.0.0/0, ::/0` — alles |
| Laptop-Station bei der Anmeldung | `POST /api/stations/:id/tunnel` | `100.64.0.0/16` — nur das Hausnetz |

Den Unterschied macht ein optionales `allowed_ips` im Rumpf von
`POST /peers`. Wer es weglässt, bekommt wie eh und je den vollen Tunnel — der
ISP-Weg übergibt es nicht und bleibt damit unverändert.

Warum ein Laptop nur das Hausnetz bekommt: er soll ausser Haus sein Internet
direkt behalten. Alles durch den Tunnel zu schicken wäre langsamer, fiele bei
jedem Unterbruch ganz aus, und niemand hat darum gebeten.

## Wie es hierher kam

Bis zum 12. August 2026 stand `server.js` **nur** auf dem Container — eine
einzelne Datei, unter keiner Versionsverwaltung, und sie entscheidet, wer ins
Netz kommt. Bei der ersten Änderung fiel das auf; seither liegt sie hier.

## Ausrollen

```bash
scp server.js wg-control.service root@100.64.2.20:/tmp/
ssh root@100.64.2.20 'for f in server.js wg-control.service; do
    pct push 113 /tmp/$f /opt/wg-control/$f; done
  pct exec 113 -- bash -c "node --check /opt/wg-control/server.js && systemctl restart wg-control"'
```

**Vor jedem Neustart prüfen, was danach gleich sein muss.** Ein Neustart
trifft alle, die gerade über den VPN drin sind. Der Ablauf, der sich bewährt
hat:

```bash
# vorher: Konfiguration eines bestehenden Peers festhalten
curl -sS -H "Authorization: Bearer $WG_CONTROL_TOKEN" \
     http://127.0.0.1:3001/peers/<id>/config | sha256sum
wg show all latest-handshakes | awk '$2>0' | wc -l

# nachher: beides muss gleich sein
```

Am 12. August 2026 so gemessen: Prüfsumme identisch, beide aktiven
Verbindungen überstanden Neustart, Anlegen und Löschen eines Testpeers.

## Konfiguration

`/etc/wg-control/env` (Modus 0600, **nicht** im Repo) enthält
`WG_CONTROL_TOKEN` und die Endpunktangaben. Die API kennt denselben Token als
`WG_CONTROL_TOKEN` und die Adresse als `WG_CONTROL_URL`.
