# Z-Push ActiveSync — Rosenweg-Kontaktverzeichnis

Bewohner fügen **ein** Exchange/ActiveSync-Konto hinzu (Authentik-Login) → das gemeinsame
Rosenweg-Verzeichnis erscheint **nativ im Telefonbuch**, ohne Zusatz-App, ohne Postfach.
Gratis, für alle mit Authentik-Konto.

## Host: CT 115 (`zpush`, 100.64.2.38, Debian 13, PHP 8.4)
- **Z-Push** (Z-Hub-Fork) in `/usr/share/z-push/src`.
- **Custom-Backend** `backend/rosenweg/rosenweg.php` (= `backend-rosenweg.php` hier):
  erbt `BackendVCardDir`, überschreibt `Logon()` mit **LDAP-Bind gegen Authentik**
  (`ldap://100.64.2.37:389`, DN `cn=<user>,ou=users,dc=rosenweg4303,dc=ch`, bind_mode direct)
  und `GetSupportedASVersion()` → `ASV_141`.
- `config.php`: `BACKEND_PROVIDER='BackendRosenweg'`, `STATE_DIR=/var/lib/z-push/`.
- `backend/vcarddir/config.php`: `VCARDDIR_DIR='/var/lib/zpush-contacts'` (gemeinsam, kein `%u`).
- **nginx** (`nginx-zpush.conf`): 443 mit eigenem LE-Cert → fastcgi `php8.4-fpm`.
- vCards (vom täglichen Sync, siehe `../contacts-sync/`) in `/var/lib/zpush-contacts/`.

## Routing (kein edge-ACME!)
- DNS `contacts.rosenweg4303.ch` → A `37.17.232.133` (DNS-only).
- **edge-traefik** (CT 245) TCP-SNI-Passthrough `HostSNI(contacts.rosenweg4303.ch)` → CT 115:443
  (siehe `../edge-traefik/extra-routes.yml`).
- CT 115 hat **eigenes** Cert via `certbot certonly --dns-cloudflare -d contacts.rosenweg4303.ch`.
  (Der edge-traefik-ACME für contacts war LE-rate-limited + flaky → darum Passthrough + eigenes Cert.)

## Patches / Fallen (PHP 8.4)
- `vcarddir.php`: **`sed -i 's/w2ui(/(/g'`** — vcarddir nimmt CP1252 an und doppel-encodet
  UTF-8 → Umlaute garbled. `w2ui` (windows1252→utf8) raus, da Daten schon UTF-8 sind.
- `STATE_DIR` `/var/lib/z-push` + `LOGFILEDIR` `/var/log/z-push` müssen existieren + `www-data` gehören (sonst HTTP 500).
- Backend MUSS `GetSupportedASVersion()` überschreiben (≥12.1), sonst „AS version 2.5 not supported".

## Client-Einstellungen
Server `contacts.rosenweg4303.ch`, Port `443`, SSL/TLS, Benutzer = **Authentik-Username ohne @**,
Passwort = Authentik-Passwort, nur **Kontakte** synchronisieren. Anleitung: `hilfe.html` #kontakte-sync.
