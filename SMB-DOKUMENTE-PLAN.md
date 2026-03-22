# SMB-Zugang für Dokumente (Samba + Git-Sync)

## Context
Die Rosenweg-Dokumente liegen in GitHub (`Rosenweg/documents`) und sind über die Web-API zugänglich. Bewohner sollen auch per SMB-Netzlaufwerk darauf zugreifen können – mit denselben Berechtigungen wie im Web (pro Benutzer via Authentik/LDAP). Bidirektionaler Sync: Änderungen via SMB → GitHub, Änderungen via Web → SMB.

## Architektur

```
Windows Explorer ──SMB (445)──▶ Samba LXC (CT 106)
                                   │
                              /srv/documents/  ◄──git sync──▶  GitHub (Rosenweg/documents)
                                   │
                              LDAP Auth ──▶ Authentik LDAP Outpost (Port 389)
```

## Schritte

### 1. LXC Container erstellen (auf PVE1)
```bash
# Auf 100.64.2.20
pct create 106 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname samba-docs \
  --memory 512 --swap 256 --cores 1 \
  --rootfs local-lvm:8 \
  --net0 name=eth0,bridge=vmbr0,ip=100.64.2.26/24,gw=100.64.2.1 \
  --unprivileged 1 --start 1
```

### 2. Pakete installieren
```bash
pct exec 106 -- bash -c '
apt update && apt install -y samba libnss-ldapd libpam-ldapd git inotify-tools
'
```

### 3. LDAP-Auth konfigurieren (nslcd)

**`/etc/nslcd.conf`:**
```
uri ldap://100.64.2.24:389
base dc=ldap,dc=rosenweg4303,dc=ch
binddn cn=ldap-service,ou=users,dc=ldap,dc=rosenweg4303,dc=ch
bindpw <LDAP_SERVICE_PASSWORD>
```

**`/etc/nsswitch.conf`:** (passwd/group mit ldap erweitern)
```
passwd: files ldap
group:  files ldap
shadow: files ldap
```

**PAM:** `/etc/pam.d/samba` mit pam_ldap konfigurieren

### 4. Git-Repo klonen
```bash
pct exec 106 -- bash -c '
git clone https://<GITHUB_TOKEN>@github.com/Rosenweg/documents.git /srv/documents
chown -R root:root /srv/documents
'
```

### 5. Samba konfigurieren

**`/etc/samba/smb.conf`:**
```ini
[global]
workgroup = ROSENWEG
server string = Rosenweg Dokumente
security = user
passdb backend = ldapsam:ldap://100.64.2.24:389
ldap suffix = dc=ldap,dc=rosenweg4303,dc=ch
ldap admin dn = cn=ldap-service,ou=users,dc=ldap,dc=rosenweg4303,dc=ch
ldap user suffix = ou=users
ldap group suffix = ou=groups
ldap ssl = off
map to guest = Never

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

### 6. Sync-Scripts

**`/usr/local/bin/doc-pull.sh`** (Cron, alle 5 Min):
```bash
#!/bin/bash
cd /srv/documents
git pull --rebase origin main 2>/dev/null
```

**`/usr/local/bin/doc-push.sh`** (inotifywait, Daemon):
```bash
#!/bin/bash
cd /srv/documents
while inotifywait -r -e modify,create,delete,move --exclude '.git' /srv/documents; do
    sleep 5  # Batch Änderungen
    git add -A
    if git diff --cached --quiet; then continue; fi
    git commit -m "SMB: $(date +%Y-%m-%d_%H:%M)"
    git pull --rebase origin main
    git push origin main
done
```

**Cron (`/etc/cron.d/doc-sync`):**
```
*/5 * * * * root /usr/local/bin/doc-pull.sh
```

**Systemd Service (`/etc/systemd/system/doc-push.service`):**
```ini
[Unit]
Description=Document push sync via inotify
After=network.target

[Service]
ExecStart=/usr/local/bin/doc-push.sh
Restart=always
User=root

[Install]
WantedBy=multi-user.target
```

### 7. Netzwerk-Routen
- SMB Port 445 ist auf dem LXC automatisch offen
- Route von 100.64.9.x (Bewohner-Netz) nach 100.64.2.26 sicherstellen (wie vorhin konfiguriert)

## Verifizierung
1. `\\100.64.2.26\allgemein` im Windows Explorer öffnen
2. Login mit Authentik-Benutzername/Passwort
3. Dokument lesen → prüfen ob korrekt angezeigt
4. Dokument via SMB hochladen → prüfen ob es im Web-Frontend erscheint (max 5 Min)
5. Dokument im Web hochladen → prüfen ob es im SMB-Share erscheint (max 5 Min)
6. STWEG-Zugriff: stweg1-User darf stweg2-Share nicht sehen

## Voraussetzungen prüfen
- [ ] LDAP Outpost Authentik: Base-DN und Bind-DN ermitteln
- [ ] LDAP Service Account Passwort (`ldap-service`)
- [ ] GitHub Token mit Repo-Zugriff auf `Rosenweg/documents`
- [ ] Freie IP im 100.64.2.x Netz
- [ ] LXC Template auf PVE1 vorhanden
