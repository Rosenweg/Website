# Fileserver — CT 106 und CT 206

Zwei Samba-Server als Domänenmitglieder, davor eine virtuelle Adresse, die
keepalived schwenkt. Die Stationen hängen ihre Freigaben nicht bei einem
bestimmten Server ein, sondern beim Clusternamen:

```
files.ad.rosenweg4303.ch   A     100.64.2.29
                           AAAA  2a02:16a:1400:9::29
```

| | |
|---|---|
| CT 106 `fileserver` (pve2) | MASTER, Priorität 150 |
| CT 206 `fileserver2` (pve1) | BACKUP, Priorität 100 |
| Überwacht | `smbd` — fällt er aus, sinkt die Priorität um 60 und der andere übernimmt |

Die ausführliche Herleitung des Clusternamens, die Kerberos-Fallstricke und
der Weg auf der Stationsseite stehen im anderen Repo:
`os-stationen/docs/fileserver-clustername.md`.

## Was hier liegt

| Datei | Ziel |
|---|---|
| `10-auf-adressen-warten.conf` | CT 106 **und** CT 206: `/etc/systemd/system/keepalived.service.d/` |

Danach auf beiden Containern:

```bash
systemctl daemon-reload
systemctl restart keepalived     # nur auf dem BACKUP gefahrlos —
                                 # auf dem MASTER schwenkt dabei die Adresse
```

## Warum die Datei nötig ist

Die IPv6-Instanz von keepalived ging am 12. August 2026 um 17:24:03 in
**FAULT STATE** und kam nie zurück. Drei Tage lang trug damit **niemand** die
`2a02:16a:1400:9::29`, obwohl sie konfiguriert war und im DNS stand.

Der Grund steht in einer späteren keepalived-Fassung im Klartext:

```
(fileserver_vip6): entering FAULT state (src address not configured)
```

`unicast_src_ip` ist die SLAAC-Adresse von `eth0`. Beim Systemstart ist
keepalived schneller als die Router-Ankündigung, findet seine Quelladresse
nicht — und prüft danach **nie wieder** nach. Die IPv4-Instanz wurde daneben
ordentlich MASTER, es sah also alles gesund aus.

**Bemerkt wurde es an einer ganz anderen Stelle.** `getaddrinfo` bevorzugt
IPv6, also lief jede Station beim Einhängen des Homes zuerst sieben Sekunden
in eine tote Adresse:

```
CIFS: Attempting to mount //files.ad.rosenweg4303.ch/home/…
CIFS: VFS: Error connecting to socket. Aborting operation.
CIFS: VFS: cifs_mount failed w/return code = -113      (EHOSTUNREACH)
```

Mit Wiederholung rund **dreissig Sekunden pro Anmeldung, auf jeder Station im
Haus**. Gesucht wurde tagelang am Desktop der Stationen.

## Zwei Feinheiten, beide teuer erkauft

- **Auf benutzbar warten, nicht auf vorhanden.** Der erste Versuch dieses
  Riegels prüfte nur, ob eine Adresse da ist. Das reicht nicht — eine frische
  IPv6-Adresse ist erst `tentative`, solange der Kernel per DAD prüft, ob sie
  schon jemand hat, und in dieser Zeit lässt sie sich nicht als Quelladresse
  binden. Der Neustart zum Prüfen brachte denselben FAULT wie vorher.
- **Der Bindestrich vor `timeout` ist Absicht.** Läuft die Frist ab, startet
  keepalived trotzdem. Ohne IPv6-Instanz ist schlecht; ein Fileserver ohne
  IPv4-VIP wäre schlimmer.

Nachgeprüft mit einem echten Neustart von CT 206 am 15. August 2026:
`Entering BACKUP STATE` statt FAULT.

## Nachsehen, ob es trägt

Eine virtuelle Adresse gilt erst als vorhanden, wenn sie jemand **trägt** —
die Konfiguration zu lesen genügt nicht:

```bash
pct exec 106 -- ip -6 addr show eth0 | grep '::29'
pct exec 106 -- journalctl -u keepalived | grep -iE 'vip6|FAULT'
ping6 -c2 2a02:16a:1400:9::29
```
