# TV7-Streamer (CT 250)

Stand: 17.11.2026.

Eigenständiger Node-Proxy für Init7-TV. Liefert alle 242 Sender an Browser
(mpegts.js) und native Player.

| | |
|---|---|
| Container | **CT 250**, Knoten **pve1** (`100.64.2.20`) |
| Adresse | **`100.64.9.23:3000`** im VLAN 9 (RK-Clients) – so rufen ihn die Haupt-API (`TV7_STREAMER_URL`) und `fe-isp` (`/tv-stream/`) auf. Ältere Angaben `100.64.9.250` sind überholt bzw. nicht belegt. |
| Dienst | `tv7-streamer.service`, läuft seit 17.11.2026 als Systembenutzer **`tv7`** (nicht mehr root) |
| Programm | `/opt/tv7-streamer/server.js` |
| Umgebung | `/etc/default/tv7-streamer` (0600): `TV7_HMAC_SECRET`, `PORT=3000` |
| udpxy | CT 109 `tv-proxy`, `100.64.9.24:4022` (Haupt-API: `UDPXY_BASE`/`UDPXY_HOST`) |

## Quellen pro Kanal

- **Multicast** `udp://@233.50.230.x:5000` (alle 242, lokal im VLAN 9; Codecs
  HEVC/H.264/MPEG-2).
- **HTTP-HLS** `api.tv.init7.net` (nur ~101 mit Channel-ID, immer H.264).

## Browser-Auslieferung

- `?codec=hevc` (HEVC-fähiger Browser): Multicast-Quelle, Video unverändert,
  MPEG-2 → H.264.
- sonst: H.264-Quelle (HTTP wo vorhanden, sonst Multicast); HEVC/MPEG-2 → H.264
  (max. 720p). Audio AC-3/MP2 → AAC.

## Endpunkte

- `/channels` — JSON (242, mit `mcast`/`httpId`/`hevc`/`h264`).
- `/playlist.m3u` — alle 242 als udpxy-URLs. Browser laden die M3U über
  `/api/tv/playlist.m3u` (Haupt-API).
- `/stream/<id>?token=…[&codec=hevc]` — MPEG-TS. Der Token ist
  `<payload>.<sig>`: `payload` = base64url-JSON mit Ablaufzeit `exp`, `sig` =
  die ersten 16 Hex-Zeichen von HMAC-SHA256(`TV7_HMAC_SECRET`, payload). Die
  Haupt-API erzeugt ihn; beide Seiten brauchen denselben `TV7_HMAC_SECRET`.
  Seit 17.11.2026 wird die Signatur zeitkonstant verglichen.
- `/health`.

Seit 17.11.2026 stürzt der Prozess bei einem ungültigen `Host`-Header nicht mehr
ab (feste Basis-URL beim Parsen, sonst 400).

## Ausrollen

Nicht über GitHub Actions – direkt in den Container, mit `deploy.sh` vom
Repo aus (setzt pve1 und CT 250 voraus):

```bash
cd tv7-streamer && ./deploy.sh
```

`deploy.sh`:

1. behält eine vorhandene `/etc/default/tv7-streamer`; fehlt sie, schreibt es
   eine neue mit `TV7_HMAC_SECRET` aus der Umgebungsvariable oder einem neuen
   Zufallswert. **Achtung:** Im zweiten Fall gibt das Skript den neuen Wert im
   Terminal aus, damit er in die Haupt-API übernommen werden kann – Terminal-
   Protokoll danach nicht aufbewahren und den Wert nur in
   `/opt/rosenweg-core/.env` (CT 128) eintragen.
2. legt den Systembenutzer `tv7` an, falls er fehlt (die Unit setzt `User=tv7`;
   ohne Benutzer startet der Dienst nicht),
3. kopiert `server.js` und die Unit, `daemon-reload`, `enable --now`, Neustart,
   und ruft `http://localhost:3000/health` ab.

Die Unit verzichtet bewusst auf `DynamicUser`, `ProtectSystem`, `PrivateTmp` usw.:
Diese brauchen Mount-Namespaces, die im unprivilegierten CT 250 ohne `nesting`
mit `226/NAMESPACE` scheitern. Gesetzt sind `NoNewPrivileges=yes` und ein leeres
`CapabilityBoundingSet`.

Von Hand (nur `server.js`):

```bash
ssh root@100.64.2.20 'pct push 250 /tmp/server.js /opt/tv7-streamer/server.js
  pct exec 250 -- node --check /opt/tv7-streamer/server.js
  pct exec 250 -- systemctl restart tv7-streamer'
```

## Prüfen

```bash
ssh root@100.64.2.20 'pct exec 250 -- sh -c "systemctl is-active tv7-streamer; ps -o user= -C node; curl -s localhost:3000/health"'
# erwartet: active / tv7 / {"ok":true,"sessions":N}
```

Danach in `tv.html` (isp.rosenweg4303.ch) einen Sender abspielen.

## Zurückbauen

`/opt/tv7-streamer/server.js.vor-sicherheit-2026-11-17` und die alte Unit
`/etc/systemd/system/tv7-streamer.service.vor-sicherheit-2026-11-17`
zurückkopieren, `systemctl daemon-reload && systemctl restart tv7-streamer`.
Der Dienst läuft dann wieder als root.
