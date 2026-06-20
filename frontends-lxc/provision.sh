#!/usr/bin/env bash
# De-Swarm Frontend-LXC Provisioning — läuft auf einem PVE-Host (pct/ha-manager).
# Legt einen winzigen Debian-13-LXC für ein Frontend an, installiert native nginx,
# klont das Repo und macht den ersten Deploy. Disk auf Ceph (lxcs), HA-float.
#
#   Aufruf:  ./provision.sh <site>      # site: www isp stweg1..7 meg
#   Re-run sicher: bricht ab, wenn die CT-ID schon existiert.
#
# Voraussetzungen auf dem PVE-Host:
#   - Template local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst vorhanden
#   - Storage 'lxcs' (Ceph rbd) aktiv
# Repo privat? GIT_URL mit Token überschreiben:
#   GIT_URL='https://<token>@github.com/Rosenweg/Website.git' ./provision.sh meg
set -euo pipefail

SITE="${1:?Usage: provision.sh <site>  (www isp stweg1..7 meg)}"
GIT_URL="${GIT_URL:-https://github.com/Rosenweg/Website.git}"
TEMPLATE="${TEMPLATE:-local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst}"
STORAGE="${STORAGE:-lxcs}"

# site -> CT-ID  IP  TYPE  (siehe frontends-lxc/sites.tsv / README)
case "$SITE" in
  www)    CT=118; IP=100.64.2.41; TYPE=website ;;
  isp)    CT=119; IP=100.64.2.42; TYPE=isp ;;
  stweg1) CT=120; IP=100.64.2.43; TYPE=stweg ;;
  stweg2) CT=121; IP=100.64.2.44; TYPE=stweg ;;
  stweg3) CT=122; IP=100.64.2.45; TYPE=stweg ;;
  stweg4) CT=123; IP=100.64.2.46; TYPE=stweg ;;
  stweg5) CT=124; IP=100.64.2.47; TYPE=stweg ;;
  stweg6) CT=125; IP=100.64.2.48; TYPE=stweg ;;
  stweg7) CT=126; IP=100.64.2.49; TYPE=stweg ;;
  meg)    CT=127; IP=100.64.2.50; TYPE=stweg ;;
  *) echo "FEHLER: unbekannte site '$SITE'"; exit 1 ;;
esac

echo "[provision] site=$SITE CT=$CT IP=$IP TYPE=$TYPE"
if pct status "$CT" &>/dev/null; then
  echo "FEHLER: CT $CT existiert bereits — abbrechen."; exit 1
fi

# 1) LXC anlegen — unprivileged, kein nesting/apparmor (kein Docker), Ceph-Disk.
pct create "$CT" "$TEMPLATE" \
  --hostname "fe-$SITE" \
  --ostype debian \
  --cores 1 --memory 256 --swap 256 \
  --rootfs "$STORAGE:4" \
  --net0 "name=eth0,bridge=vmbr2,gw=100.64.2.1,ip=$IP/24,type=veth" \
  --nameserver 1.1.1.1 \
  --onboot 1 \
  --unprivileged 1 \
  --tags "$IP;frontend;deswarm"

pct start "$CT"

# 2) Auf Netzwerk warten
echo "[provision] warte auf Netz ..."
for i in $(seq 1 30); do
  pct exec "$CT" -- getent hosts github.com &>/dev/null && break
  sleep 2
done

# 3) Pakete + Repo
pct exec "$CT" -- bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq nginx git rsync ca-certificates"
pct exec "$CT" -- bash -c "mkdir -p /opt/rosenweg && (test -d /opt/rosenweg/repo/.git || git clone --depth 1 '$GIT_URL' /opt/rosenweg/repo)"

# 4) Site-Config + erster Deploy
pct exec "$CT" -- bash -c "printf 'SITE=%s\nTYPE=%s\n' '$SITE' '$TYPE' > /etc/rosenweg-frontend.conf"
pct exec "$CT" -- bash /opt/rosenweg/repo/frontends-lxc/deploy.sh
pct exec "$CT" -- systemctl enable --now nginx

# 5) Lokaler Smoke-Test (Host-Header der Site)
echo "[provision] Smoke-Test:"
case "$SITE" in
  www)    HOSTHDR=www.rosenweg4303.ch ;;
  isp)    HOSTHDR=isp.rosenweg4303.ch ;;
  meg)    HOSTHDR=meg.rosenweg4303.ch ;;
  stweg*) HOSTHDR="$SITE.rosenweg4303.ch" ;;
esac
pct exec "$CT" -- bash -c "curl -s -o /dev/null -w 'health=%{http_code}\n' http://localhost/health; curl -s -o /dev/null -w 'index(%s)=%%{http_code}\n' -H 'Host: $HOSTHDR' http://localhost/ | sed 's/%s/$HOSTHDR/'"

# 6) HA-float (ohne Node-Pin)
ha-manager add "ct:$CT" 2>/dev/null || true

echo "[provision] FERTIG — CT $CT ($SITE) auf $IP. Cutover-Route in edge-traefik separat (siehe README)."
