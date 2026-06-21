#!/usr/bin/env bash
# Pull dynamic Traefik config from the rosenweg_api, convert JSON → YAML
# (Traefik file-provider liest YAML zuverlaessiger als JSON), schreiben
# atomar nach /etc/traefik/dynamic/routes.yml.
# Triggered by traefik-sync.timer every 15 s.
set -uo pipefail

ENDPOINT="http://100.64.2.52:3000/api/traefik/dynamic"
HOST="isp.rosenweg4303.ch"
DEST="/etc/traefik/dynamic/routes.yml"
TMP_JSON="$(mktemp -t routes.json.XXXXXX)"
TMP_YML="$(mktemp -p /etc/traefik/dynamic .routes.yml.XXXXXX)"

# Shared-Secret: der Endpoint ist nicht mehr IP-gated, sondern verlangt den
# Header X-Traefik-Secret. Wert kommt aus /etc/default/traefik-sync
# (EnvironmentFile der Service-Unit). Ohne Secret -> API 403 -> wir behalten
# die vorherige Config.
TRAEFIK_CONFIG_SECRET="${TRAEFIK_CONFIG_SECRET:-}"

trap 'rm -f "$TMP_JSON" "$TMP_YML"' EXIT

HTTP_CODE=$(curl -sk --max-time 10 -o "$TMP_JSON" -w '%{http_code}' \
  -H "Host: $HOST" -H "X-Traefik-Secret: $TRAEFIK_CONFIG_SECRET" "$ENDPOINT" || true)

if [ "$HTTP_CODE" != "200" ]; then
  echo "[traefik-sync] HTTP $HTTP_CODE — keep previous config" >&2
  exit 1
fi

# JSON validieren + nach YAML konvertieren in einem Schritt.
if ! python3 -c "
import json, yaml, sys
d = json.load(open('$TMP_JSON'))
assert isinstance(d, dict), 'not an object'
assert 'http' in d or 'tcp' in d, 'missing http/tcp keys'
with open('$TMP_YML', 'w') as f:
    yaml.safe_dump(d, f, default_flow_style=False, sort_keys=True)
" 2>&1; then
  echo "[traefik-sync] response failed validation — keep previous" >&2
  exit 1
fi

# Atomic replace.
chmod 644 "$TMP_YML"
mv "$TMP_YML" "$DEST"
trap - EXIT
rm -f "$TMP_JSON"
echo "[traefik-sync] $(stat -c%s "$DEST") bytes written"
