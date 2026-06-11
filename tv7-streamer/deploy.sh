#!/usr/bin/env bash
# Deploy tv7-streamer in LXC 250 auf pve1 (100.64.2.20).
# Usage: ./deploy.sh
set -euo pipefail

PVE=root@100.64.2.20
CT=250
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

# Secret bestimmen: existierendes /etc/default/tv7-streamer im CT behalten,
# sonst aus $TV7_HMAC_SECRET (env) oder neu erzeugen.
EXISTING_SECRET=$(ssh "$PVE" "pct exec $CT -- bash -c 'test -f /etc/default/tv7-streamer && cat /etc/default/tv7-streamer' 2>/dev/null" || true)
if [ -n "$EXISTING_SECRET" ]; then
  echo "[deploy] /etc/default/tv7-streamer existiert — behalten"
else
  SECRET="${TV7_HMAC_SECRET:-$(openssl rand -hex 32)}"
  echo "[deploy] schreibe /etc/default/tv7-streamer mit neuem Secret"
  ssh "$PVE" "pct exec $CT -- bash -c 'cat > /etc/default/tv7-streamer << EOF
TV7_HMAC_SECRET=$SECRET
PORT=3000
EOF
chmod 600 /etc/default/tv7-streamer'"
  echo "[deploy] >>> setze TV7_HMAC_SECRET=$SECRET im rosenweg_api als env-var <<<"
fi

# Stelle sicher dass /opt/tv7-streamer existiert
ssh "$PVE" "pct exec $CT -- mkdir -p /opt/tv7-streamer"

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
