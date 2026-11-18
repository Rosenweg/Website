# Z-Push ActiveSync — Rosenweg-Kontaktverzeichnis

Stand: 17.11.2026. Sicherheitsregeln im Überblick:
[`../docs/sicherheit.md`](../docs/sicherheit.md) (Grenzwerte Abschnitt 5,
Variablen Abschnitt 6.3).

Bewohner fügen auf dem Telefon **ein** Exchange/ActiveSync-Konto hinzu
(Authentik-Login) → das gemeinsame Rosenweg-Verzeichnis erscheint im
Telefonbuch, ohne Zusatz-App und ohne Postfach. Für alle mit Authentik-Konto.

## Host

| | |
|---|---|
| Container | **CT 115 `zpush`**, Knoten **pve3** (`100.64.2.22`) |
| Adresse | `100.64.2.38` |
| System | Debian 13, PHP 8.4, nginx, `php8.4-fpm` |
| Z-Push | Z-Hub-Fork in `/usr/share/z-push/src` |
| Backend | `backend/rosenweg/rosenweg.php` (= `backend-rosenweg.php` hier im Repo) |
| nginx | `/etc/nginx/sites-enabled/` (= `nginx-zpush.conf` hier im Repo) |
| Kontakte | `/var/lib/zpush-contacts/` (vCards, täglich von `contacts-sync`, siehe `../contacts-sync/`) |
| Zustand | `STATE_DIR=/var/lib/z-push/`, Fehlversuchs-Zähler in `/var/lib/z-push/rw-logon/` |
| Logs | `LOGFILEDIR=/var/log/z-push/` |

Das Backend erbt `BackendVCardDir`, überschreibt `Logon()` mit einem
**LDAP-Bind gegen den Authentik-Outpost** (Standard `ldap://100.64.2.37:389`,
DN `cn=<user>,ou=users,dc=rosenweg4303,dc=ch`) und `GetSupportedASVersion()` →
`ASV_141`. Konfiguration: `config.php` mit `BACKEND_PROVIDER='BackendRosenweg'`,
`backend/vcarddir/config.php` mit `VCARDDIR_DIR='/var/lib/zpush-contacts'`
(gemeinsam für alle, kein `%u`).

## Anmeldung und Schutz gegen Passwortraten (seit 17.11.2026)

Jede ActiveSync-Anfrage ist ein LDAP-Bind gegen ein Authentik-Konto. Ohne
Grenze liesse sich darüber beliebig Passwörter raten. Zwei Stufen:

**1. Je Benutzername (Backend).**

- Benutzernamen werden getrimmt und müssen `^[A-Za-z0-9._@-]{1,64}$`
  entsprechen; sonst wird ohne LDAP-Versuch abgelehnt.
- Jeder Anmeldeversuch wird **vor** dem LDAP-Bind gezählt (Datei je Benutzer
  unter `STATE_DIR/rw-logon/`, Name = SHA-256 des kleingeschriebenen
  Benutzernamens, Zugriff unter Dateisperre). Ein erfolgreicher Bind gibt nur
  den eigenen Zählerschritt zurück; frühere Fehlversuche bleiben stehen.
- **5 Versuche in 15 Minuten** (ab dem ersten Versuch des Fensters) – danach ist
  der Benutzername bis zum Ende des Fensters gesperrt, **auch mit richtigem
  Passwort**. Im Z-Push-Log steht dann
  `BackendRosenweg: abgelehnt (zu viele Fehlversuche oder Sperrdatei-Fehler) <name>`.
- Kann die Zählerdatei nicht angelegt, gesperrt oder geschrieben werden (Platte
  voll, Rechte), wird die Anmeldung **abgelehnt** (fail closed):
  `BackendRosenweg: Sperrdatei nicht beschreibbar - Anmeldung abgelehnt`.
- Abgelaufene Zählerdateien werden gelegentlich (bei etwa jedem 20. neuen
  Benutzernamen, höchstens 500 je Durchgang) gelöscht.

**2. Gesamtdeckel (nginx).** `limit_req_zone … zone=zpush_as rate=10r/s`,
Burst 60, Antwort **429**. Weil edge-traefik die Verbindung per TCP ohne
PROXY-Protokoll durchreicht, sieht nginx für alle Clients die Edge-IP – das
Limit gilt also für alle zusammen, nicht je Client.

Was Bewohner bei einer Sperre tun: 15 Minuten warten, Passwort im Telefon
prüfen. Ein Telefon mit falsch gespeichertem Passwort versucht es selbständig
immer wieder und hält die Sperre aufrecht – dann das Konto im Telefon
korrigieren oder vorübergehend deaktivieren.

Technik: Sperre vorzeitig aufheben (im Container):

```bash
f=/var/lib/z-push/rw-logon/$(printf '%s' 'vorname.nachname' | tr 'A-Z' 'a-z' | sha256sum | cut -d' ' -f1)
cat "$f"; rm -f "$f"
```

**LDAPS (optional):** Mit `env[RW_LDAP_URI] = ldaps://100.64.2.37:636` im
php-fpm-Pool (`/etc/php/8.4/fpm/pool.d/www.conf`, danach
`systemctl reload php8.4-fpm`) spricht das Backend verschlüsselt mit dem
Outpost. Dann muss dessen Zertifikat gültig und in `/etc/ldap/ldap.conf`
(`TLS_CACERT`) bekannt sein. Ohne Variable: `ldap://100.64.2.37:389`.

## Routing (TLS endet am Edge, seit 18.11.2026)

- DNS `contacts.rosenweg4303.ch` → A `37.17.232.133` (DNS-only, nicht über
  Cloudflare-Proxy).
- **edge-traefik** (CT 245): HTTP-Router `contacts-rw4303` mit Zertifikat über
  den Traefik-Resolver `cf` → `http://100.64.2.38` (siehe
  `../edge-traefik/extra-routes.yml`). Das Zertifikat erneuert sich mit allen
  anderen Edge-Zertifikaten; auf CT 115 gibt es **kein** certbot und **kein**
  Cloudflare-Token mehr.
- CT 115 nimmt Port 80 nur von 100.64.2.40 an (`$realip_remote_addr`), die
  echte Client-Adresse kommt per `X-Forwarded-For` (`real_ip`). Damit wirken
  `limit_req` und die Fehlversuch-Sperre in `backend-rosenweg.php` je Client.
  `fastcgi_param HTTPS on`, weil Clients immer über HTTPS kommen.
- Vorher (bis 18.11.2026): SNI-Passthrough auf `:443` mit eigenem certbot auf
  CT 115. Dessen Cloudflare-Token war seit Sommer ungültig, das Zertifikat seit
  16.09.2026 abgelaufen, 186 Erneuerungsläufe scheiterten unbemerkt.

## Ausrollen

```bash
scp zpush/backend-rosenweg.php zpush/nginx-zpush.conf root@100.64.2.22:/tmp/
ssh root@100.64.2.22 '
  pct push 115 /tmp/backend-rosenweg.php /usr/share/z-push/src/backend/rosenweg/rosenweg.php
  pct push 115 /tmp/nginx-zpush.conf /etc/nginx/sites-enabled/zpush.conf
  pct exec 115 -- sh -c "php -l /usr/share/z-push/src/backend/rosenweg/rosenweg.php && nginx -t && systemctl reload nginx php8.4-fpm"
  pct exec 115 -- sh -c "install -d -o www-data -g www-data -m 0700 /var/lib/z-push/rw-logon"'
```

Den Dateinamen in `sites-enabled/` vorher mit `ls /etc/nginx/sites-enabled/`
prüfen und den vorhandenen überschreiben (nicht eine zweite Datei daneben
legen – zwei `default_server` auf 443 lassen `nginx -t` scheitern).

## Prüfen

```bash
curl -s https://contacts.rosenweg4303.ch/                                    # "Rosenweg Kontakte-Sync (ActiveSync)"
echo | openssl s_client -connect contacts.rosenweg4303.ch:443 -servername contacts.rosenweg4303.ch 2>/dev/null | openssl x509 -noout -enddate
ssh root@100.64.2.22 'pct exec 115 -- sh -c "ls -ld /var/lib/z-push/rw-logon; grep -h BackendRosenweg /var/log/z-push/*.log | tail -n 20"'
```

Sperre testen (mit einem Testkonto, nie mit einem echten): sechsmal mit falschem
Passwort anmelden, dann mit richtigem – die sechste und die richtige Anmeldung
müssen abgelehnt werden.

## Zurückbauen

Die beim Rollout am 17.11.2026 ersetzten Dateien liegen als
`<datei>.vor-sicherheit-2026-11-17` daneben (bzw. in `/root/` des Containers).
Zurückkopieren, `php -l`, `nginx -t`, `systemctl reload nginx php8.4-fpm`. Ohne
das neue Backend gibt es wieder unbegrenzte LDAP-Versuche.

## Patches / Fallen (PHP 8.4)

- `vcarddir.php`: **`sed -i 's/w2ui(/(/g'`** — vcarddir nimmt CP1252 an und
  kodiert UTF-8 doppelt → Umlaute kaputt. `w2ui` (windows1252→utf8) raus, da die
  Daten schon UTF-8 sind.
- `STATE_DIR` `/var/lib/z-push` und `LOGFILEDIR` `/var/log/z-push` müssen
  existieren und `www-data` gehören (sonst HTTP 500). Gilt auch für
  `/var/lib/z-push/rw-logon` – fehlen dort die Rechte, wird **jede** Anmeldung
  abgelehnt.
- Das Backend muss `GetSupportedASVersion()` überschreiben (≥ 12.1), sonst
  „AS version 2.5 not supported“.

## Client-Einstellungen

Server `contacts.rosenweg4303.ch`, Port `443`, SSL/TLS, Benutzer =
**Authentik-Benutzername ohne @**, Passwort = Authentik-Passwort, nur
**Kontakte** synchronisieren. Anleitung für Bewohner: `hilfe.html` #kontakte-sync.
