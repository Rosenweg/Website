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
                  Frontend-LXCs (HTTP), Dienste in CTs, TCP-SNI-Passthrough (Mail, Kontakte)
```

## Dateien

| Repo | Ziel in CT 245 | Zweck |
|---|---|---|
| `traefik.yml` | `/etc/traefik/traefik.yml` | statische Konfiguration: Entrypoints (`web` 80 → Umleitung auf https, `websecure` 443, `smtps` 465, `imaps` 993, `submission` 587, `smtp` 25, `mqtts` 8883, Metriken 127.0.0.1:8082), File-Provider, ACME |
| `dynamic-static.yml` | `/etc/traefik/dynamic/static.yml` | Notfall-Routen (Dashboard, Header) |
| `extra-routes.yml` | `/etc/traefik/dynamic/extra-routes.yml` | feste Routen: www/apex → CT 118, rosenweg9 → CT 122, pwa → CT 130, Nextcloud, Authentik, MQTT, Heizung (ioBroker), TV, Kontakte-/Personen-Passthrough |
| `traefik.service` | `/etc/systemd/system/` | Traefik, `EnvironmentFile=/etc/default/traefik` |
| `traefik-sync.sh` | `/usr/local/sbin/traefik-sync.sh` | holt die Datenbank-Routen von der API und schreibt `routes.yml` |
| `traefik-sync.service`, `.timer` | `/etc/systemd/system/` | alle 15 s, `EnvironmentFile=-/etc/default/traefik-sync` |
| `deploy.sh` | läuft vom Arbeitsplatz | kopiert alles ausser `extra-routes.yml` und startet die Dienste |

Geheimnisse (nie im Repo):

| Datei in CT 245 | Variable | Zweck |
|---|---|---|
| `/etc/default/traefik` (0600) | `CF_DNS_API_TOKEN` | DNS-01 für Let's-Encrypt-Zertifikate über Cloudflare |
| `/etc/default/traefik-sync` (0600) | `TRAEFIK_CONFIG_SECRET` | Header `X-Traefik-Secret` für `/api/traefik/dynamic`; derselbe Wert steht in `/opt/rosenweg-core/.env` (CT 128). Fehlt er, antwortet die API 403 und der Sync behält die letzte Konfiguration. |
| `/etc/traefik/.htpasswd` | – | BasicAuth für das Dashboard |
| `/var/lib/traefik/acme.json` (0600) | – | Zertifikate |

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

## Logs

- `/var/log/traefik/traefik.log` — Traefik selbst
- `/var/log/traefik/access.log` — Anfragen (JSON). Hinter Cloudflare steht dort
  die Adresse des Cloudflare-Knotens, nicht die des Clients.
- `journalctl -u traefik -f`, `journalctl -u traefik-sync`

## Offen

- CrowdSec/fail2ban sind auf dem Edge nicht installiert (`sicherheit.md`
  Abschnitt 7.2).
- `deploy.sh` verweist auf pve1 statt pve3 (siehe oben).
