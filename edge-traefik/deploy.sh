#!/usr/bin/env bash
# Deploy Edge-Traefik config into LXC 245.
# Usage: ./deploy.sh
set -euo pipefail

PVE=root@100.64.2.20
CT=245
SRC="$(cd "$(dirname "$0")" && pwd)"

echo "[deploy] /etc/traefik prep"
ssh "$PVE" "pct exec $CT -- bash -c '
  mkdir -p /etc/traefik/dynamic /var/lib/traefik /var/log/traefik
  touch /var/lib/traefik/acme.json
  chmod 600 /var/lib/traefik/acme.json
'"

echo "[deploy] push files"
for f in traefik.yml traefik.service dynamic-static.yml; do
  scp -q "$SRC/$f" "$PVE":/tmp/"$f"
done

ssh "$PVE" "
  pct push $CT /tmp/traefik.yml /etc/traefik/traefik.yml
  pct push $CT /tmp/dynamic-static.yml /etc/traefik/dynamic/static.yml
  pct push $CT /tmp/traefik.service /etc/systemd/system/traefik.service
  pct exec $CT -- systemctl daemon-reload
"

# Check if CF token configured
TOKEN_OK=$(ssh "$PVE" "pct exec $CT -- bash -c 'grep -c ^CF_DNS_API_TOKEN= /etc/default/traefik 2>/dev/null || true'" 2>/dev/null || echo 0)
if [ "$TOKEN_OK" = "1" ]; then
  echo "[deploy] CF_DNS_API_TOKEN found in /etc/default/traefik — starting Traefik"
  ssh "$PVE" "pct exec $CT -- systemctl enable --now traefik.service && sleep 3 && pct exec $CT -- systemctl is-active traefik && pct exec $CT -- curl -sS http://localhost:80/ping"
else
  echo "[deploy] WARNING: /etc/default/traefik fehlt oder kein CF_DNS_API_TOKEN."
  echo "  Setze ihn manuell:"
  echo "    ssh $PVE 'pct exec $CT -- bash -c \"echo CF_DNS_API_TOKEN=YOUR_TOKEN > /etc/default/traefik && chmod 600 /etc/default/traefik\"'"
  echo "  Danach: ssh $PVE 'pct exec $CT -- systemctl enable --now traefik.service'"
fi

echo "[deploy] done."
