#!/bin/bash
# Legt den Dauertest-CT auf einem Proxmox-Knoten an (auf dem Knoten als root ausfuehren).
# So am 27.11.2026 auf pve2 angelegt: CT 149, 100.64.2.69.
# Rueckweg: pct stop 149 && pct destroy 149
#
# /dev/kvm: dev0 mit gid der Gruppe kvm IM CT (Debian 13: 993). Der Emulator braucht nur
# rw auf /dev/kvm, keine weiteren Rechte - darum unprivilegiert. Gleichwertig zur alten
# Schreibweise lxc.cgroup2.devices.allow: c 10:232 rwm + lxc.mount.entry, aber pct setzt
# Besitzer und Rechte selbst (keine Zuordnung von Host-Gruppen ins CT noetig).
set -euo pipefail
ID=${ID:-149}
IP=${IP:-100.64.2.69}
VORLAGE=${VORLAGE:-local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst}

ls -l /dev/kvm >/dev/null || { echo "kein /dev/kvm auf $(hostname)"; exit 1; }
if ping -c1 -W1 "$IP" >/dev/null 2>&1; then echo "$IP antwortet schon - belegt"; exit 1; fi
pvesh get /cluster/nextid --vmid "$ID" >/dev/null

pct create "$ID" "$VORLAGE" \
  --hostname android-dauertest --cores 4 --memory 8192 --swap 1024 \
  --rootfs local-lvm:32 \
  --net0 "name=eth0,bridge=vmbr2,gw=100.64.2.1,ip=$IP/24,type=veth" --nameserver 100.64.2.1 \
  --unprivileged 1 --features nesting=1 --onboot 0 \
  --tags "$IP;test" \
  --description "android-dauertest: Android-Emulator (KVM) fuer Dauertests der Rosenweg-Apps. Repo Rosenweg/Website noc/android-dauertest. Rueckweg: pct stop $ID && pct destroy $ID" \
  --dev0 /dev/kvm,gid=993,mode=0660
pct start "$ID"
echo "CT $ID laeuft. Weiter im CT: einrichten.sh (als root)."
