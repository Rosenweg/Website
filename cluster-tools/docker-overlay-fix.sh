#!/bin/bash
# v3: Orphan-FDB-Eintraege (master br0 ohne dst) im Overlay automatisch heilen,
# indem wir die fehlende VXLAN-Tunneling-Regel via Swarm-Cluster-Lookup
# nachtragen statt sie nur zu loeschen. Wenn der MAC zu keinem bekannten
# Container gehoert, loeschen wir ihn (echter Orphan).
#
# Run-context: jedes docker-CT 201/202/203 hat einen Swarm-Manager und sieht
# damit alle Tasks + Nodes im Cluster.

set -uo pipefail

# 1) ip_forward in allen netns
count=0; fixed=0
for ns in /var/run/docker/netns/* /var/run/docker/netns/ingress_sbox; do
  [ -e "$ns" ] || continue
  count=$((count+1))
  val=$(nsenter --net="$ns" sysctl -n net.ipv4.ip_forward 2>/dev/null || echo "")
  if [ "$val" != "1" ]; then
    nsenter --net="$ns" sysctl -wq net.ipv4.ip_forward=1 2>/dev/null && fixed=$((fixed+1)) || true
  fi
done
echo "[$(date -Iseconds)] docker-overlay-fix v3: ip_forward fixed in $fixed/$count namespaces"

# 2) NodeID -> Mgmt-IP-Map
declare -A NODE_IP
while read -r id; do
  [ -z "$id" ] && continue
  addr=$(docker node inspect "$id" --format '{{.Status.Addr}}' 2>/dev/null)
  if [ -z "$addr" ] || [ "$addr" = "0.0.0.0" ]; then
    addr=$(docker node inspect "$id" --format '{{.ManagerStatus.Addr}}' 2>/dev/null | cut -d: -f1)
  fi
  [ -n "$addr" ] && [ "$addr" != "0.0.0.0" ] && NODE_IP[$id]="$addr"
done < <(docker node ls -q 2>/dev/null)

# 3) IP -> MAC: 10.0.x.y -> 02:42:0a:00:0x:0y (Docker-Overlay-Schema)
ip_to_mac() {
  local ip=$1
  awk -v ip="$ip" 'BEGIN {
    split(ip, a, ".");
    printf "02:42:%02x:%02x:%02x:%02x\n", a[1], a[2], a[3], a[4];
  }'
}

# 4) MAC -> Node-IP-Map aus laufenden Service-Tasks aufbauen
declare -A MAC_TO_NODEIP
for svc in $(docker service ls -q 2>/dev/null); do
  for task in $(docker service ps "$svc" --filter desired-state=running -q 2>/dev/null); do
    nodeid=$(docker inspect "$task" --format '{{.NodeID}}' 2>/dev/null) || continue
    nodeip=${NODE_IP[$nodeid]:-}
    [ -z "$nodeip" ] && continue
    while read -r ipcidr; do
      [ -z "$ipcidr" ] && continue
      ip=${ipcidr%/*}
      mac=$(ip_to_mac "$ip")
      MAC_TO_NODEIP[$mac]=$nodeip
    done < <(docker inspect "$task" --format '{{range .NetworksAttachments}}{{range .Addresses}}{{.}}{{"\n"}}{{end}}{{end}}' 2>/dev/null)
  done
done
echo "[$(date -Iseconds)] docker-overlay-fix v3: cluster mac-map has ${#MAC_TO_NODEIP[@]} entries"

# 5) Orphan-Heilung pro overlay netns
healed=0; deleted=0
for ns in /var/run/docker/netns/1-*; do
  [ -e "$ns" ] || continue
  orphans=$(nsenter --net="$ns" bridge fdb show dev vxlan0 2>/dev/null | awk '
    /master br0 *$/ { mb[$1]=1 }
    $3 == "dst" && $4 != "0.0.0.0" { ds[$1]=1 }
    END { for (m in mb) if (!ds[m]) print m }
  ')
  for mac in $orphans; do
    nodeip=${MAC_TO_NODEIP[$mac]:-}
    if [ -n "$nodeip" ] && [ "$nodeip" != "0.0.0.0" ]; then
      if nsenter --net="$ns" bridge fdb append "$mac" dst "$nodeip" dev vxlan0 self permanent 2>/dev/null; then
        healed=$((healed+1))
        echo "[$(date -Iseconds)] docker-overlay-fix v3: HEALED $mac -> $nodeip in $(basename "$ns")"
      fi
    else
      if nsenter --net="$ns" bridge fdb del "$mac" dev vxlan0 2>/dev/null; then
        deleted=$((deleted+1))
        echo "[$(date -Iseconds)] docker-overlay-fix v3: DELETED unknown $mac in $(basename "$ns")"
      fi
    fi
  done
done
echo "[$(date -Iseconds)] docker-overlay-fix v3: $healed healed, $deleted deleted (truly orphaned)"
