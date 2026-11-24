# Euro-Office (Nextcloud-Office)

Stand 24.11.2026. Bearbeiten von Word-, Excel- und PowerPoint-Dateien direkt in
der Nextcloud. Euro-Office ist der europäische ONLYOFFICE-Fork, den Nextcloud
selbst mitträgt; ONLYOFFICE und Collabora sind bewusst nicht im Einsatz.

| Teil | Wo |
|---|---|
| Dokumentserver | CT 139 `euro-office` auf pve2, `100.64.2.58`, Debian 12, Paket `euro-office-documentserver` 9.3.8 |
| Öffentlich | `https://office.rosenweg4303.ch/` — Route 35 in `isp_reverse_proxy_routes` (Gruppe technik, ohne Authentik), CNAME → `public.rosenweg4303.ch`, nicht proxied |
| Nextcloud | CT 104, App `eurooffice` 11.0.6 |

## Wie es zusammenhängt

- Browser laden den Editor von `https://office.rosenweg4303.ch/`.
- Die Nextcloud spricht den Server intern an: `DocumentServerInternalUrl = http://100.64.2.58/`.
- Der Server holt und speichert Dateien über `StorageUrl = https://nextcloud.rosenweg4303.ch/`.
- Abgesichert ist alles über den JWT-Schlüssel: auf dem Server in
  `/etc/euro-office/documentserver/local.json` (`services.CoAuthoring.secret.*`),
  in der Nextcloud `config:app eurooffice jwt_secret`. Beide müssen gleich sein.
  Den Schlüssel nie ausgeben oder ins Repo schreiben.
- Datenbank: PostgreSQL lokal im Container, Benutzer `ds`, Passwort nur in
  `/root/euro-office-db.pw` (CT 139).

`documentserver_community` (alter eingebauter Mini-Server) und `onlyoffice`
sind in der Nextcloud ausgeschaltet.

## Prüfen

```bash
# Server
ssh root@100.64.2.20 'ssh pve2 "pct exec 139 -- curl -s http://localhost/healthcheck"'   # true
# Verbindung aus Sicht der Nextcloud
ssh root@100.64.2.20 'pct exec 104 -- sudo -u www-data php /var/www/nextcloud/occ eurooffice:documentserver --check'
```

Logs: `/var/log/euro-office/documentserver/{docservice,converter}/out.log`.

## Aktualisieren

Neue Version unter <https://github.com/Euro-Office/DocumentServer/releases>.
`.deb` herunterladen, SHA-256 mit dem Wert der Release-Seite vergleichen, dann
`apt-get install -y ./euro-office-documentserver_<version>_amd64.deb`. Die
Installation erzeugt Schriften und Designs neu (auf Ceph rund 10 Minuten).
Die `local.json` mit dem Schlüssel bleibt erhalten — danach `--check` laufen lassen.
