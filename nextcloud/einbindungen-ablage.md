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

Je STWEG drei Einbindungen:

| Einbindungspunkt | Ordner | Gruppen | Rechte |
|---|---|---|---|
| `/stwegN` | `stwegN` | Ausschuss der STWEG, `technik`, `Präsident` | beschreibbar |
| `/stwegN` | `stwegN` | Eigentümer der STWEG, `stwegN-verwaltung`, `verwaltung` (Übergang) | nur lesen |
| `/stwegN-bewohner` | `stwegN/bewohner` | Bewohner der STWEG | nur lesen |

STWEG 3 = `r9-*`, STWEG 6 = `r1-*`, MEG = `meg-*`. Ein Mieter sieht nur
`/stwegN-bewohner`. Ein Eigentümer, der selbst bewohnt, sieht beides; in
`/stwegN` liegt `bewohner/` ohnehin auch.

**Warum ein eigener Einbindungspunkt:** Nextcloud 33 beachtet die Priorität
beim Einbinden nicht. `ConfigAdapter::getMountsForUser` nimmt
`getAllStoragesForUser`, nicht `getUniqueStorages`. Bei gleichem Punkt gewinnt
eine beliebige Einbindung: Im Test am 28.11.2026 sah ein Eigentümer, der auch
Bewohner ist, unter `/stweg5` nur noch `bewohner/`. Dasselbe gilt für die
beiden Einbindungen auf `/stwegN` (beschreibbar und nur lesen). Wer im
Ausschuss und zugleich Eigentümer ist, bekommt vielleicht nur die
Nur-lesen-Einbindung. Das war schon vorher so und ist offen.

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
bricht ab, bevor eine Einbindung ihre letzte Gruppe verlieren würde. 

## Sicherungen

- `/root/einbindungen-vor-bewohner-2026-11-28.json` (`files_external:export`)
- `/root/einbindungen-prioritaet-vor-bewohner-2026-11-28.txt` (Prioritäten)

Rückweg: die Einbindungen `/stwegN-bewohner` (38–44) löschen
(`files_external:delete`), bei 5, 7, 9, 11, 13, 15, 17 und 19 die Gruppen nach
der Sicherung setzen, Timer abschalten.

## Prüfung 28.11.2026

Mit den temporären Konten `nctest-mieter` (`stweg5-bewohner`) und `nctest-eig`
(`stweg5-eigentuemer` + `stweg5-bewohner`) per WebDAV mit App-Passwort geprüft.
Danach wurden beide Konten samt Tokens gelöscht.

| | Mieter | Eigentümer |
|---|---|---|
| `/stweg5-bewohner` Hausordnung | 200 | 200 |
| `/stweg5` Vertrag, `99-kontaktdaten` | 404 | 200 / 207 |
| `/stweg3` | 404 | 404 |
| Schreiben | 403/404 | 403 |
