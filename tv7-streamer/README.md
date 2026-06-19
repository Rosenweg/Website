# TV7-Streamer (LXC 250 / CT 250, `100.64.9.250`, RK-Clients-VLAN)

Stand-alone Node-Proxy fuer Init7-TV. Liefert alle 242 Sender an Browser
(mpegts.js) und native Player.

## Quellen pro Kanal
- **Multicast** `udp://@233.50.230.x:5000` (alle 242, lokal auf RK-Clients;
  Codecs HEVC/H.264/mpeg2).
- **HTTP-HLS** `api.tv.init7.net` (nur ~101 mit channel-id, immer H.264).

## Browser-Auslieferung
- `?codec=hevc` (HEVC-faehiger Browser): Multicast-Quelle, Video COPY, mpeg2->H.264.
- sonst: H.264-Quelle (HTTP wo vorhanden, sonst Multicast); HEVC/mpeg2 -> H.264
  (max 720p). Audio AC-3/MP2 -> AAC.

## Endpoints
- `/channels` — JSON (242, mit `mcast`/`httpId`/`hevc`/`h264`).
- `/playlist.m3u` — alle 242 als udpxy-URLs (cross-VLAN). **Hinweis:** Browser
  laden die M3U ueber `/api/tv/playlist.m3u` (API), weil die ISP-nginx den
  Streamer nicht erreicht.
- `/stream/<id>?token=...[&codec=hevc]` — MPEG-TS (HMAC-Token vom rosenweg_api).

## Deploy (NICHT via GHA — laeuft direkt im CT)
```
pct push 250 server.js /opt/tv7-streamer/server.js
pct exec 250 -- node --check /opt/tv7-streamer/server.js
pct exec 250 -- systemctl restart tv7-streamer
```
Secret: `TV7_HMAC_SECRET` in `/etc/default/tv7-streamer` (gleich wie rosenweg_api).
udpxy laeuft auf CT 109 (`tv-proxy`, `100.64.9.200:4022`).
