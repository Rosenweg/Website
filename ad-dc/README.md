# sysvol-Abgleich zwischen dc1 und dc2

Samba gleicht das **sysvol** zwischen Domaenencontrollern nicht von selbst ab.
Das Verzeichnisobjekt repliziert ueber DRS, die Dateien darunter nicht. Am
12. August 2026 so vorgefunden: dc1 vier Gruppenrichtlinien, dc2 keine.

## Warum zweiwegig (Stand 17.09.2026)

Bis zum 17.09.2026 lief hier ein einseitiges `rsync` von dc1 nach dc2. Im
Normalbetrieb ist das korrekt und entspricht der
[Samba-Empfehlung](https://wiki.samba.org/index.php/Rsync_based_SysVol_replication_workaround):
Windows schreibt Gruppenrichtlinien immer auf den **PDC-Emulator**, und den
haelt dc1 (zusammen mit allen anderen FSMO-Rollen).

Im Ernstfall war es falsch:

> Faellt dc1 aus und die FSMO-Rollen wandern auf dc2, ist dc2 die neue Quelle.
> Das Skript lag aber auf dc1 und schob hartkodiert in die andere Richtung.
> Kam dc1 zurueck, ueberschrieb sein **veralteter** Stand per `--delete` den
> aktuellen von dc2. Genau im Notfall, fuer den die Redundanz da ist,
> arbeitete die Einrichtung gegen uns.

Darum jetzt der
[Zweiwege-Ansatz mit unison](https://wiki.samba.org/index.php/Bidirectional_Rsync/Unison_based_SysVol_replication_workaround).
unison entscheidet pro Datei, welche Seite die juengere ist, und braucht keine
fest verdrahtete Richtung. Der Lauf startet von **beiden** Controllern —
liegt einer, holt der andere nach, sobald er zurueck ist.

## Dateien

| Datei | Ort auf dc1/dc2 |
|---|---|
| `sysvol-abgleich` | `/usr/local/bin/sysvol-abgleich` |
| `sysvol.prf` | `/root/.unison/sysvol.prf` |
| `sysvol-abgleich.service` | `/etc/systemd/system/` |
| `sysvol-abgleich.timer.dc1` | auf dc1 als `sysvol-abgleich.timer` |
| `sysvol-abgleich.timer.dc2` | auf dc2 als `sysvol-abgleich.timer` |
| `warte-ipv6.sh` | `/usr/local/sbin/warte-ipv6.sh` |
| `samba-ad-dc.service.d/*.conf` | `/etc/systemd/system/samba-ad-dc.service.d/` |

Die Timer sind **versetzt** (dc1 `*:0/10`, dc2 `*:5/10`). Liefen sie
gleichzeitig, blockierten sich zwei Laeufe auf demselben Verzeichnis.

## Zwei Fallen beim Umbau

**unison-Versionen muessen uebereinstimmen.** Beide Controller laufen auf
Debian 13.7 mit unison 2.53.7. Eine abweichende Version auf einer Seite, und
unison verweigert die Zusammenarbeit.

**Der `copyprog`-Trick aus dem Wiki funktioniert nicht mehr.** Das Wiki-Rezept
laesst rsync `-XA` die Dateien kopieren, damit die POSIX-ACLs in den
erweiterten Attributen mitkommen. Ab unison 2.53 ist dieser Weg abgekuendigt
(`copyquoterem` existiert gar nicht mehr, `copythreshold`/`copyprog`/
`copyprogrest` warnen). Wir brauchen ihn auch nicht:
`samba-tool ntacl sysvolreset` setzt die Rechte nach jedem Lauf ohnehin aus
dem AD neu, und das AD repliziert von selbst. Geprueft: `security.NTACL` und
`system.posix_acl_access` stehen nach dem Abgleich auf dc2.

## Nachgewiesen am 17.09.2026

- Aenderung auf **dc2** (ohne PDC-Rolle) → kam auf dc1 an
- Loeschung auf **dc1** → kam auf dc2 an
- Leerlauf: `Nothing to do: replicas have not changed since last sync.`

Vorher war der erste Fall unmoeglich.

## Schutzplanken im Profil

- `confirmbigdel = true` — grosse Loeschungen werden **nicht** stillschweigend
  uebertragen. Ist ein Controller halb aufgesetzt oder sein sysvol beschaedigt,
  bricht unison lieber ab, statt die Richtlinien der Gegenseite mitzureissen.
  Das ist die Schutzplanke gegen genau den Fall, den ein Zweiwege-Abgleich
  sonst erst ermoeglicht.
- `backup = Name *` nach `/var/lib/samba/sysvol-abgleich-sicherung` — ein
  falsch aufgeloester Konflikt soll keine Richtlinie spurlos verschlucken.
- Das Skript bricht **nicht** ab, wenn die Gegenseite nicht erreichbar ist.
  Waehrend eines Neustarts ist das der Normalfall und kein Fehler.

## Neustart und Umzug sind kein Fehler (18.09.2026)

Ein Controller, der neu startet oder per HA den Knoten wechselt, ist ein
normaler Betriebszustand. Am 18.09.2026 zog dc1 achtmal um, und jedes Mal
entstanden Fehlermeldungen — drei Ursachen, alle behoben:

**1. unison ohne HOME.** systemd setzt kein `HOME`, unison findet sein Profil
dann nicht. Jeder Timer-Lauf scheiterte (86 Mal). `Environment=HOME=/root`
in der Unit. Meine Tests liefen per `pct exec`, wo HOME gesetzt ist — darum
jetzt immer ueber `systemctl start` pruefen, genau wie der Timer startet.

**2. samba meldet jeden Stopp als Fehler.** samba beendet sich auf SIGTERM
mit Status 127; die Debian-Unit kennt das nicht als Erfolg. Jeder Umzug
erzeugte `Failed with result 'exit-code'`.
`samba-ad-dc.service.d/sauberer-stopp.conf`: `SuccessExitStatus=127`.

**3. Warten auf IPv6 wartete zu kurz.** Die erste Fassung von
`warte-ipv6.sh` pruefte nur, ob eine globale Adresse *sichtbar* ist. Beim
Boot um 10:42 war sie das — aber noch *tentative* (Duplikatpruefung), und an
eine tentative Adresse laesst sich nicht binden. Jetzt
`ip -6 addr show scope global -tentative -dadfailed`.

Nachgewiesen: dc2 ist neu gestartet und von pve3 auf pve1 umgezogen, mit
`Deactivated successfully` beim Stopp, null Fehlerzeilen beim Start und
`NRestarts=0`.

### Abgleich: einzelne Aussetzer ja, anhaltender Ausfall nein

Der Abgleich unterscheidet jetzt zwischen beidem. Ist die Gegenseite weg —
vor oder waehrend des Laufs —, zaehlt das als Lauf ohne Erfolg und wird nur
protokolliert. Erst ab dem **dritten Lauf in Folge** (rund 30 Minuten) endet
der Dienst mit Fehler, und die Dienstwacht meldet ihn. Ein Umzug dauert unter
einer Minute und verpasst hoechstens einen Lauf.

Das korrigiert auch den umgekehrten Fehler der ersten Fassung: eine dauerhaft
unerreichbare Gegenseite wurde dort kommentarlos uebersprungen. Laege dc2
wieder drei Tage still wie im September, haette der Abgleich das nie
gemeldet.

Verwaiste unison-Sperren (`~/.unison/lk*`) von hart abgebrochenen Laeufen
raeumt das Skript beim Start weg, wenn sie aelter als 30 Minuten sind.

### Falle: `pct shutdown` auf HA-verwalteten Containern

`pct shutdown 136` schaltet dc2 nicht einfach ab, sondern setzt den
**HA-Sollzustand auf `stopped`** — HA laesst ihn dann dauerhaft aus. Beim
Testen am 18.09.2026 passiert und sofort mit
`ha-manager set ct:136 --state started` zurueckgenommen. Fuer einen
Neustart `pct reboot` verwenden oder direkt ueber `ha-manager`.

## Der alte Weg

Auf dc1 liegt das frueher genutzte Skript als
`/usr/local/bin/sysvol-abgleich.rsync-einseitig`.
