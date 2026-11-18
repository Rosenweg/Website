#!/usr/bin/env bash
# Deploy tv7-streamer in LXC 250 auf pve1 (100.64.2.20).
# Usage: ./deploy.sh
set -euo pipefail

PVE=root@100.64.2.20
CT=250
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

# Secret bestimmen: existierendes /etc/default/tv7-streamer im CT behalten,
# sonst aus $TV7_HMAC_SECRET (env) oder neu erzeugen.
# Das Geheimnis wird weder ausgegeben noch als Befehlszeile uebergeben
# (Terminal-/CI-Log, ps auf dem PVE-Knoten): nur Existenz pruefen, Inhalt per stdin.
if ssh "$PVE" "pct exec $CT -- test -s /etc/default/tv7-streamer" 2>/dev/null; then
  echo "[deploy] /etc/default/tv7-streamer existiert — behalten"
else
  SECRET="${TV7_HMAC_SECRET:-$(openssl rand -hex 32)}"
  echo "[deploy] schreibe /etc/default/tv7-streamer mit neuem Secret"
  printf 'TV7_HMAC_SECRET=%s\nPORT=3000\n' "$SECRET" \
    | ssh "$PVE" "pct exec $CT -- bash -c 'umask 077; cat > /etc/default/tv7-streamer; chmod 600 /etc/default/tv7-streamer'"
  unset SECRET
  echo "[deploy] >>> denselben TV7_HMAC_SECRET im rosenweg_api als env-var setzen. Wert lesen mit:"
  echo "[deploy]     ssh $PVE 'pct exec $CT -- cat /etc/default/tv7-streamer'"
fi

# Stelle sicher dass /opt/tv7-streamer existiert
ssh "$PVE" "pct exec $CT -- mkdir -p /opt/tv7-streamer"
# Dienst-Benutzer (Unit: User=tv7; kein DynamicUser im CT ohne nesting, R2-Dh)
ssh "$PVE" "pct exec $CT -- bash -c 'id tv7 >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin tv7'"

# server.js + service-Unit pushen
scp "$SRC_DIR/server.js" "$PVE":/tmp/server.js
scp "$SRC_DIR/tv7-streamer.service" "$PVE":/tmp/tv7-streamer.service
ssh "$PVE" "pct push $CT /tmp/server.js /opt/tv7-streamer/server.js && \
            pct push $CT /tmp/tv7-streamer.service /etc/systemd/system/tv7-streamer.service && \
            pct exec $CT -- systemctl daemon-reload && \
            pct exec $CT -- systemctl enable --now tv7-streamer.service && \
            pct exec $CT -- systemctl restart tv7-streamer.service && \
            sleep 1 && \
            pct exec $CT -- systemctl is-active tv7-streamer.service && \
            pct exec $CT -- curl -s --max-time 3 http://localhost:3000/health"

echo "[deploy] done."
