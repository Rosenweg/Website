# IP-Zuordnung je Haus und Einheit

Stand 11. August 2026, gemessen an UniFi und der Objektverwaltung.

Die Einheit ist der Anker. Ihre Nummer bestimmt die Adressen auf **jeder**
Ebene — Hausnetz, Usernetz hinter dem Router, WireGuard. Wer die Einheit
kennt, kennt ihre Adressen überall, ohne irgendwo nachzuschlagen.

## Die drei Ebenen

| Ebene | IPv4 | IPv6 |
|---|---|---|
| Hausnetz (Geräte, VRF-Interface, WG-Endpunkt) | `100.64.<VLAN>.<n·10>` – `.<n·10+9>` | `2a02:16a:1400:<HH><n>0::/64` |
| Usernetz hinter dem Router | `192.168.<VLAN>.<n·16>/28` | `2a02:16a:1400:<HH><n>1::/64` |
| WireGuard | aus dem Hausblock | `2a02:16a:1400:<HH><n>2::/64` |
| frei für Weiteres | — | 13 weitere `/64` im `/60` |

In IPv6 geht die Idee ohne Kompromiss auf: die Einheit bekommt ein `/60`,
und jede Ebene ein eigenes `/64` darin. In IPv4 ist der Platz zu klein für
eigene Netze je Ebene — dort verbindet die **Nummer** die Ebenen, nicht die
Adresse: derselbe Faktor `n` in jeder Formel.

## Häuser

| Haus | VLAN | Hausnetz | Usernetz-Pool | IPv6-Präfix | Einheiten | DHCP heute |
|---|---|---|---|---|---|---|
| RK | 9 | `100.64.9.0/24` | `192.168.9.0/24` | `2a02:16a:1400:1f00::/56` | 0 | `.6–.254` |
| RW1 | 19 | `100.64.19.0/24` | `192.168.19.0/24` | `2a02:16a:1400:0100::/56` | 9 | `.6–.254` |
| RW2 | 29 | `100.64.29.0/24` | `192.168.29.0/24` | `2a02:16a:1400:0200::/56` | 8 | `.200–.254` |
| RW4 | 49 | `100.64.49.0/24` | `192.168.49.0/24` | `2a02:16a:1400:0400::/56` | 7 | `.6–.254` |
| RW5 | 59 | `100.64.59.0/24` | `192.168.59.0/24` | `2a02:16a:1400:0500::/56` | 9 | `.6–.254` |
| RW6 | 69 | `100.64.69.0/24` | `192.168.69.0/24` | `2a02:16a:1400:0600::/56` | 7 | `.6–.254` |
| RW8 | 89 | `100.64.89.0/24` | `192.168.89.0/24` | `2a02:16a:1400:0800::/56` | 7 | `.6–.254` |
| RW9 | 99 | `100.64.99.0/24` | `192.168.99.0/24` | `2a02:16a:1400:0900::/56` | 9 | `.200–.254` |
| RW10 | 109 | `100.64.109.0/24` | `192.168.109.0/24` | `2a02:16a:1400:1000::/56` | 6 | `.6–.254` |
| RW12 | 129 | `100.64.129.0/24` | `192.168.129.0/24` | `2a02:16a:1400:1200::/56` | 6 | `.100–.254` |
| RW13 | 139 | `100.64.139.0/24` | `192.168.139.0/24` | `2a02:16a:1400:1300::/56` | 9 | `.200–.254` |
| RW14 | 149 | `100.64.149.0/24` | `192.168.149.0/24` | `2a02:16a:1400:1400::/56` | 1 | `.100–.254` |
| RW16 | 169 | `100.64.169.0/24` | `192.168.169.0/24` | `2a02:16a:1400:1600::/56` | 1 | `.100–.254` |
| RW17 | 179 | `100.64.179.0/24` | `192.168.179.0/24` | `2a02:16a:1400:1700::/56` | 10 | `.100–.254` |
| RW18 | 189 | `100.64.189.0/24` | `192.168.189.0/24` | `2a02:16a:1400:1800::/56` | 7 | `.100–.254` |

## Aufteilung im Hausnetz `100.64.<VLAN>.0/24`

| Bereich | Zweck |
|---|---|
| `.1` | Gateway (UniFi) |
| `.2`–`.8` | Infrastruktur |
| `.9` | Usernetze-Router (LXC) |
| `.10`–`.19` | Einheit 1 |
| `.20`–`.29` | Einheit 2 |
| `.30`–`.39` | Einheit 3 |
| `.40`–`.49` | Einheit 4 |
| `.50`–`.59` | Einheit 5 |
| `.60`–`.69` | Einheit 6 |
| `.70`–`.79` | Einheit 7 |
| `.80`–`.89` | Einheit 8 |
| `.90`–`.99` | Einheit 9 |
| `.100`–`.109` | Einheit 10 |
| `.110`–`.119` | Einheit 11 |
| `.120`–`.129` | Einheit 12 |
| `.130`–`.139` | Einheit 13 |
| `.140`–`.149` | Einheit 14 |
| `.150`–`.254` | DHCP: Gäste, Handwerker, alles Flüchtige |

## Voraussetzung: DHCP vereinheitlichen

Heute beginnt der DHCP-Bereich in drei verschiedenen Mustern. In sieben
Häusern bei `.6` — dort ist für feste Blöcke kein Platz.

| Haus | heute | künftig | Änderung |
|---|---|---|---|
| RK | `.6–.254` | `.150–.254` | **Anfang verschieben, Leases erneuern** |
| RW1 | `.6–.254` | `.150–.254` | **Anfang verschieben, Leases erneuern** |
| RW2 | `.200–.254` | `.150–.254` | Bereich verkleinern |
| RW4 | `.6–.254` | `.150–.254` | **Anfang verschieben, Leases erneuern** |
| RW5 | `.6–.254` | `.150–.254` | **Anfang verschieben, Leases erneuern** |
| RW6 | `.6–.254` | `.150–.254` | **Anfang verschieben, Leases erneuern** |
| RW8 | `.6–.254` | `.150–.254` | **Anfang verschieben, Leases erneuern** |
| RW9 | `.200–.254` | `.150–.254` | Bereich verkleinern |
| RW10 | `.6–.254` | `.150–.254` | **Anfang verschieben, Leases erneuern** |
| RW12 | `.100–.254` | `.150–.254` | Anfang verschieben |
| RW13 | `.200–.254` | `.150–.254` | Bereich verkleinern |
| RW14 | `.100–.254` | `.150–.254` | Anfang verschieben |
| RW16 | `.100–.254` | `.150–.254` | Anfang verschieben |
| RW17 | `.100–.254` | `.150–.254` | Anfang verschieben |
| RW18 | `.100–.254` | `.150–.254` | Anfang verschieben |

Die sieben Häuser mit `.6` sind die eigentliche Arbeit: dort haben Geräte
heute Adressen im künftigen Blockbereich und bekommen beim nächsten
Lease-Wechsel eine neue. Für Geräte mit fester Adresse ist das ein Umzug,
für alle anderen unbemerkt.

## Ausgerechnet: Haus 13, Einheit 3

| Ebene | Adresse |
|---|---|
| Hausnetz | `100.64.139.30` – `.39` |
| Usernetz | `192.168.139.48/28` |
| IPv6 Einheit | `2a02:16a:1400:1330::/60` |
| — davon Hausnetz | `2a02:16a:1400:1330::/64` |
| — davon Usernetz | `2a02:16a:1400:1331::/64` |
| — davon WireGuard | `2a02:16a:1400:1332::/64` |

## Grenzen, die man kennen muss

**Zehn IPv4-Adressen je Einheit sind knapp**, wenn jede Person eigene
WireGuard-Endpunkte bekommt: VRF-Interface, feste Geräte und Peers teilen
sich den Block. In IPv6 stellt sich die Frage nicht — dort hat jede Ebene
ihr eigenes `/64`.

**Einheit 10 bis 14 heissen in IPv6 `a` bis `e`.** Eine Hexstelle hat
16 Werte: eine für die Infrastruktur, eine für temporär, bleiben 14.

**Nicht jedes VLAN ist ein Haus.** RK-Dienste (2), RK-Technik (3), Guest (8),
RW2-Technik (20), RW9-Technik/Dienste/Kameras (90/91/92) liegen daneben und
bleiben ausserhalb dieser Systematik.
# Hergeleitete Einheiten

Regel: laufende Nummer von unten nach oben, innerhalb des Geschosses
links nach rechts. Der Geschossaufbau folgt aus den bekannten Stockwerken.

## Haus 6 — VLAN 69

*Beleg: 6.EG.1/2 sind 01/02; RW6-06 steht im 2. OG*

| Nr | bisher | neu | IPv4-Block | IPv6 |
|---|---|---|---|---|
| 1 | 6.EG.1 | **6.EG.1** | `100.64.69.10`–`.19` | `2a02:16a:1400:0610::/60` |
| 2 | 6.EG.2 | **6.EG.2** | `100.64.69.20`–`.29` | `2a02:16a:1400:0620::/60` |
| 3 | RW6-03 | **6.1OG.1** | `100.64.69.30`–`.39` | `2a02:16a:1400:0630::/60` |
| 4 | RW6-04 | **6.1OG.2** | `100.64.69.40`–`.49` | `2a02:16a:1400:0640::/60` |
| 5 | — (nicht vorhanden) | **6.2OG.1** | `100.64.69.50`–`.59` | `2a02:16a:1400:0650::/60` |
| 6 | RW6-06 | **6.2OG.2** | `100.64.69.60`–`.69` | `2a02:16a:1400:0660::/60` |

## Haus 8 — VLAN 89

*Beleg: 8.EG.2 ist 02; RW8-03 und -05 im 1. OG, RW8-06 im 2. OG*

| Nr | bisher | neu | IPv4-Block | IPv6 |
|---|---|---|---|---|
| 1 | RW8-01 | **8.EG.1** | `100.64.89.10`–`.19` | `2a02:16a:1400:0810::/60` |
| 2 | 8.EG.2 | **8.EG.2** | `100.64.89.20`–`.29` | `2a02:16a:1400:0820::/60` |
| 3 | RW8-03 | **8.1OG.1** | `100.64.89.30`–`.39` | `2a02:16a:1400:0830::/60` |
| 4 | RW8-04 | **8.1OG.2** | `100.64.89.40`–`.49` | `2a02:16a:1400:0840::/60` |
| 5 | RW8-05 | **8.1OG.3** | `100.64.89.50`–`.59` | `2a02:16a:1400:0850::/60` |
| 6 | RW8-06 | **8.2OG.1** | `100.64.89.60`–`.69` | `2a02:16a:1400:0860::/60` |
| 7 | RW8-07 | **8.2OG.2** | `100.64.89.70`–`.79` | `2a02:16a:1400:0870::/60` |

## Haus 13 — VLAN 139

*Beleg: 1305 steht im 1. OG — und 13.1OG.2 ist genau die fehlende Einheit*

| Nr | bisher | neu | IPv4-Block | IPv6 |
|---|---|---|---|---|
| 1 | 13.EG.1 | **13.EG.1** | `100.64.139.10`–`.19` | `2a02:16a:1400:1310::/60` |
| 2 | 13.EG.2 | **13.EG.2** | `100.64.139.20`–`.29` | `2a02:16a:1400:1320::/60` |
| 3 | 13.EG.3 | **13.EG.3** | `100.64.139.30`–`.39` | `2a02:16a:1400:1330::/60` |
| 4 | 13.1OG.1 | **13.1OG.1** | `100.64.139.40`–`.49` | `2a02:16a:1400:1340::/60` |
| 5 | 1305 | **13.1OG.2** | `100.64.139.50`–`.59` | `2a02:16a:1400:1350::/60` |
| 6 | 13.1OG.3 | **13.1OG.3** | `100.64.139.60`–`.69` | `2a02:16a:1400:1360::/60` |
| 7 | 13.2OG.1 | **13.2OG.1** | `100.64.139.70`–`.79` | `2a02:16a:1400:1370::/60` |
| 8 | 13.2OG.2 | **13.2OG.2** | `100.64.139.80`–`.89` | `2a02:16a:1400:1380::/60` |
| 9 | 13.2OG.3 | **13.2OG.3** | `100.64.139.90`–`.99` | `2a02:16a:1400:1390::/60` |

## Haus 14 — VLAN 149

*Beleg: 02/03 im EG, 04/05 im 1. OG, 06/07 im 2. OG — alle sechs belegt*

| Nr | bisher | neu | IPv4-Block | IPv6 |
|---|---|---|---|---|
| 1 | 14.EG.1 | **14.EG.1** | `100.64.149.10`–`.19` | `2a02:16a:1400:1410::/60` |
| 2 | 1402 | **14.EG.2** | `100.64.149.20`–`.29` | `2a02:16a:1400:1420::/60` |
| 3 | 1403 | **14.EG.3** | `100.64.149.30`–`.39` | `2a02:16a:1400:1430::/60` |
| 4 | 1404 | **14.1OG.1** | `100.64.149.40`–`.49` | `2a02:16a:1400:1440::/60` |
| 5 | 1405 | **14.1OG.2** | `100.64.149.50`–`.59` | `2a02:16a:1400:1450::/60` |
| 6 | 1406 | **14.2OG.1** | `100.64.149.60`–`.69` | `2a02:16a:1400:1460::/60` |
| 7 | 1407 | **14.2OG.2** | `100.64.149.70`–`.79` | `2a02:16a:1400:1470::/60` |

## Haus 16 — VLAN 169

*Beleg: 01/02 im EG, 03 im 1. OG, 16.1OG.2 ist 04, 05/06 im 2. OG*

| Nr | bisher | neu | IPv4-Block | IPv6 |
|---|---|---|---|---|
| 1 | 1601 | **16.EG.1** | `100.64.169.10`–`.19` | `2a02:16a:1400:1610::/60` |
| 2 | 1602 | **16.EG.2** | `100.64.169.20`–`.29` | `2a02:16a:1400:1620::/60` |
| 3 | 1603 | **16.1OG.1** | `100.64.169.30`–`.39` | `2a02:16a:1400:1630::/60` |
| 4 | 16.1OG.2 | **16.1OG.2** | `100.64.169.40`–`.49` | `2a02:16a:1400:1640::/60` |
| 5 | 1605 | **16.2OG.1** | `100.64.169.50`–`.59` | `2a02:16a:1400:1650::/60` |
| 6 | 1606 | **16.2OG.2** | `100.64.169.60`–`.69` | `2a02:16a:1400:1660::/60` |


# Offene Punkte

Der Entwurf steht, die Umsetzung wartet auf drei Entscheidungen und die Pläne.

## Vor dem Einbau zu klären

1. **Haus 4** — 2+2+2 (drei Geschosse) oder 3+3 (zwei Geschosse)? Beide passen
   zu den bekannten Stockwerken. Die Wertquoten (85/69 | 85/72 | 72/103) sprechen
   für 2+2+2: zweimal dieselbe Paarung übereinander, oben eine abweichende.
   Stefan hat bestätigt, dass die Stockwerke von RW4-02 und RW4-04 in der
   Objektverwaltung vertauscht sind — das ist zu korrigieren.
2. **Links oder rechts ist die `.1`?** Entscheidet bei jedem Geschoss mit zwei
   Einheiten, welche die `.1` bekommt. Betrifft die Häuser 2, 4, 6, 8, 14, 16.
3. **Zwei Zählrichtungen im Bestand.** Die Häuser 8, 13, 14, 16 zählen von unten,
   die Häuser 2 und 17 von oben (Beleg: `RW17-07 rechts 0.3` = Erdgeschoss,
   `RW2-07` = "Parterre links"). Das ist keine Unsauberkeit in den Daten,
   sondern zwei verschiedene Konventionen — die Richtung gehört je Haus
   festgehalten.

## Ohne Pläne nicht herleitbar

Häuser **1, 5, 6, 10, 12** — 37 Einheiten. Weder Name noch Stockwerk noch
Wertquote geben genug her. Bei Haus 6 fällt `RW6-04` mit Wertquote 12 (sonst 55)
aus dem Rahmen; bei 10 und 12 lassen sich `10.2OG.2` und `12.2OG.1` nicht in die
laufende Nummerierung einfügen, ohne eine bestehende Nummer doppelt zu belegen.

Ebenso offen: die vier Hobbyräume ohne Hauszuordnung (Objekt-IDs 58, 215, 216,
217).

## Datenlücken, die dabei aufgefallen sind

* `flaeche_m2` und `zimmer` sind bei **allen** Einheiten leer. Einziges
  Grössenmerkmal ist die Wertquote.
* `stockwerk` fehlt bei 53 von 112 Einheiten und steht sonst in fünf
  Schreibweisen ("Erdgeschoss" neben "Parterre links", "2. Obergeschoss" neben
  "2. OG rechts").
* Fünf Benennungsmuster nebeneinander: `9.EG.1`, `RW1-01`, `10.1`, `1305`,
  `Hobbyraum`.

## Reihenfolge der Umsetzung

1. DHCP-Bereiche in UniFi auf `.150–.254` (Liste oben) — geht unabhängig von
   allem anderen und ist Voraussetzung für die Blöcke.
2. Einheiten umbenennen und `haus` + `einheit_nr` als feste Felder einführen.
3. IP-Zuordnung darauf aufsetzen: berechnete Vorgabe, gespeicherte Ausnahme.
