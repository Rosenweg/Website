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

## Der Start-Rennfall mit IPv6 (12.09.2026)

dc2 (CT 136) stand vom **09.09. bis 12.09.2026 still** — drei Tage, ohne dass
es jemandem auffiel. Der Dienst war nicht defekt:

```
kdc_add_socket: Failed to bind to 2a02:16a:1400:9:be24:11ff:fe72:5f6:88 UDP
                — NT_STATUS_ADDRESS_NOT_ASSOCIATED
task_server_terminate: [kdc failed to setup interfaces]
```

Samba bindet beim Start an **alle** Adressen des Systems. Die globale IPv6
kommt hier per Router Advertisement (`dynamic`, `valid_lft` ~1h) und ist ein
bis zwei Sekunden nach `network-online.target` noch nicht vergeben. Samba
bricht dann ab — und die mitgelieferte Unit hat **`Restart=no`**. Ein Rennen
von zwei Sekunden wird so zu einem Ausfall ohne Ende.

Behoben mit einem Drop-in unter
`/etc/systemd/system/samba-ad-dc.service.d/ipv6-rennen.conf`:

```ini
[Unit]
StartLimitIntervalSec=600
StartLimitBurst=20

[Service]
ExecStartPre=/usr/local/sbin/warte-ipv6.sh
Restart=on-failure
RestartSec=15
```

`warte-ipv6.sh` wartet bis zu 60 s auf eine globale IPv6 und gibt dann
**trotzdem** frei — ohne IPv6 soll Samba wenigstens ueber IPv4 starten. Ein
harter Abbruch waere die schlechtere Wahl: er wuerde aus einem
IPv6-Problem einen Totalausfall machen.

**dc1 hat dasselbe Drop-in bekommen, obwohl er lief.** Er hat exakt dieselbe
Konfiguration und war nur zufaellig auf der richtigen Seite des Rennens.
Fallen beide Controller gleichzeitig, ist die Domaene weg — das ist kein
Zustand, den man dem Zufall ueberlaesst.

Nach dem Start hat sich die Replikation von selbst aufgeholt
(`samba-tool drs showrepl`: alle Partitionen erfolgreich, 0 consecutive
failures). Ein AD haelt drei Tage Trennung problemlos aus; die Tombstone-
Lifetime liegt bei 180 Tagen.

