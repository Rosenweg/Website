# Dokumenten-Fileserver (Samba + API + GitHub-Backup)

## Context

Die Rosenweg-Dokumente liegen aktuell in GitHub (`Rosenweg/documents`) und werden über die GitHub API gelesen/geschrieben. Das hat mehrere Nachteile:
- **25MB Upload-Limit** (GitHub Contents API + Base64)
- **Git-Repo wächst** unkontrolliert mit Binärdateien
- **Kein SMB-Zugriff** für Windows-Netzlaufwerke
- **GitHub API ist Single Point of Failure** für Dokumentenzugriff

**Neue Architektur:** Lokaler Fileserver als Primary, GitHub nur als Backup.

## Architektur

```
Windows Explorer ──SMB (445)───────▶┐
                                     │
Website API ──HTTP (intern)──────────┼──▶ Fileserver LXC (CT 106, PVE1)
                                     │         /srv/documents/
Gotenberg (Preview) ──HTTP──────────┘              │
                                              rsync (5 Min)
                                                   │
                                         Replica LXC (CT 206, PVE2)
                                              /srv/documents/
                                                   │
                                         git push (stündlich)
                                                   │
                                              GitHub Backup
                                         (Rosenweg/documents)
```

### Zugriffswege

| Zugang | Protokoll | Lesen | Schreiben |
|--------|-----------|-------|-----------|
| Website (Browser) | HTTPS → API → Fileserver | Ja | Ja (Admin) |
| Windows Explorer | SMB (445) | Ja | Ja (nach Gruppe) |
| Gotenberg Preview | HTTP intern | Ja | Nein |

## Teil 1: Fileserver LXC (CT 106 auf PVE1)

### 1.1 LXC Container erstellen
```bash
# Auf PVE1 (100.64.2.20)
pct create 106 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname fileserver \
  --memory 1024 --swap 512 --cores 2 \
  --rootfs local-lvm:50 \
  --net0 name=eth0,bridge=vmbr0,ip=100.64.2.26/24,gw=100.64.2.1 \
  --unprivileged 1 --start 1
```

> **50GB Disk** statt 8GB — Platz für Dokumente aller 8 STWEGs + Scans.

### 1.2 Pakete installieren
```bash
pct exec 106 -- bash -c '
apt update && apt install -y \
  samba libnss-ldapd libpam-ldapd \
  rsync openssh-server \
  git curl jq python3 \
  acl
'
```

### 1.3 Service-User und Verzeichnisstruktur
```bash
pct exec 106 -- bash -c '
# Service-User
useradd -r -s /usr/sbin/nologin -d /srv/documents docsync

# Verzeichnisstruktur anlegen
mkdir -p /srv/documents/{allgemein,Scans,stweg1,stweg2,stweg3,stweg4,stweg5,stweg6,stweg7,stweg8}
mkdir -p /srv/documents/.recycle
mkdir -p /srv/documents/.git-backup

# Berechtigungen
chown -R docsync:docsync /srv/documents
chmod -R 2775 /srv/documents

# ACL: docsync-Gruppe hat immer Zugriff
setfacl -R -d -m g:docsync:rwx /srv/documents
'
```

### 1.4 LDAP-Auth konfigurieren (nslcd + PAM)

**`/etc/nslcd.conf`:**
```
uri ldap://100.64.2.24:389
base dc=ldap,dc=rosenweg4303,dc=ch
binddn cn=ldap-service,ou=users,dc=ldap,dc=rosenweg4303,dc=ch
bindpw <LDAP_SERVICE_PASSWORD>

filter passwd (objectClass=posixAccount)
filter group (objectClass=posixGroup)
map passwd homeDirectory "/home/$uid"
map passwd loginShell "/bin/false"
```

**`/etc/nsswitch.conf`:**
```
passwd: files ldap
group:  files ldap
shadow: files ldap
```

**`/etc/pam.d/samba`:**
```
auth    required    pam_env.so
auth    sufficient  pam_ldap.so
auth    required    pam_deny.so

account sufficient  pam_ldap.so
account required    pam_deny.so

session required    pam_mkhomedir.so skel=/etc/skel umask=0022
session optional    pam_ldap.so
```

### 1.5 Samba konfigurieren

**`/etc/samba/smb.conf`:**
```ini
[global]
workgroup = ROSENWEG
server string = Rosenweg Dokumente
security = user
passdb backend = tdbsam
obey pam restrictions = yes
pam password change = yes
map to guest = Never

# Alle Dateien als docsync-User (verhindert UID-Chaos)
force user = docsync
force group = docsync
create mask = 0664
directory mask = 0775

# VFS: Papierkorb + Audit
vfs objects = recycle audit
recycle:repository = /srv/documents/.recycle/%U
recycle:keeptree = yes
recycle:versions = yes
recycle:maxsize = 104857600
recycle:exclude = *.tmp ~$* .~lock.*
audit:facility = LOCAL5
audit:priority = NOTICE

# Logging
log file = /var/log/samba/log.%m
log level = 1
max log size = 1000

[allgemein]
path = /srv/documents/allgemein
browseable = yes
read only = no
valid users = @technik @Präsident @stweg1-ausschuss @stweg2-ausschuss @stweg3-ausschuss @stweg4-ausschuss @stweg5-ausschuss @stweg6-ausschuss @stweg7-ausschuss @stweg8-ausschuss @stweg1-bewohner @stweg1-eigentuemer @stweg2-bewohner @stweg2-eigentuemer @r9-bewohner @r9-eigentuemer @stweg4-bewohner @stweg4-eigentuemer @stweg5-bewohner @stweg5-eigentuemer @r1-bewohner @r1-eigentuemer @stweg7-bewohner @stweg7-eigentuemer
write list = @technik @Präsident @stweg1-ausschuss @stweg2-ausschuss @stweg3-ausschuss @stweg4-ausschuss @stweg5-ausschuss @stweg6-ausschuss @stweg7-ausschuss @stweg8-ausschuss

[Scans]
path = /srv/documents/Scans
browseable = yes
read only = yes
valid users = @technik @Präsident @stweg1-bewohner @stweg1-eigentuemer @stweg2-bewohner @stweg2-eigentuemer @r9-bewohner @r9-eigentuemer @stweg4-bewohner @stweg4-eigentuemer @stweg5-bewohner @stweg5-eigentuemer @r1-bewohner @r1-eigentuemer @stweg7-bewohner @stweg7-eigentuemer @stweg1-ausschuss @stweg2-ausschuss @stweg3-ausschuss @stweg4-ausschuss @stweg5-ausschuss @stweg6-ausschuss @stweg7-ausschuss @stweg8-ausschuss

[stweg1]
path = /srv/documents/stweg1
browseable = yes
read only = no
valid users = @technik @Präsident @stweg1-bewohner @stweg1-eigentuemer @stweg1-ausschuss
write list = @technik @Präsident @stweg1-ausschuss

[stweg2]
path = /srv/documents/stweg2
browseable = yes
read only = no
valid users = @technik @Präsident @stweg2-bewohner @stweg2-eigentuemer @stweg2-ausschuss
write list = @technik @Präsident @stweg2-ausschuss

[stweg3]
path = /srv/documents/stweg3
browseable = yes
read only = no
valid users = @technik @Präsident @r9-bewohner @r9-eigentuemer @stweg3-ausschuss
write list = @technik @Präsident @stweg3-ausschuss

[stweg4]
path = /srv/documents/stweg4
browseable = yes
read only = no
valid users = @technik @Präsident @stweg4-bewohner @stweg4-eigentuemer @stweg4-ausschuss
write list = @technik @Präsident @stweg4-ausschuss

[stweg5]
path = /srv/documents/stweg5
browseable = yes
read only = no
valid users = @technik @Präsident @stweg5-bewohner @stweg5-eigentuemer @stweg5-ausschuss
write list = @technik @Präsident @stweg5-ausschuss

[stweg6]
path = /srv/documents/stweg6
browseable = yes
read only = no
valid users = @technik @Präsident @r1-bewohner @r1-eigentuemer @stweg6-ausschuss
write list = @technik @Präsident @stweg6-ausschuss

[stweg7]
path = /srv/documents/stweg7
browseable = yes
read only = no
valid users = @technik @Präsident @stweg7-bewohner @stweg7-eigentuemer @stweg7-ausschuss
write list = @technik @Präsident @stweg7-ausschuss

[stweg8]
path = /srv/documents/stweg8
browseable = yes
read only = no
valid users = @technik @Präsident @stweg8-ausschuss
write list = @technik @Präsident @stweg8-ausschuss
```

### 1.6 Passwort-Synchronisation (Authentik → Samba)

Samba braucht NTLM-Hashes in tdbsam. Diese werden mit Authentik synchronisiert.

#### A) Initialer Sync

**`/usr/local/bin/smb-init-users.sh`:**
```bash
#!/bin/bash
AUTHENTIK_URL="https://rosenweg4303.ch"
AUTHENTIK_TOKEN="<AUTHENTIK_API_TOKEN>"

USERS=$(curl -sf "$AUTHENTIK_URL/api/v3/core/users/?is_active=true&page_size=500" \
    -H "Authorization: Bearer $AUTHENTIK_TOKEN" | jq -r '.results[].username')

for USERNAME in $USERS; do
    if pdbedit -L -u "$USERNAME" &>/dev/null; then
        echo "SKIP: $USERNAME (exists)"
        continue
    fi
    if ! id "$USERNAME" &>/dev/null; then
        echo "SKIP: $USERNAME (not in LDAP)"
        continue
    fi

    TEMP_PW="Rosenweg-$(openssl rand -hex 4)"
    (echo "$TEMP_PW"; echo "$TEMP_PW") | smbpasswd -a -s "$USERNAME"
    smbpasswd -e "$USERNAME"
    echo "CREATED: $USERNAME (temp pw: $TEMP_PW)"
done
```

#### B) Passwort-Sync bei Änderung (Authentik Webhook)

**`/usr/local/bin/smb-password-webhook.py`:**
```python
#!/usr/bin/env python3
"""Authentik Webhook Listener: setzt SMB-Passwort bei Passwortänderung."""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json, subprocess, secrets, os, urllib.request

SHARED_SECRET = os.environ.get("WEBHOOK_SECRET", "")
SMTP2GO_API_KEY = os.environ.get("SMTP2GO_API_KEY", "")

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.headers.get("Authorization") != f"Bearer {SHARED_SECRET}":
            self.send_response(403); self.end_headers(); return

        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        username = body.get("context", {}).get("user", {}).get("username")
        email = body.get("context", {}).get("user", {}).get("email")
        if not username:
            self.send_response(400); self.end_headers(); return

        temp_pw = f"Smb-{secrets.token_hex(4)}"
        proc = subprocess.run(["smbpasswd", "-a", "-s", username],
            input=f"{temp_pw}\n{temp_pw}\n", capture_output=True, text=True)

        if proc.returncode == 0 and email:
            data = json.dumps({
                "api_key": SMTP2GO_API_KEY, "to": [email],
                "sender": "noreply@rosenweg4303.ch",
                "subject": "Neues SMB-Passwort (Rosenweg Dokumente)",
                "html_body": f"<p>Dein neues SMB-Passwort: <b>{temp_pw}</b></p>"
                             f"<p>Verbinden mit: <code>\\\\100.64.2.26</code></p>"
            }).encode()
            req = urllib.request.Request("https://api.smtp2go.com/v3/email/send",
                data=data, headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req)

        self.send_response(200); self.end_headers()

if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8445), Handler).serve_forever()
```

Authentik-Konfiguration: Notification Transport → Webhook → `http://100.64.2.26:8445` → Trigger: `password_set`

### 1.7 Rsyslog für Audit
```
# /etc/rsyslog.d/samba-audit.conf
local5.* /var/log/samba/audit.log
```

### 1.8 Cron-Jobs

**`/etc/cron.d/fileserver`:**
```
# Papierkorb: Dateien älter 30 Tage löschen
0 3 * * * root find /srv/documents/.recycle -type f -mtime +30 -delete && find /srv/documents/.recycle -type d -empty -delete

# Disk usage alert (>80%)
0 * * * * root USAGE=$(df /srv/documents --output=pcent | tail -1 | tr -d ' %%'); [ "$USAGE" -gt 80 ] && curl -sf https://rosenweg4303.ch/api/notifications/sync-alert -X POST -H 'Content-Type: application/json' -d "{\"type\":\"disk\",\"message\":\"Fileserver Disk bei ${USAGE}%%\"}" || true
```

## Teil 2: Replica (CT 206 auf PVE2)

### 2.1 LXC Container erstellen
```bash
# Auf PVE2 (100.64.2.21)
pct create 206 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname fileserver-replica \
  --memory 512 --swap 256 --cores 1 \
  --rootfs local-lvm:50 \
  --net0 name=eth0,bridge=vmbr0,ip=100.64.2.27/24,gw=100.64.2.1 \
  --unprivileged 1 --start 1
```

### 2.2 SSH-Key für rsync
```bash
# Auf CT 206 (Replica)
pct exec 206 -- bash -c '
apt update && apt install -y rsync openssh-client git
useradd -r -s /usr/sbin/nologin -d /srv/documents docsync
mkdir -p /srv/documents
chown docsync:docsync /srv/documents
'

# SSH Key generieren (auf CT 106, Primary)
pct exec 106 -- bash -c '
ssh-keygen -t ed25519 -f /root/.ssh/rsync_key -N ""
cat /root/.ssh/rsync_key.pub
'
# → Public Key in CT 206 /root/.ssh/authorized_keys eintragen
```

### 2.3 rsync-Sync (Primary → Replica, alle 5 Min)

**Auf CT 106 (Primary), `/usr/local/bin/doc-replicate.sh`:**
```bash
#!/bin/bash
set -euo pipefail
LOGFILE="/var/log/doc-replicate.log"
REPLICA="100.64.2.27"

rsync -az --delete \
    --exclude='.recycle/' \
    --exclude='.git-backup/' \
    -e "ssh -i /root/.ssh/rsync_key -o StrictHostKeyChecking=no" \
    /srv/documents/ root@${REPLICA}:/srv/documents/ \
    >> "$LOGFILE" 2>&1

if [ $? -eq 0 ]; then
    echo "$(date) REPLICATE OK" >> "$LOGFILE"
else
    echo "$(date) REPLICATE FAILED" >> "$LOGFILE"
    curl -sf "https://rosenweg4303.ch/api/notifications/sync-alert" -X POST \
        -H "Content-Type: application/json" \
        -d '{"type":"replicate-error","message":"rsync zu Replica fehlgeschlagen"}' \
        2>/dev/null || true
fi
```

**Cron (`/etc/cron.d/doc-replicate`):**
```
*/5 * * * * root /usr/local/bin/doc-replicate.sh
```

## Teil 3: GitHub Backup (stündlich)

Auf CT 106 (Primary) — Git-Repo nur für Backup, nicht mehr als Primary Storage.

### 3.1 Git-Backup einrichten
```bash
pct exec 106 -- bash -c '
# Git Credential Helper
git config --system credential.helper store
echo "https://rosenweg-bot:<GITHUB_TOKEN>@github.com" > /root/.git-credentials
chmod 600 /root/.git-credentials

# Backup-Repo initialisieren (separates Verzeichnis!)
git clone https://github.com/Rosenweg/documents.git /srv/documents/.git-backup/repo
cd /srv/documents/.git-backup/repo
git config user.name "Fileserver Backup"
git config user.email "backup@rosenweg4303.ch"
'
```

### 3.2 Backup-Script

**`/usr/local/bin/doc-github-backup.sh`:**
```bash
#!/bin/bash
set -euo pipefail
LOGFILE="/var/log/doc-backup.log"
BACKUP_REPO="/srv/documents/.git-backup/repo"

# Dateien aus Live-Verzeichnis ins Backup-Repo synchronisieren
rsync -a --delete \
    --exclude='.recycle/' \
    --exclude='.git-backup/' \
    --exclude='.git/' \
    /srv/documents/ "$BACKUP_REPO/"

cd "$BACKUP_REPO"

git add -A
if git diff --cached --quiet; then
    echo "$(date) BACKUP: no changes" >> "$LOGFILE"
    exit 0
fi

git commit -m "Backup: $(date +%Y-%m-%d_%H:%M)" >> "$LOGFILE" 2>&1

if git push origin main >> "$LOGFILE" 2>&1; then
    echo "$(date) BACKUP OK" >> "$LOGFILE"
else
    echo "$(date) BACKUP PUSH FAILED" >> "$LOGFILE"
    curl -sf "https://rosenweg4303.ch/api/notifications/sync-alert" -X POST \
        -H "Content-Type: application/json" \
        -d '{"type":"backup-error","message":"GitHub Backup Push fehlgeschlagen"}' \
        2>/dev/null || true
fi
```

**Cron:**
```
0 * * * * root /usr/local/bin/doc-github-backup.sh
```

## Teil 4: API-Umbau (server.js)

Die Document-Endpoints in `api/server.js` werden von GitHub API auf **HTTP-Zugriff zum Fileserver** umgebaut. Der API-Container greift per HTTP auf einen kleinen File-Service auf CT 106 zu, oder — einfacher — per **NFS-Mount** direkt auf das Dateisystem.

### Option A: NFS-Mount (empfohlen, einfachste Lösung)

Der API-Docker-Container mountet `/srv/documents` vom Fileserver per NFS:

```yaml
# docker-compose.yml / stack
services:
  api:
    image: ghcr.io/rosenweg/rosenweg-api:latest
    volumes:
      - documents:/documents:rw
    environment:
      - DOCS_PATH=/documents
      - DOCS_BACKEND=filesystem

volumes:
  documents:
    driver: local
    driver_opts:
      type: nfs
      o: addr=100.64.2.26,rw,nolock,soft
      device: ":/srv/documents"
```

Auf CT 106 NFS installieren:
```bash
pct exec 106 -- bash -c '
apt install -y nfs-kernel-server
echo "/srv/documents 100.64.2.0/24(rw,sync,no_subtree_check,no_root_squash)" >> /etc/exports
exportfs -ra
systemctl enable --now nfs-server
'
```

### Option B: File-API auf CT 106 (falls NFS nicht geht)

Kleiner Express-Server auf CT 106 der nur interne Requests beantwortet:

```javascript
// Auf CT 106, Port 8446 (nur internes Netz)
app.get('/files/*', (req, res) => {
    const filePath = path.join('/srv/documents', req.params[0]);
    if (!filePath.startsWith('/srv/documents/')) return res.status(403).end();
    res.sendFile(filePath);
});
app.get('/list', (req, res) => {
    // Rekursiv alle Dateien listen
});
app.put('/files/*', upload.single('file'), (req, res) => {
    // Datei schreiben
});
app.delete('/files/*', (req, res) => {
    // Datei löschen (in Papierkorb verschieben)
});
```

### 4.1 Änderungen in `api/server.js`

Die ~450 Zeilen GitHub-API-Code werden durch ~150 Zeilen Filesystem-Code ersetzt:

```javascript
// ═══════════════════════════════════════════════════════════════════
// DOCUMENTS (lokaler Fileserver, NFS-Mount oder HTTP)
// ═══════════════════════════════════════════════════════════════════

const DOCS_PATH = process.env.DOCS_PATH || '/documents';
const fs = require('fs').promises;
const pathModule = require('path');

// Sicherstellen dass der Pfad innerhalb von DOCS_PATH bleibt
function safePath(userPath) {
    const resolved = pathModule.resolve(DOCS_PATH, userPath);
    if (!resolved.startsWith(pathModule.resolve(DOCS_PATH))) return null;
    return resolved;
}

// GET /api/documents - Alle Dokumente auflisten
app.get('/api/documents', authMiddleware, async (req, res) => {
    try {
        const allFiles = [];

        async function walk(dir, prefix = '') {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue; // .recycle, .git-backup etc.
                const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    await walk(pathModule.join(dir, entry.name), relPath);
                } else {
                    const stat = await fs.stat(pathModule.join(dir, entry.name));
                    allFiles.push({
                        name: entry.name,
                        path: relPath,
                        size: stat.size,
                        url: `/api/documents/${relPath}`,
                        modified: stat.mtime.toISOString(),
                    });
                }
            }
        }

        await walk(DOCS_PATH);

        // Filter nach User-Berechtigungen (bestehende isDocPathAllowed Logik)
        const filtered = allFiles.filter(f => isDocPathAllowed(f.path, req.userGroups));
        res.json(filtered);
    } catch (err) {
        console.error('Documents list error:', err);
        res.status(500).json({ error: 'Fehler beim Laden der Dokumente' });
    }
});

// GET /api/documents/:path(*) - Datei herunterladen
app.get('/api/documents/:path(*)', authMiddleware, async (req, res) => {
    const filePath = safePath(req.params.path);
    if (!filePath) return res.status(400).json({ error: 'Ungültiger Pfad' });
    if (!isDocPathAllowed(req.params.path, req.userGroups))
        return res.status(403).json({ error: 'Kein Zugriff' });

    try {
        const stat = await fs.stat(filePath);
        res.setHeader('Content-Length', stat.size);
        // Content-Type aus Extension ableiten
        const ext = pathModule.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml',
            '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            '.txt': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip',
        };
        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');

        const { createReadStream } = require('fs');
        createReadStream(filePath).pipe(res);
    } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: 'Datei nicht gefunden' });
        res.status(500).json({ error: 'Download fehlgeschlagen' });
    }
});

// PUT /api/documents/:path(*) - Datei hochladen/ersetzen
app.put('/api/documents/:path(*)', authMiddleware, canManageDocs, async (req, res) => {
    const filePath = safePath(req.params.path);
    if (!filePath) return res.status(400).json({ error: 'Ungültiger Pfad' });
    if (!isDocPathAllowed(req.params.path, req.userGroups))
        return res.status(403).json({ error: 'Kein Zugriff' });

    try {
        // Verzeichnis erstellen falls nötig
        await fs.mkdir(pathModule.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, req.body);
        res.json({ success: true, path: req.params.path });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Upload fehlgeschlagen' });
    }
});

// DELETE /api/documents/:path(*) - Datei löschen
app.delete('/api/documents/:path(*)', authMiddleware, canManageDocs, async (req, res) => {
    const filePath = safePath(req.params.path);
    if (!filePath) return res.status(400).json({ error: 'Ungültiger Pfad' });

    try {
        await fs.unlink(filePath);
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: 'Datei nicht gefunden' });
        res.status(500).json({ error: 'Löschen fehlgeschlagen' });
    }
});

// POST /api/documents/folder - Ordner erstellen
app.post('/api/documents/folder', authMiddleware, canManageDocs, async (req, res) => {
    const { path: folderPath } = req.body;
    const fullPath = safePath(folderPath);
    if (!fullPath) return res.status(400).json({ error: 'Ungültiger Pfad' });

    try {
        await fs.mkdir(fullPath, { recursive: true });
        res.json({ success: true, path: folderPath });
    } catch (err) {
        res.status(500).json({ error: 'Ordner erstellen fehlgeschlagen' });
    }
});

// POST /api/documents/move - Datei verschieben
app.post('/api/documents/move', authMiddleware, canManageDocs, async (req, res) => {
    const { from, to } = req.body;
    const fromPath = safePath(from);
    const toPath = safePath(to);
    if (!fromPath || !toPath) return res.status(400).json({ error: 'Ungültiger Pfad' });

    try {
        await fs.mkdir(pathModule.dirname(toPath), { recursive: true });
        await fs.rename(fromPath, toPath);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Verschieben fehlgeschlagen' });
    }
});
```

### 4.2 Was wegfällt

- `GITHUB_DOCS_REPO`, `GITHUB_DOCS_TOKEN`, `GITHUB_DOCS_BRANCH` Variablen
- `docsListCache` (kein Cache nötig, Filesystem ist schnell)
- Alle `fetch()` Calls zur GitHub API für Dokumente
- Base64-Encoding/Decoding für Uploads
- SHA-Handling für Updates/Deletes
- `.gitkeep` Workarounds für leere Ordner
- **25MB Upload-Limit** (jetzt nur noch durch Disk-Platz begrenzt)

### 4.3 Was sich im Frontend NICHT ändert

- `js/documents.js` bleibt **komplett unverändert** — die API-Endpoints haben dieselben Pfade und dasselbe Response-Format
- Einzige Änderung: `size` wird jetzt in Bytes geliefert (statt von GitHub), ggf. Anpassung im Frontend
- `?refresh=1` Parameter wird nicht mehr gebraucht (kein Cache)

### 4.4 Gotenberg Preview

Gotenberg greift jetzt direkt auf den NFS-Mount zu statt die Datei erst von GitHub zu laden:

```javascript
// In POST /api/documents-preview — nur die Datei-Quelle ändert sich:
// ALT: const fileResp = await fetch(githubUrl, { headers: ... });
// NEU:
const fileBuffer = await fs.readFile(safePath(docPath));
```

## Teil 5: Migration (GitHub → Fileserver)

### 5.1 Bestehende Dokumente übertragen
```bash
pct exec 106 -- bash -c '
cd /srv/documents/.git-backup
git clone https://github.com/Rosenweg/documents.git repo-import
rsync -a repo-import/ /srv/documents/ --exclude=.git
rm -rf repo-import
chown -R docsync:docsync /srv/documents
'
```

### 5.2 Reihenfolge
1. Fileserver LXC aufsetzen (Teil 1)
2. Dokumente von GitHub klonen und kopieren (Teil 5.1)
3. Replica LXC aufsetzen (Teil 2)
4. API umbauen und deployen (Teil 4)
5. Testen: Upload, Download, Ordner, Verschieben, SMB
6. GitHub Backup-Cron aktivieren (Teil 3)
7. `GITHUB_DOCS_TOKEN` aus API-Environment entfernen

## Teil 6: Healthcheck

**`/usr/local/bin/doc-healthcheck.sh`** (auf CT 106):
```bash
#!/bin/bash
ERRORS=0; STATUS="ok"; DETAILS=""

# 1. Disk-Usage
USAGE=$(df /srv/documents --output=pcent | tail -1 | tr -d ' %')
if [ "$USAGE" -gt 90 ]; then
    STATUS="error"; DETAILS="Disk usage ${USAGE}%"; ERRORS=$((ERRORS+1))
elif [ "$USAGE" -gt 80 ]; then
    STATUS="warning"; DETAILS="Disk usage ${USAGE}%"; ERRORS=$((ERRORS+1))
fi

# 2. Samba läuft
if ! systemctl is-active --quiet smbd; then
    STATUS="error"; DETAILS="smbd not running"; ERRORS=$((ERRORS+1))
fi

# 3. NFS läuft
if ! systemctl is-active --quiet nfs-server; then
    STATUS="error"; DETAILS="nfs-server not running"; ERRORS=$((ERRORS+1))
fi

# 4. Replica erreichbar
if ! ssh -i /root/.ssh/rsync_key -o ConnectTimeout=5 root@100.64.2.27 "ls /srv/documents" &>/dev/null; then
    STATUS="warning"; DETAILS="Replica nicht erreichbar"; ERRORS=$((ERRORS+1))
fi

# 5. Letztes Backup < 2h
LAST_BACKUP=$(stat -c %Y /var/log/doc-backup.log 2>/dev/null || echo 0)
NOW=$(date +%s)
if [ $((NOW - LAST_BACKUP)) -gt 7200 ]; then
    STATUS="warning"; DETAILS="Backup älter als 2 Stunden"; ERRORS=$((ERRORS+1))
fi

echo "{\"status\":\"$STATUS\",\"errors\":$ERRORS,\"details\":\"$DETAILS\",\"disk\":\"${USAGE}%\"}"

if [ "$STATUS" = "error" ]; then
    curl -sf "https://rosenweg4303.ch/api/notifications/sync-alert" -X POST \
        -H "Content-Type: application/json" \
        -d "{\"type\":\"healthcheck\",\"status\":\"$STATUS\",\"details\":\"$DETAILS\"}" \
        2>/dev/null || true
fi
```

**Cron:**
```
*/15 * * * * root /usr/local/bin/doc-healthcheck.sh >> /var/log/doc-healthcheck.log 2>&1
```

## Teil 7: Failover

Bei Ausfall von PVE1 (Primary):

1. **Automatisch:** Website API bekommt NFS-Timeout → Error
2. **Manuell (< 5 Min):**
   ```bash
   # Auf PVE2: Replica zum Primary machen
   pct exec 206 -- bash -c '
   apt install -y nfs-kernel-server
   echo "/srv/documents 100.64.2.0/24(rw,sync,no_subtree_check,no_root_squash)" >> /etc/exports
   exportfs -ra
   # IP des Primary übernehmen
   ip addr add 100.64.2.26/24 dev eth0
   '
   ```
3. **Nach Reparatur von PVE1:** Daten von Replica zurücksyncen, IP zurückgeben

> **Hinweis:** Für automatisches Failover bräuchte man Keepalived (VRRP), das ist für die aktuelle Grösse Overkill. Manuell < 5 Min Downtime ist akzeptabel.

## Netzwerk-Übersicht

| Host | IP | Rolle |
|------|-----|-------|
| CT 106 (PVE1) | 100.64.2.26 | Primary Fileserver (Samba + NFS) |
| CT 206 (PVE2) | 100.64.2.27 | Replica (rsync Target) |
| Docker Swarm | 100.64.2.x | API Container (NFS Client) |
| Authentik LDAP | 100.64.2.24:389 | Benutzer-Auth |

Ports auf CT 106:
- **445** (SMB) — Bewohner-Netz + internes Netz
- **2049** (NFS) — nur internes Netz (100.64.2.0/24)
- **8445** (Webhook) — nur internes Netz
- **22** (SSH) — nur für rsync von Replica

## Voraussetzungen
- [ ] LDAP Outpost: Base-DN und Bind-DN ermitteln
- [ ] LDAP Service Account Passwort (`ldap-service`)
- [ ] Authentik API Token (für User-Init-Script)
- [ ] GitHub Token (für Backup-Push)
- [ ] LXC Templates auf PVE1 und PVE2 vorhanden
- [ ] Authentik LDAP liefert posixAccount/posixGroup Attribute
- [ ] Webhook Secret für Passwort-Sync festlegen
- [ ] SMTP2GO API Key für Passwort-Benachrichtigungen
- [ ] NFS-Port (2049) zwischen Docker-Nodes und CT 106 offen
- [ ] SMB-Port (445) von Bewohner-Netz (100.64.9.x) nach CT 106 offen

## Vorteile gegenüber alter Architektur

| | Alt (GitHub Primary) | Neu (Fileserver Primary) |
|---|---|---|
| Upload-Limit | 25MB | Unbegrenzt (Disk) |
| Upload-Speed | Langsam (Base64 → GitHub API) | Schnell (lokales Filesystem) |
| SMB-Zugang | Bidirektionaler Git-Sync (komplex) | Direkt auf Filesystem (trivial) |
| Redundanz | Keine (nur GitHub) | Replica + GitHub Backup |
| Konflikte | Git-Merge-Konflikte möglich | Keine (ein Filesystem, eine Wahrheit) |
| API-Komplexität | ~450 Zeilen GitHub API Code | ~150 Zeilen fs Code |
| Offline-Verfügbar | Nein (GitHub API nötig) | Ja (lokales NFS) |
| Kosten | GitHub LFS ($5/50GB) | Nur Disk-Platz (vorhanden) |
