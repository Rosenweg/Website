# journal-remote — Journal der Stationen

Die Stationen (os-stationen) schicken ihr Journal laufend mit
`systemd-journal-upload` hierher; lokal bleibt nur ein kleiner Puffer. So geht
bei einem Absturz oder harten Neustart höchstens das verloren, was in den
letzten Sekunden noch nicht übertragen war (Anlass: desktop-r13, 21.11.2026 —
der Hänger vor dem Reset war nirgends mehr zu lesen).

| | |
|---|---|
| Läuft | Container `journal-remote` in `backend-lxc/core/compose.yml` (CT 128, 100.64.2.52) |
| Port | 19532/tcp, HTTPS mit Client-Zertifikat (Stations-CA) |
| Ablage | Volume `journal-remote`, eine Datei je Station (`--split-mode=host`) |
| Aufbewahrung | 30 Tage (`JOURNAL_AUFBEWAHRUNG`), täglich aufgeräumt |

## Zertifikate

Eigene kleine CA nur für das Stationsjournal, angelegt mit
`backend-lxc/core/journal-ca-anlegen.sh` unter `/opt/rosenweg-core/journal-tls/`
(nie im Repo). Darin:

- `ca.key`, `ca.crt` — die CA. Den Schlüssel liest nur die API.
- `server.key`, `server.crt` — das Zertifikat dieses Dienstes (IP 100.64.2.52).

Die Stationen bekommen ihr Client-Zertifikat von der API:
`POST /api/stations/:id/journal-zertifikat` mit Stationstoken und einer CSR,
deren CN die Stations-ID ist. Gültig 1 Jahr; os-stationen erneuert es beim Update.

## Lesen

Im Container:

```bash
docker compose exec journal-remote journalctl --directory=/var/log/journal/remote \
    _HOSTNAME=desktop-test --since -1h
```
