# Dokumenten-Fileserver (Samba/CIFS + API + GitHub-Backup)

## Architektur

```
Windows Explorer ──SMB (445)───────▶┐
                                     │
Website API ──CIFS Volume────────────┼──▶ Fileserver LXC (CT 106, PVE1)
                                     │         100.64.2.28
Gotenberg (Preview) ──────────────┘         /srv/documents/
                                                   │
                                         git push (stündlich)
                                                   │
                                              GitHub Backup
                                         (Rosenweg/documents)
```

### Zugriffswege

| Zugang | Protokoll | Lesen | Schreiben |
|--------|-----------|-------|-----------|
| Website (Browser) | HTTPS → API → CIFS Volume | Ja | Ja (Admin) |
| Windows Explorer | SMB (445) | Ja | Ja (nach Gruppe) |
| Gotenberg Preview | Via API → CIFS Volume | Ja | Nein |

## Implementiert

### CT 106 — Fileserver (Samba)

- **Host:** PVE1 (100.64.2.20)
- **IP:** 100.64.2.28/24 (vmbr2)
- **Typ:** Privilegiert (nötig für Samba)
- **Disk:** 50GB LVM (`local-lvm:50`)
- **RAM:** 1024MB, Swap 512MB, 2 Cores
- **DNS:** 1.1.1.1, 8.8.8.8 (nicht Netbird-DNS)
- **Features:** mount=cifs (falls nötig für Clients)

**Pakete:** samba, rsync, git, curl

**Samba-Config (`/etc/samba/smb.conf`):**

```ini
[global]
   workgroup = ROSENWEG
   server string = Rosenweg Fileserver
   server role = standalone server
   log file = /var/log/samba/log.%m
   max log size = 1000
   logging = file
   map to guest = Bad User
   usershare allow guests = no
   socket options = TCP_NODELAY IPTOS_LOWDELAY
   read raw = yes
   write raw = yes
   server min protocol = SMB2
   client min protocol = SMB2

[dokumente]
   comment = Rosenweg Dokumente
   path = /srv/documents
   browseable = yes
   read only = no
   valid users = @rosenweg
   create mask = 0664
   directory mask = 0775
   force group = rosenweg
   vfs objects = recycle
   recycle:repository = .recycle/%U
   recycle:keeptree = yes
   recycle:versions = yes
   recycle:touch = yes
   recycle:maxsize = 104857600

[api]
   comment = API Document Access
   path = /srv/documents
   browseable = no
   read only = no
   valid users = api-svc
   create mask = 0664
   directory mask = 0775
   force group = rosenweg

[scans]
   comment = Scanner Upload
   path = /srv/documents/Scans
   browseable = no
   read only = no
   valid users = scanner
   create mask = 0664
   directory mask = 0775
   force group = rosenweg
```

**Samba-User:**
- `api-svc` — Service-Account für Docker CIFS Volume (Passwort: in `CIFS_PASSWORD` env var)
- `scanner` — Service-Account für Netzwerkscanner (Passwort: `ScanRw2026`, nur Zugriff auf `[scans]` Share)
- `@rosenweg` — Gruppe für End-User (noch nicht konfiguriert, braucht LDAP/Authentik-Integration)

**Daten:** 140 Dateien, ~114MB in `/srv/documents/`

### Docker CIFS Volume

In `docker-stack.yml`:

```yaml
services:
  api:
    volumes:
      - rosenweg-documents:/documents

volumes:
  rosenweg-documents:
    driver: local
    driver_opts:
      type: cifs
      device: //100.64.2.28/api
      o: "username=api-svc,password=${CIFS_PASSWORD},vers=3.0,uid=0,gid=0,file_mode=0664,dir_mode=0775"
```

**Warum CIFS statt NFS:** NFS-Kernel-Server in LXC funktioniert nicht — der Kernel-Server bindet an den Container-Namespace, aber Pakete von aussen kommen im Host-Namespace an. Samba/CIFS läuft komplett in Userspace und hat dieses Problem nicht.

**Warum Docker Volume statt bind-mount:** LXC mount propagation funktioniert nicht zuverlässig mit Docker. Docker CIFS Volume mountet direkt aus dem Container heraus.

### CT 201 — Docker Host (CIFS Client)

- **IP:** 100.64.2.24/24 (vmbr2)
- **Features:** mount=cifs aktiviert
- **CIFS Credentials:** `/root/.smb-credentials` (username=api-svc)
- **fstab:** `//100.64.2.28/api /srv/documents cifs credentials=/root/.smb-credentials,vers=3.0,uid=0,gid=0,file_mode=0664,dir_mode=0775,_netdev 0 0`

> Hinweis: Der fstab-Mount in CT 201 ist optional/Backup — der API-Container nutzt das Docker CIFS Volume direkt.

## GitHub-Backup (stündlich)

### Einrichtung

Auf CT 106:

```bash
# Git-Repo in /srv/documents initialisieren (oder klonen)
cd /srv/documents
git init
git remote add origin https://github.com/Rosenweg/documents.git
git config user.name "Fileserver Backup"
git config user.email "backup@rosenweg4303.ch"

# Git Credential Helper
git config credential.helper store
echo "https://rosenweg-bot:<GITHUB_TOKEN>@github.com" > /root/.git-credentials
chmod 600 /root/.git-credentials
```

### Backup-Script

**`/usr/local/bin/doc-github-backup.sh`:**
```bash
#!/bin/bash
REPO_DIR=/srv/documents
LOG=/var/log/doc-github-backup.log
cd $REPO_DIR || exit 1
if [ ! -d .git ]; then
  echo "$(date): No git repo, skipping" >> $LOG
  exit 0
fi
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "$(date): No changes" >> $LOG
  exit 0
fi
git add -A
git commit -m "Auto-backup $(date +%Y-%m-%d_%H:%M)" 2>&1 >> $LOG
git push 2>&1 >> $LOG
RC=$?
echo "$(date): GitHub push (exit $RC)" >> $LOG
exit $RC
```

### Cron

**`/etc/cron.d/rosenweg-documents`:**
```
# GitHub Backup stündlich
0 * * * * root /usr/local/bin/doc-github-backup.sh

# Papierkorb: Dateien älter 30 Tage löschen
0 3 * * * root find /srv/documents/.recycle -type f -mtime +30 -delete 2>/dev/null; find /srv/documents/.recycle -type d -empty -delete 2>/dev/null
```

## Noch offen

### Samba End-User-Zugang
Der `[dokumente]` Share braucht LDAP/Authentik-Integration für End-User:
- Option A: LDAP Outpost (nslcd + PAM) — Authentik liefert posixAccount/posixGroup
- Option B: Passwort-Sync-Webhook (Authentik → smbpasswd)
- Option C: Manuell Samba-User anlegen (einfachste Lösung für wenige User)

### GitHub-Backup aktivieren
- GitHub Token für `rosenweg-bot` erstellen
- Git-Repo in `/srv/documents` initialisieren
- `.gitignore` für `.recycle/` erstellen
- Erster Push testen

### Cleanup
- Altes `/srv/rosenweg-documents` auf PVE1-Host entfernen (war bind-mount source)
- Altes Docker Volume `rosenweg-docs` (mit IP .26) beim nächsten prune entfernen
- `CIFS_PASSWORD` env var bei Stack-Deploy setzen

### docker-stack.yml deployen
Die CIFS-Volume-Änderung in `docker-stack.yml` ist committed aber noch nicht deployed. Beim nächsten `docker stack deploy` muss `CIFS_PASSWORD` in der `.env` stehen.

## API-Endpoints (Filesystem-basiert)

Die Document-Endpoints in `api/server.js` nutzen `DOCS_PATH=/documents` (gemountet via CIFS):

| Methode | Pfad | Beschreibung |
|---------|------|-------------|
| GET | `/api/documents` | Alle Dokumente auflisten |
| GET | `/api/documents/:path` | Datei herunterladen |
| PUT | `/api/documents/:path` | Datei hochladen/ersetzen |
| DELETE | `/api/documents/:path` | Datei löschen |
| POST | `/api/documents/folder` | Ordner erstellen |
| POST | `/api/documents/move` | Datei verschieben |

## Netzwerk

| Host | IP | Bridge | Rolle |
|------|-----|--------|-------|
| CT 106 (PVE1) | 100.64.2.28 | vmbr2 | Fileserver (Samba) |
| CT 201 (PVE1) | 100.64.2.24 | vmbr2 | Docker Host (CIFS Client) |
| Docker API | via CIFS Volume | — | Dokumente lesen/schreiben |

Ports auf CT 106:
- **445** (SMB) — internes Netz (100.64.2.0/24)

## Bekannte Probleme & Lösungen

| Problem | Ursache | Lösung |
|---------|---------|--------|
| NFS in LXC | Kernel-Namespace-Mismatch | CIFS/Samba statt NFS |
| Docker bind-mount "Host is down" | LXC mount propagation | Docker CIFS Volume |
| Stale ARP nach CT-Neuerstellen | Alte MAC in ARP-Cache | `ip neigh flush dev vmbr2` |
| IP-Konflikte | Mehrere Geräte mit gleicher IP | CT 106 auf .28 verschoben |
| DNS in LXC | Netbird-DNS kann extern nicht resolven | `pct set --nameserver '1.1.1.1 8.8.8.8'` |
| Stack deploy löscht env vars | .env wird neu evaluiert | Env vars einzeln via `docker service update --env-add` setzen |
