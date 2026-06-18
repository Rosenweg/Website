# Kontakte-Verzeichnis-Sync

Täglicher Sync des Rosenweg-Verzeichnisses (alle `personen` + aktive Verwaltung + deren
Mitarbeiter) aus Postgres in **drei Ziele**: Nextcloud-Buch, SOGo persönliche Bücher
(inbox@ + präsident@) und den Z-Push-Ordner (CT 115).

## Läuft auf
**CT 201** (docker-pve1, `100.64.2.24`) — der Postgres-Node, Datenzugriff via
`docker exec rosenweg_postgres psql`.

## Dateien
| Datei | Ort | im Repo? |
|---|---|---|
| `contacts-sync.py` | `/usr/local/bin/contacts-sync.py` | ✅ |
| `contacts-sync.service` / `.timer` | `/etc/systemd/system/` | ✅ |
| `.contacts-sync.env` (0600) | `/root/.contacts-sync.env` | ❌ (Secrets) |

Env-Datei (Creds, **nicht** im Repo): `NC_KONTAKTE_PW`, `INBOX_PW`, `PRAESIDENT_PW`, `ARCHIV_PW`.

Timer: täglich **04:30 UTC** + `RandomizedDelaySec=600` + `Persistent=true` (Catch-up).

## Endpoints — INTERN (öffentliche sind von CT 201 langsam/unerreichbar!)
- **Nextcloud:** `http://100.64.2.36/remote.php/dav/addressbooks/users/kontakte/rosenweg/`
  (apache:80, Header `Host: nextcloud.rosenweg9.ch`). `.36:443` ist von CT 201 zu, der
  swarm-traefik-Pfad `.27` routet `nextcloud.rosenweg9.ch` nicht → darum http:80 direkt.
- **SOGo:** `https://100.64.2.33/SOGo/dav/<mailbox>/Contacts/personal/` (Header
  `Host: mailcow.rosenweg9.ch`). Über die öffentliche IP wären's ~1.8s/Request (Hairpin).
- **Z-Push:** `rsync -a --delete` via SSH (CT-201-root-key → CT 115) nach
  `/var/lib/zpush-contacts/` + `chown www-data`.

## Logik
- UIDs **deterministisch**: `uuid5(name)` für personen, `rosenweg-pbx`,
  `<firmakey>-verwaltung`, `<firmakey>-<nameslug>` für Spezialkontakte → idempotent,
  keine Dubletten (matchen die manuell importierten).
- **delete-stale:** Nextcloud + Z-Push ja (dedizierte Sammlungen). SOGo persönliche
  Bücher **nur Upsert** — sonst würde man die *privaten* Kontakte von inbox@/präsident@ löschen.
- Manuell: `python3 /usr/local/bin/contacts-sync.py`
