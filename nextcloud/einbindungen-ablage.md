# Nextcloud-Einbindungen der STWEG-Ordner

Die Nextcloud (CT 104) bindet die Ablage (`/mnt/cephfs-docs` = dasselbe CephFS
wie `/mnt/cephfs-stage` auf den Fileservern) als externe „Local“-Speicher ein.
Die Nextcloud liest dabei als `www-data` (Mitglied von `technik`), die
POSIX-ACLs der Fileserver greifen also **nicht**. Wer was sieht, entscheiden
allein die Gruppen der Einbindungen. Darum muss die Regel hier gleich sein wie
in `fileserver-lxc/ordnerrechte/tabelle.txt` und `api/lib/dok-stweg-sicht.js`.

## Regel (Entscheid Stefan 28.11.2026)

Eigentümer-Unterlagen sehen nur Eigentümer, Ausschuss und Verwaltung der STWEG
sowie Technik und Präsident. Mieter und andere reine Bewohner sehen nur
`stwegN/bewohner/` (Hausordnung, Schilder, Hinweise).

Je STWEG drei Einbindungen am **selben** Einbindungspunkt `/stwegN` (bzw. `/meg`):

| Einbindung | Ordner | Gruppen | Priorität |
|---|---|---|---|
| beschreibbar | `stwegN` | Ausschuss der STWEG, `technik`, `Präsident` | 150 |
| nur lesen | `stwegN` | Eigentümer der STWEG, `stwegN-verwaltung`, `verwaltung` (Übergang) | 100 |
| nur lesen | `stwegN/bewohner` | Bewohner der STWEG | 50 |

STWEG 3 = `r9-*`, STWEG 6 = `r1-*`, MEG = `meg-*`. Gehört jemand mehreren
Gruppen an, gilt die Einbindung mit der höchsten Priorität
(`UserGlobalStoragesService::getUniqueStorages`). Ein Mieter sieht unter
`/stweg5` also nur den Inhalt von `bewohner/`, ein Eigentümer (auch wer selbst
bewohnt) den ganzen Ordner, der Ausschuss den ganzen Ordner beschreibbar. Bis
28.11.2026 hatten alle Einbindungen Priorität 100; bei Gleichstand gewann die
zuletzt gelesene, das konnte dem Ausschuss die Nur-lesen-Einbindung geben.

`allgemein` und die Einbindungen ohne STWEG-Bezug fasst das Skript nicht an.

## Skript und Timer

`einbindungen-ablage.py` setzt das Soll, idempotent:

```bash
# auf CT 104 als root
/usr/local/sbin/einbindungen-ablage.py --trocken   # zeigt nur
/usr/local/sbin/einbindungen-ablage.py
```

Einrichten (einmalig, erledigt 28.11.2026):

```bash
cat nextcloud/einbindungen-ablage.py      | ssh … "sudo pct exec 104 -- sh -c 'cat > /usr/local/sbin/einbindungen-ablage.py; chmod 755 /usr/local/sbin/einbindungen-ablage.py'"
cat nextcloud/einbindungen-ablage.service | ssh … "sudo pct exec 104 -- sh -c 'cat > /etc/systemd/system/einbindungen-ablage.service'"
cat nextcloud/einbindungen-ablage.timer   | ssh … "sudo pct exec 104 -- sh -c 'cat > /etc/systemd/system/einbindungen-ablage.timer'"
# dann in CT 104: systemctl daemon-reload && systemctl enable --now einbindungen-ablage.timer
```

**Gruppen werden automatisch nachgezogen.** Die Nextcloud legt eine Gruppe aus
Authentik (`user_oidc`) erst an, wenn sich ein Mitglied zum ersten Mal
anmeldet. Bis dahin überspringt das Skript sie (am Ende des Laufs aufgelistet).
Der Timer läuft stündlich. Sobald es z. B. `stweg3-verwaltung` oder
`meg-bewohner` gibt, trägt der nächste Lauf sie in die Einbindung ein bzw. legt
die Bewohner-Einbindung der MEG an. Wer nicht warten will, startet
`systemctl start einbindungen-ablage.service`. Was gemacht wurde, steht in
`journalctl -u einbindungen-ablage`.

Sicherheit: Eine Einbindung ohne Gruppen und Konten gilt für **alle**. Das
Skript legt neue Einbindungen deshalb per `files_external:import` gleich mit
ihren Gruppen an, fügt bei bestehenden zuerst hinzu und entfernt danach und
bricht ab, bevor eine Einbindung ihre letzte Gruppe verlieren würde. Die
Priorität kann `occ` nicht setzen; das Skript schreibt sie direkt in
`oc_external_mounts.priority`.

## Sicherungen

- `/root/einbindungen-vor-bewohner-2026-11-28.json` (`files_external:export`)
- `/root/einbindungen-prioritaet-vor-bewohner-2026-11-28.txt` (Prioritäten)

Rückweg: Einbindungen 30–36 löschen (`files_external:delete`), bei 5, 7, 9, 11,
13, 15, 17 und 19 die Gruppen nach der Sicherung setzen, Prioritäten nach der
Textdatei zurückschreiben, Timer abschalten.
