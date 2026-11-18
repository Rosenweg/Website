# Edge-Traefik (CT 245)

Stand: 17.11.2026. Sicherheitsregeln im Überblick:
[`../docs/sicherheit.md`](../docs/sicherheit.md) (ISP/Traefik Abschnitt 4.7,
offene Punkte 7.2).

Zentraler Reverse-Proxy für alle Rosenweg-Dienste. **CT 245 `edge-traefik`,
`100.64.2.40`**, Knoten **pve3** (`100.64.2.22`). Die WAN-Ports werden von der
UDM per DNAT hierher geleitet. Den früheren Cloudflare-Tunnel auf den Swarm gibt
es nicht mehr.

```
WAN :80/:443/:465/:587/:993/:25/:8883 ─DNAT─▶ 100.64.2.40
                                                │ Traefik 3 (systemd)
             File-Provider /etc/traefik/dynamic/ ┤
               ├─ routes.yml        ◀── traefik-sync (alle 15 s) ◀── API /api/traefik/dynamic (CT 128)
               ├─ extra-routes.yml  ◀── von Hand aus dem Repo
               └─ static.yml        ◀── dynamic-static.yml (deploy.sh)
                                                ▼
                  Frontend-LXCs (HTTP), Dienste in CTs, TCP-SNI-Passthrough (Mail, Personen)
```

## Dateien

| Repo | Ziel in CT 245 | Zweck |
|---|---|---|
| `traefik.yml` | `/etc/traefik/traefik.yml` | statische Konfiguration: Entrypoints (`web` 80 → Umleitung auf https, `websecure` 443, `smtps` 465, `imaps` 993, `submission` 587, `smtp` 25, `mqtts` 8883, Metriken 127.0.0.1:8082), File-Provider, ACME |
| `dynamic-static.yml` | `/etc/traefik/dynamic/static.yml` | Notfall-Routen (Dashboard, Header) |
| `extra-routes.yml` | `/etc/traefik/dynamic/extra-routes.yml` | feste Routen: www/apex → CT 118, rosenweg9 → CT 122, pwa → CT 130, Nextcloud, Authentik, MQTT, Heizung (ioBroker), TV, Kontakte (Z-Push, TLS hier), Personen-Passthrough |
| `traefik.service` | `/etc/systemd/system/` | Traefik, `EnvironmentFile=/etc/default/traefik` |
| `traefik-sync.sh` | `/usr/local/sbin/traefik-sync.sh` | holt die Datenbank-Routen von der API und schreibt `routes.yml` |
| `traefik-sync.service`, `.timer` | `/etc/systemd/system/` | alle 15 s, `EnvironmentFile=-/etc/default/traefik-sync` |
| `crowdsec.yml` | `/etc/traefik/dynamic/crowdsec.yml` | CrowdSec-Bouncer-Middleware (Plugin), hängt über `traefik.yml` an `websecure` |
| `crowdsec/acquis-traefik.yaml` | `/etc/crowdsec/acquis.d/traefik.yaml` | CrowdSec liest das Zugriffsprotokoll |
| `crowdsec/rosenweg-cf-echte-ip.yaml` | `/etc/crowdsec/parsers/s02-enrich/` | echte Client-IP aus `Cf-Connecting-Ip`, nur bei Cloudflare-Verbindungen |
| `crowdsec/rosenweg-intern.yaml` | `/etc/crowdsec/postoverflows/s01-whitelist/` | eigene Netze nie sperren |
| `echteip.yml` | `/etc/traefik/dynamic/echteip.yml` | Middleware `echteip`: echte Client-IP in `X-Forwarded-For`/`X-Real-Ip` |
| `plugins/echteip/` | `/plugins-local/src/github.com/rosenweg/echteip/` | eigenes Traefik-Plugin dazu (Go, von Traefik interpretiert) |
| `crowdsec/rosenweg-bf.yaml` | `/etc/crowdsec/scenarios/` | Szenarien: Einmal-Codes raten, Code-Drossel fluten, ActiveSync-Passwort-Raten |
| `crowdsec/acquis-syslog.yaml` | `/etc/crowdsec/acquis.d/syslog.yaml` | Syslog-Eingang 100.64.2.40:4514 (Meldungen anderer Hosts) |
| `crowdsec/rosenweg-authentik-*.yaml` | `/etc/crowdsec/parsers/s01-parse/`, `/etc/crowdsec/scenarios/` | Authentik-Fehlanmeldungen (vom Melder auf dem Authentik-CT) |
| `crowdsec/rosenweg-mail-*.yaml` | `/etc/crowdsec/parsers/s01-parse/`, `/etc/crowdsec/scenarios/` | Mailcow-Fehlanmeldungen (vom Melder auf Mailcow) |
| `rw-crowdsec-syslog.nft`, `.service` | `/etc/rosenweg/`, `/etc/systemd/system/` | Syslog-Eingang nur für freigegebene Hosts (Authentik 100.64.2.37, Mailcow 100.64.2.33) |
| `logrotate-stuendlich.conf` | `/etc/systemd/system/logrotate.timer.d/stuendlich.conf` | logrotate stündlich, damit `maxsize 100M` greift |
| `deploy.sh` | läuft vom Arbeitsplatz | kopiert alles ausser `extra-routes.yml` und startet die Dienste |

Geheimnisse (nie im Repo):

| Datei in CT 245 | Variable | Zweck |
|---|---|---|
| `/etc/default/traefik` (0600) | `CF_DNS_API_TOKEN` | DNS-01 für Let's-Encrypt-Zertifikate über Cloudflare |
| `/etc/default/traefik-sync` (0600) | `TRAEFIK_CONFIG_SECRET` | Header `X-Traefik-Secret` für `/api/traefik/dynamic`; derselbe Wert steht in `/opt/rosenweg-core/.env` (CT 128). Fehlt er, antwortet die API 403 und der Sync behält die letzte Konfiguration. |
| `/etc/traefik/.htpasswd` | – | BasicAuth für das Dashboard |
| `/var/lib/traefik/acme.json` (0600) | – | Zertifikate |
| `/etc/traefik/crowdsec-bouncer.key` (0600) | – | LAPI-Schlüssel des Traefik-Bouncers (`cscli bouncers add traefik-bouncer -o raw`, ohne Zeilenumbruch speichern) |

## Was die Datenbank-Routen liefern

Die Routen aus `isp_reverse_proxy_routes`, Weiterleitungen und Mail-Relays
(gepflegt in `isp-admin.html`) erzeugt die API. Seit dem 17.11.2026:

- Nur Einträge mit `approval_status='approved'` werden übernommen;
  Hostnamen, SNI und Ports werden beim Erzeugen erneut geprüft.
- Einträge von Nicht-Admins werden **nie automatisch** freigegeben, wenn der
  Name in einer unserer Cloudflare-Zonen liegt oder sich mit einem fremden
  Eintrag überschneidet. Ändert ein Nicht-Admin Ziel, Port, SNI oder schaltet die
  Anmeldung ab, fällt der Eintrag auf „wartet auf Admin“ zurück. Freigabe in
  `isp-admin.html` mit „Genehmigen“.

Details: `sicherheit.md` Abschnitt 4.7.

## Heizung (ioBroker) nur mit Anmeldung

`heizung.rosenweg9.ch` und `heizung.rosenweg4303.ch` laufen über Authentik
(Middleware `authentik-fwd`). Seit dem 17.11.2026 hängt `authentik-fwd` auch an
den Umleitungs-Routern (`heizung-redirect-rw9`, `heizung4303-redirect`), und die
Umleitungs-Regex ist hostunabhängig (`^https?://[^/]+/.*`). Vorher kam man mit
anderer Schreibweise des Hostnamens (z. B. `HEIZUNG.rosenweg9.ch`) ohne
Anmeldung zu ioBroker, das selbst mit `auth=false` läuft.

## Ausrollen

> `deploy.sh` zielt standardmässig auf pve3 (`PVE=root@100.64.2.22`), wo CT 245
> läuft; `pct` funktioniert nur auf dem Knoten, der den Container hat. Liegt der
> CT woanders (HA-Migration), bricht das Skript ab und nennt den Knoten; dann
> `PVE=root@<knoten-ip> ./deploy.sh`. `extra-routes.yml` deployt es nicht —
> dafür die Schritte unten.

### `extra-routes.yml` (häufigster Fall)

```bash
scp edge-traefik/extra-routes.yml root@100.64.2.22:/tmp/
ssh root@100.64.2.22 '
  pct exec 245 -- cp -L /etc/traefik/dynamic/extra-routes.yml /root/extra-routes.yml.alt
  pct push 245 /tmp/extra-routes.yml /etc/traefik/dynamic/extra-routes.yml'
```

Der File-Provider (`watch: true`) lädt die Datei sofort; kein Neustart nötig.
Ein Syntaxfehler wird im Log gemeldet und die Datei ignoriert – darum danach
immer prüfen (unten).

### Ganze Konfiguration

```bash
ssh root@100.64.2.22 'pct exec 245 -- bash -c "mkdir -p /etc/traefik/dynamic /var/lib/traefik /var/log/traefik; touch /var/lib/traefik/acme.json; chmod 600 /var/lib/traefik/acme.json"'
for f in traefik.yml traefik.service dynamic-static.yml traefik-sync.sh traefik-sync.service traefik-sync.timer; do
  scp -q edge-traefik/$f root@100.64.2.22:/tmp/$f
done
ssh root@100.64.2.22 '
  pct push 245 /tmp/traefik.yml /etc/traefik/traefik.yml
  pct push 245 /tmp/dynamic-static.yml /etc/traefik/dynamic/static.yml
  pct push 245 /tmp/traefik.service /etc/systemd/system/traefik.service
  pct push 245 /tmp/traefik-sync.sh /usr/local/sbin/traefik-sync.sh
  pct push 245 /tmp/traefik-sync.service /etc/systemd/system/traefik-sync.service
  pct push 245 /tmp/traefik-sync.timer /etc/systemd/system/traefik-sync.timer
  pct exec 245 -- chmod +x /usr/local/sbin/traefik-sync.sh
  pct exec 245 -- systemctl daemon-reload
  pct exec 245 -- systemctl enable --now traefik-sync.timer
  pct exec 245 -- systemctl restart traefik'
```

### Geheimnisse setzen (Neuaufbau oder Rotation)

Den Wert nicht auf der Kommandozeile übergeben (Shell-Historie, Prozessliste),
sondern im Container mit einem Editor eintragen:

```bash
ssh root@100.64.2.22 'pct enter 245'
install -m 0600 /dev/null /etc/default/traefik        # dann: CF_DNS_API_TOKEN=<im Passwortmanager>
install -m 0600 /dev/null /etc/default/traefik-sync   # dann: TRAEFIK_CONFIG_SECRET=<im Passwortmanager>
nano /etc/default/traefik /etc/default/traefik-sync
systemctl restart traefik traefik-sync.service
htpasswd -c /etc/traefik/.htpasswd admin              # fragt das Passwort ab
```

Nach dem Rotieren des Cloudflare-Tokens (`sicherheit.md` Abschnitt 7.1, Punkt 1)
auch die Kopien in CT 220 (`/root/.cloudflare.ini`, PBX-Zertifikat) und CT 115
(Z-Push-Zertifikat) nachführen.

## Prüfen

```bash
ssh root@100.64.2.22 'pct exec 245 -- sh -c "
  systemctl is-active traefik traefik-sync.timer
  curl -s http://localhost:80/ping; echo
  journalctl -u traefik-sync -n 5 --no-pager
  tail -n 20 /var/log/traefik/traefik.log | grep -iE \"error|extra-routes\""'
# Heizung ohne Anmeldung -> Umleitung zu Authentik, nie direkt ioBroker:
curl -sI https://HEIZUNG.rosenweg9.ch/ | grep -iE '^(HTTP|location)'
curl -sI https://heizung.rosenweg4303.ch/vis-2/ | grep -iE '^(HTTP|location)'
```

`traefik-sync` meldet bei Erfolg `[traefik-sync] N bytes written`, sonst
`HTTP 403 — keep previous config` (Secret falsch/fehlt) bzw. `HTTP 000`
(API nicht erreichbar).

## Zurückbauen

- `extra-routes.yml`: die Sicherung `/root/extra-routes.yml.alt` (bzw.
  `<datei>.vor-sicherheit-2026-11-17`) zurückkopieren; wird sofort geladen.
- Datenbank-Routen: in `isp-admin.html` bearbeiten; der Sync übernimmt sie
  innerhalb von 15 s.

## CrowdSec (seit 18.11.2026)

Erkennen: CrowdSec 1.8 (Paketquelle packagecloud, `bookworm`) liest
`access.log` (Collection `crowdsecurity/traefik`) sowie sshd/postfix. Über
Cloudflare geleitete Anfragen werden der echten Client-IP zugeordnet
(`Cf-Connecting-Ip`, nur von Cloudflare-Adressen ausgewertet).

Sperren, zweistufig:
- **nftables** (`crowdsec-firewall-bouncer-nftables`, Tabellen `ip crowdsec`,
  `ip6 crowdsec6`): verwirft direkte Verbindungen gesperrter Adressen auf allen
  Ports, auch Mail und MQTT. Cloudflare-Adressen werden nie gesperrt
  (Whitelist `crowdsecurity/cdn-whitelist`).
- **Traefik-Plugin** (`crowdsec-bouncer-traefik-plugin` v1.8.2, lokal unter
  `/plugins-local/src/github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin`):
  antwortet gesperrten Clients hinter Cloudflare mit 403. Fällt CrowdSec aus,
  lässt es alles durch (`updateMaxFailure: -1`).

Nie gesperrt: 100.64.0.0/10, private Netze, `2a02:16a:1400::/48`,
37.17.232.133 und .136.

Bedienen:

```bash
cscli decisions list                 # aktuelle Sperren
cscli alerts list                    # was erkannt wurde
cscli decisions delete --ip <IP>     # Sperre aufheben
cscli metrics                        # gelesene/geparste Zeilen, Bouncer-Abrufe
cscli bouncers list                  # beide Bouncer müssen regelmässig abrufen
```

Plugin aktualisieren: Tarball des neuen Tags nach `/plugins-local/src/...`
entpacken, zuerst mit einer Testinstanz auf 127.0.0.1 prüfen, dann
`systemctl restart traefik`. Zurückbauen: `traefik.yml.vor-crowdsec-2026-11-18`
zurückkopieren, `dynamic/crowdsec.yml` löschen, Traefik neu starten;
`apt purge crowdsec-firewall-bouncer-nftables` entfernt die nft-Sperren.

Eigene Szenarien (`crowdsec/rosenweg-bf.yaml`, `rosenweg-authentik-bf.yaml`):
falsche Einmal-Codes (400/429 an `/api/otp/verify`, `/api/reklamationen/oeffentlich`,
`/api/doodle/verify`), Dauerfeuer in die Code-Drossel, ActiveSync-Passwort-Raten
(401 auf contacts), Authentik-Fehlanmeldungen. Authentik schreibt diese nur in
seine Datenbank; `authentik-ct/authentik-crowdsec-melder` meldet jede Minute die
IP (ohne Benutzername) per Syslog an den Edge.

### Echte Client-IP (seit 18.11.2026)

Hinter Cloudflare sahen API, Frontends und Authentik nur die Adresse des
Cloudflare-Knotens: die Code-Limits je IP galten für alle Nutzer desselben
Knotens gemeinsam, Authentik verbuchte Fehlanmeldungen auf Cloudflare. Das
Plugin `echteip` setzt `X-Forwarded-For`/`X-Real-Ip` auf `Cf-Connecting-Ip` —
nur wenn die Verbindung aus einem Cloudflare-Netz kommt; sonst die
Verbindungsadresse, gefälschte `Cf-*`-Köpfe werden entfernt. Der Kopf wird
überschrieben, nicht ergänzt (Cloudflare hängt an einen vom Client gesetzten
Kopf nur an). Cloudflare-Netze in `echteip.yml` und `crowdsec.yml` gleich halten.

### Mail (seit 18.11.2026)

- **IMAPS** läuft mit PROXY-Protokoll: Router `imaps-mailcow-proxy` in
  `extra-routes.yml` (Priorität 10000, überdeckt die Datenbank-Routen) →
  Mailcow `100.64.2.33:10993` (Mailcows eingebauter `imaps_haproxy`-Listener).
  Mailcow nimmt PROXY-Köpfe nur von 100.64.2.40 an
  (`data/conf/dovecot/extra.conf`: `haproxy_trusted_networks`), Port in
  `docker-compose.override.yml`. Dovecot sieht so die echte Client-IP.
- Mailcows eigene Sperre (netfilter) sperrt auf CT 240 — bei proxierten
  Verbindungen kommen die Pakete aber vom Edge, dort greift sie nicht. Darum
  meldet `mailcow/mailcow-crowdsec-melder.py` (Dienst auf CT 240) jede
  Fehlanmeldung (Dovecot, SASL, SOGo; nur IP) per Syslog an den Edge,
  Szenario `rosenweg/mail-bf` sperrt dort.
- 100.64.2.40 steht in Mailcows Sperr-Whitelist (`F2B_WHITELIST`), damit
  Fehlversuche über noch nicht proxierte Wege (Webmail 443, SMTPS über PMG)
  nicht den Edge und damit alle sperren.
- Offen: Webmail/Mailcow-Oberfläche (443, SNI-Durchleitung aus der Datenbank)
  und SMTPS (PMG prüft Passwörter über Dovecot-Port 10001) sehen weiter nur
  die Edge-IP.

fail2ban ist bewusst nicht installiert: CrowdSec deckt sshd ab, ein zweites
Sperrsystem würde nur doppelt zählen.

## Logs

- `/var/log/traefik/traefik.log` — Traefik selbst
- `/var/log/traefik/access.log` — Anfragen (JSON). Hinter Cloudflare steht in
  `ClientHost` die Adresse des Cloudflare-Knotens; die echte Adresse steht in
  `request_Cf-Connecting-Ip`. Rotation stündlich ab 100 MB (das Shelly-Polling
  schreibt mehrere hundert MB pro Stunde). `copytruncate` braucht freien Platz
  in Grösse des Logs; ist das Log zu gross geworden:
  `gzip -c access.log > access.log.1.gz && truncate -s 0 access.log`.
- `/var/log/crowdsec.log` — CrowdSec
- `journalctl -u traefik -f`, `journalctl -u traefik-sync`

## Offen

- `deploy.sh` verweist auf pve1 statt pve3 (siehe oben).
