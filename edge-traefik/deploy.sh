#!/usr/bin/env bash
# Deploy Edge-Traefik config into LXC 245.
# Usage: ./deploy.sh
set -euo pipefail

# CT 245 laeuft auf pve3 (100.64.2.22); pct wirkt nur auf dem Knoten, der den
# Container hat. Ueberschreibbar per PVE=root@<knoten> ./deploy.sh
PVE="${PVE:-root@100.64.2.22}"
CT=245
SRC="$(cd "$(dirname "$0")" && pwd)"

# Vorab pruefen, ob der CT wirklich auf diesem Knoten liegt (z. B. nach
# HA-Migration). Sonst abbrechen und den richtigen Knoten nennen, statt
# halb zu deployen.
if ! ssh "$PVE" "pct status $CT" >/dev/null 2>&1; then
  KNOTEN=$(ssh "$PVE" "pvesh get /cluster/resources --type vm --output-format json" 2>/dev/null \
    | python3 -c 'import json,sys; print(next((r.get("node","") for r in json.load(sys.stdin) if r.get("vmid")=='"$CT"'), ""))' 2>/dev/null || true)
  echo "[deploy] FEHLER: CT $CT nicht auf $PVE.${KNOTEN:+ Laut Cluster auf Knoten: $KNOTEN.}" >&2
  echo "  Aufruf mit passendem Knoten: PVE=root@<ip-von-${KNOTEN:-knoten}> $0" >&2
  exit 1
fi

echo "[deploy] /etc/traefik prep"
ssh "$PVE" "pct exec $CT -- bash -c '
  mkdir -p /etc/traefik/dynamic /var/lib/traefik /var/log/traefik
  touch /var/lib/traefik/acme.json
  chmod 600 /var/lib/traefik/acme.json
'"

echo "[deploy] push files"
for f in traefik.yml traefik.service dynamic-static.yml traefik-sync.sh traefik-sync.service traefik-sync.timer; do
  scp -q "$SRC/$f" "$PVE":/tmp/"$f"
done

ssh "$PVE" "
  pct push $CT /tmp/traefik.yml /etc/traefik/traefik.yml
  pct push $CT /tmp/dynamic-static.yml /etc/traefik/dynamic/static.yml
  pct push $CT /tmp/traefik.service /etc/systemd/system/traefik.service
  pct push $CT /tmp/traefik-sync.sh /usr/local/sbin/traefik-sync.sh
  pct push $CT /tmp/traefik-sync.service /etc/systemd/system/traefik-sync.service
  pct push $CT /tmp/traefik-sync.timer /etc/systemd/system/traefik-sync.timer
  pct exec $CT -- chmod +x /usr/local/sbin/traefik-sync.sh
  pct exec $CT -- systemctl daemon-reload
  pct exec $CT -- systemctl enable --now traefik-sync.timer
  pct exec $CT -- systemctl start traefik-sync.service
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
