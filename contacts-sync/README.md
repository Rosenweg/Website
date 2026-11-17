# Kontakte-Verzeichnis-Sync

Stand: 17.11.2026.

Täglicher Sync des Rosenweg-Verzeichnisses (alle `personen` + aktive
Verwaltungen + deren Mitarbeiter) aus der Rosenweg-Datenbank in **drei Ziele**:
Nextcloud-Adressbuch `kontakte/rosenweg`, die persönlichen SOGo-Adressbücher von
`inbox@` und `praesident@` (Mailcow) und den Z-Push-Ordner (CT 115).

## Wo es läuft

> **Offener Punkt:** Diese Beschreibung nannte bisher **CT 201** (`docker-pve1`,
> `100.64.2.24`) mit `docker exec rosenweg_postgres`. CT 201 und der Swarm
> existieren nicht mehr; die Datenbank läuft heute auf **CT 128**
> (`/opt/rosenweg-core`, Compose-Projekt `rosenweg-core`). Das Skript sucht den
> Datenbank-Container weiterhin mit `docker ps -q -f name=rosenweg_postgres` –
> auf CT 128 heisst er nach Compose-Schema anders. Wo und ob der Sync heute
> läuft, ist vor der nächsten Änderung auf den Knoten zu prüfen:
>
> ```bash
> for n in 100.64.2.20 100.64.2.21 100.64.2.22; do
>   ssh root@$n 'for c in $(pct list | awk "NR>1 && \$2==\"running\"{print \$1}"); do
>     pct exec $c -- test -f /usr/local/bin/contacts-sync.py 2>/dev/null && echo "$(hostname): CT $c"; done'
> done
> ```

## Dateien

| Datei | Ort | im Repo? |
|---|---|---|
| `contacts-sync.py` | `/usr/local/bin/contacts-sync.py` | ja |
| `contacts-sync.service` / `.timer` | `/etc/systemd/system/` | ja |
| `.contacts-sync.env` (0600) | `/root/.contacts-sync.env` | **nein** (Zugangsdaten) |

Variablen in `/root/.contacts-sync.env`:

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `NC_KONTAKTE_PW` | ja | App-Passwort des Nextcloud-Kontos `kontakte` |
| `INBOX_PW`, `PRAESIDENT_PW` | ja | Postfach-Passwörter für SOGo |
| `ARCHIV_PW` | – | wird vom Skript derzeit nicht gelesen |
| `TLS_VERIFY` | nein | `1` = Zertifikate prüfen (seit 17.11.2026). Dann `NC_BASE` und `SOGO_BASE` auf Hostnamen-URLs setzen, weil die Standard-URLs die Server per IP ansprechen |
| `NC_BASE` | nein | Standard `http://100.64.2.36/remote.php/dav/addressbooks/users/kontakte/rosenweg/` |
| `NC_HOST` | nein | Host-Header für Nextcloud, Standard `nextcloud.rosenweg9.ch` |
| `SOGO_BASE` | nein | Standard `https://100.64.2.33/SOGo/dav/` |
| `SOGO_HOST` | nein | Host-Header für SOGo, Standard `mailcow.rosenweg9.ch` |

Ohne `TLS_VERIFY=1` wird wie bisher **ohne** Zertifikatsprüfung verbunden – nur
im internen Netz vertretbar.

Timer: täglich **04:30 UTC** + `RandomizedDelaySec=600` + `Persistent=true`.

## Endpunkte (intern)

- **Nextcloud** (CT 104, `100.64.2.36`): HTTP direkt auf Port 80 mit
  `Host: nextcloud.rosenweg9.ch`.
- **SOGo** (Mailcow, CT 240, `100.64.2.33`): `https://100.64.2.33/SOGo/dav/<postfach>/Contacts/personal/`
  mit `Host: mailcow.rosenweg9.ch`. Über die öffentliche Adresse wären es ~1,8 s
  je Anfrage (Hairpin).
- **Z-Push** (CT 115, `100.64.2.38`): `rsync -a --delete` per SSH als root nach
  `/var/lib/zpush-contacts/`, danach `chown www-data`. Der SSH-Schlüssel des
  ausführenden Hosts muss in `/root/.ssh/authorized_keys` von CT 115 stehen.

## Logik

- UIDs **deterministisch**: `uuid5(name)` für Personen, `rosenweg-pbx`,
  `<firmakey>-verwaltung`, `<firmakey>-<nameslug>` → wiederholbar, keine Dubletten.
- **Veraltete löschen:** Nextcloud und Z-Push ja (eigene Sammlungen). SOGo
  persönliche Bücher **nur hinzufügen/aktualisieren** — sonst würden die privaten
  Kontakte von inbox@/präsident@ gelöscht.
- Seit 17.11.2026 werden Wagenrücklauf-Zeichen (`\r`) in Namen und Feldern
  maskiert; vorher hätte ein `\r` eine eigene vCard-Zeile begonnen.

## Ausführen und prüfen

```bash
python3 /usr/local/bin/contacts-sync.py
# Ausgabe: "desired: N", je Ziel "put=… del=…", "Z-Push CT115: rsynced N vcards"
systemctl list-timers contacts-sync.timer
journalctl -u contacts-sync.service -n 30 --no-pager
```

## Ausrollen und zurückbauen

```bash
scp contacts-sync/contacts-sync.py root@<host>:/usr/local/bin/contacts-sync.py
```

Zurück: die beim Rollout ersetzte Datei
`/usr/local/bin/contacts-sync.py.vor-sicherheit-2026-11-17` zurückkopieren.
