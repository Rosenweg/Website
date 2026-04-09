# Active Directory — Rosenweg

## Übersicht

Samba AD Domain Controller mit 2-Wege-Sync zu Authentik. Ermöglicht Windows-Domain-Join, SMB-Dateizugriff und zentrales Benutzermanagement.

```
Authentik (SSO, Web-Login)
    │
    ▼ Sync (alle 2 Min)
Samba AD DC (CT 108)
    │
    ├── Fileserver (CT 106, Domain Member)
    │   ├── SMB Shares (dokumente, scans, api)
    │   └── FTP (vsftpd, lokale Auth)
    │
    └── Windows PCs (Domain Join)
        └── Netzlaufwerke, Login
```

## Domain Controller (CT 108 — dc1)

- **Domain**: `AD.ROSENWEG4303.CH`
- **NetBIOS**: `ROSENWEG`
- **IP**: `100.64.2.30`
- **OS**: Debian 13
- **Forest Level**: Windows 2008 R2
- **Samba Version**: 4.22

### Dienste
- `samba-ad-dc.service` — AD Domain Controller
- `ad-password-api.service` — HTTP Password API (Port 8446)
- Cron: Authentik → AD Sync alle 2 Minuten

### Authentik → AD Sync (`/opt/ad-sync/sync.py`)

**Ablauf:**
1. Fetcht alle Users und Groups von Authentik API
2. Erstellt fehlende Groups in AD (`samba-tool group add`)
3. Erstellt fehlende Users in AD (`samba-tool user create`)
4. Fügt Users zu Gruppen hinzu (`samba-tool group addmembers`)

**Gefiltert (nicht synchronisiert):**
- Users: `ak-*`, `ldap-*`, `AnonymousUser`
- Groups: `authentik Admins`, `authentik Read-only`, `ldap-search`

**Konfiguration:**
- Authentik API URL: `https://authentik.rosenweg4303.ch`
- User-Agent: `RosenwegADSync/1.0` (nötig wegen Cloudflare Browser Integrity Check)
- Log: `/var/log/ad-sync.log`
- Cron: `/etc/cron.d/ad-sync`

### Password API (`/opt/ad-sync/password-api.py`)

HTTP-Service auf Port 8446, setzt AD-Passwörter.

```
POST http://100.64.2.30:8446/
Authorization: Bearer RwAdPwApi2026!
Content-Type: application/json
{"username": "stefan.mueller", "password": "neuesPasswort"}
```

Wird aufgerufen von:
- API Server (`/api/change-password`) — Passwort-Änderung durch User
- API Server (User-Erstellung) — Initiales Passwort setzen
- Fileserver Webhook — SMB Passwort-Weiterleitung (alt)

## Fileserver (CT 106 — fileserver)

- **Domain Member**: `ROSENWEG` (AD.ROSENWEG4303.CH)
- **IP**: `100.64.2.28`
- **OS**: Debian 12

### SMB Shares

| Share | Pfad | Zugriff | Beschreibung |
|-------|------|---------|-------------|
| `dokumente` | `/srv/documents` | @rosenweg (Gruppe) | Alle Dokumente, Papierkorb |
| `api` | `/srv/documents` | ROSENWEG\api-svc | API Docker-Zugriff |
| `scans` | `/srv/documents/Scans` | ROSENWEG\scanner | Scanner-Upload |

### FTP (vsftpd)

- **Port**: 21
- **Auth**: Nur lokal (kein Winbind) — eigene PAM-Config `/etc/pam.d/vsftpd`
- **User**: `scanner` (lokaler User)
- **Passwort**: `****** (siehe .env)`
- **Chroot**: `/srv/documents`
- **PASV Ports**: 30000-30100

### Samba Konfiguration

```ini
[global]
   workgroup = ROSENWEG
   realm = AD.ROSENWEG4303.CH
   security = ADS
   winbind use default domain = yes
   server min protocol = NT1       # Für ältere Scanner
   force group = rosenweg
   create mask = 0664
   directory mask = 0775
```

### ID Mapping

| Config | Backend | Range | Beschreibung |
|--------|---------|-------|-------------|
| * | tdb | 3000-7999 | Default/Builtin |
| ROSENWEG | rid | 10000-999999 | AD Domain Users/Groups |

## Passwort-Synchronisation

### Website → Authentik + AD
1. User ändert Passwort auf `/profil.html`
2. API sucht User in Authentik via Email
3. API setzt neues Passwort in Authentik (`/core/users/{pk}/set_password/`)
4. API setzt neues Passwort in AD (Password API auf DC)

### Einschränkungen
- **Kein Reverse-Sync**: Windows-Passwort-Änderung wird NICHT nach Authentik synchronisiert
- **Initiale Sync**: Bestehende User müssen einmalig ihr Passwort über die Website ändern
- `grant_type=password` ist in Authentik NICHT aktiviert — altes Passwort wird nicht geprüft

## Windows Domain Join

Anleitung als PDF auf dem Fileserver: `/srv/documents/allgemein/anleitungen/windows-domain-join.pdf`

### Kurzfassung
1. DNS auf `100.64.2.30` (DC) setzen
2. Domain `AD.ROSENWEG4303.CH` joinen
3. Login mit AD-Benutzername + Passwort (das auf der Website gesetzte)

## DNS

- UDM Conditional Forward: `ad.rosenweg4303.ch` → `100.64.2.30`
- Alle Docker-CTs und CT 106 nutzen Gateway `100.64.2.1` als DNS
- DC ist autoritativ für `ad.rosenweg4303.ch`
