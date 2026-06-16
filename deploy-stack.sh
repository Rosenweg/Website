#!/bin/bash
# Deploy-Wrapper fuer den Rosenweg-Stack.
# Sourcet /root/.env, damit ${VAR} (environment, Traefik-Command-Arg, CIFS-Volume)
# beim 'docker stack deploy' NICHT zu Leerstring wipen.
# Aufruf:  /root/deploy-stack.sh -c /pfad/docker-stack.yml rosenweg
set -euo pipefail
[ -f /root/.env ] || { echo "FEHLER: /root/.env fehlt"; exit 1; }
set -a; . /root/.env; set +a
echo "[deploy-stack] /root/.env gesourcet ($(grep -c '=' /root/.env) Vars), starte stack deploy ..."
exec docker stack deploy --with-registry-auth "$@"
