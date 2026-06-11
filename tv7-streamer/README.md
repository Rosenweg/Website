# tv7-streamer (LXC 250)

Standalone Streamer für Init7-Tellio-HLS. Eigener LXC weil das ffmpeg
Audio-Transcode (AC-3 → AAC) sonst den `rosenweg_api`-Container blockt.

## Komponenten

- **server.js** — Node.js HTTP-Server auf Port 3000
  - `GET /channels` → cached Init7-Playlist als JSON
  - `GET /stream/<channel-id>?token=…` → MPEG-TS-Stream, transcoded
  - `GET /health` → `{ok, sessions}`
- **tv7-streamer.service** — systemd-Unit
- **/etc/default/tv7-streamer** — Env (HMAC_SECRET, PORT)

## Fanout

Pro Channel **EIN** ffmpeg-Prozess, alle Zuschauer teilen sich das Output.
Wenn der letzte Client geht: 10 s Karenzzeit, dann `SIGTERM` an ffmpeg.

## Deploy / Update

`./deploy.sh` lädt server.js + service-Unit per `pct push` in CT 250 und
restartet den Service.
