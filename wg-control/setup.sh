#!/bin/bash
# wg-control Setup on the VPN-LXC. Idempotent.
set -euo pipefail

# 1. IP forwarding
cat > /etc/sysctl.d/99-wg-forward.conf <<EOF
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
EOF
sysctl -p /etc/sysctl.d/99-wg-forward.conf

# 2. Directory structure
mkdir -p /opt/wg-control /etc/wg-control /var/lib/wg-control /etc/wireguard
chmod 700 /etc/wg-control /var/lib/wg-control /etc/wireguard

# 3. Env: generate token if not present
if [ ! -f /etc/wg-control/env ]; then
  TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '+/=')
  cat > /etc/wg-control/env <<EOF
WG_CONTROL_TOKEN=${TOKEN}
WG_CONTROL_PORT=3001
WG_LISTEN_PORT=51830
WG_ENDPOINT_HOST=kooperation.rosenweg4303.ch
WG_CLIENT_DNS=100.64.2.1
EOF
  chmod 600 /etc/wg-control/env
fi

# 4. systemd unit
cp -f wg-control.service /etc/systemd/system/wg-control.service
systemctl daemon-reload
systemctl enable wg-control.service
systemctl restart wg-control.service

sleep 2
systemctl --no-pager --full status wg-control.service | head -20

echo
echo "=== Bearer Token (for rosenweg-api /opt/rosenweg-website/.env) ==="
grep ^WG_CONTROL_TOKEN /etc/wg-control/env
echo
echo "=== Health check ==="
curl -fsS http://localhost:3001/health || true
echo
echo "=== WG interface ==="
wg show wg0 2>&1 || echo wg0_not_up
