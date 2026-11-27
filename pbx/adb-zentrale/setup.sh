#!/bin/bash
# Richtet adb-zentrale auf einem frischen Debian-13-CT ein (als root IM Container).
#   ./setup.sh <pfad/zu/adb-zentrale-linux-amd64>
# Bauen auf dem Mac: (cd pbx/adb-zentrale && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
#   go build -trimpath -ldflags "-s -w" -o build/adb-zentrale-linux-amd64 .)
#
# Legt beim ersten Mal an: Benutzer adb-zentrale (Dienst) und adbz (adb-Schluessel,
# rw-adb), /etc/adb-zentrale/env mit Zufalls-Tokens, rw-adb.env, sudoers fuer rw-adb,
# den adb-Schluessel der Zentrale. Ein zweiter Lauf ersetzt nur Programm und Skripte.
# Startet den Dienst erst, wenn ZW_STEUER_BIND und ZW_ANLAGE_URL eingetragen sind.
set -euo pipefail
bin="${1:?Pfad zum Programm fehlt}"
hier="$(cd "$(dirname "$0")" && pwd)"

# adb und Werkzeuge von rw-adb (jq, curl, column aus bsdextrautils)
fehlt=""
for p in adb jq curl sudo bsdextrautils nftables; do dpkg -s "$p" >/dev/null 2>&1 || fehlt="$fehlt $p"; done
if [ -n "$fehlt" ]; then
    apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q $fehlt
fi

id adb-zentrale >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin adb-zentrale
id adbz >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/adbz --shell /usr/sbin/nologin adbz
chmod 0700 /var/lib/adbz

install -d -m 0755 /opt/adb-zentrale
install -m 0755 "$bin" /opt/adb-zentrale/adb-zentrale.neu
mv /opt/adb-zentrale/adb-zentrale.neu /opt/adb-zentrale/adb-zentrale
install -m 0755 "$hier/rw-adb-intern" /opt/adb-zentrale/rw-adb-intern
install -m 0755 "$hier/rw-adb" /usr/local/bin/rw-adb
# Einrichtungsskript der Telefone, fuer "rw-adb <ext> einrichten"
if [ -f "$hier/../../scripts/geteiltes-telefon-einrichten.sh" ]; then
    install -m 0755 "$hier/../../scripts/geteiltes-telefon-einrichten.sh" /opt/adb-zentrale/geteiltes-telefon-einrichten.sh
fi
install -m 0644 "$hier/adb-zentrale.service" /etc/systemd/system/adb-zentrale.service

# 0751: adbz erreicht rw-adb.env, lesen kann es env trotzdem nicht
install -d -m 0751 -o root -g adb-zentrale /etc/adb-zentrale
if [ ! -f /etc/adb-zentrale/env ]; then
    umask 077
    zufall() { head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 48; }
    lokal=$(zufall)
    cat > /etc/adb-zentrale/env <<EOT
# adb-zentrale - siehe pbx/adb-zentrale/README.md. Geheim: ZW_STEUER_TOKEN, ZW_LOKAL_TOKEN.
ZW_WG_PORT=51832
ZW_NETZ=10.243.44.0/24
ZW_ENDPOINT_EXTERN=adb.rosenweg4303.ch:51832
# LAN-Adresse dieses CT mit Port 51832 (Telefone im Haus nehmen sie direkt):
ZW_ENDPOINT_INTERN=
# LAN-Adresse dieses CT mit Port 8080 (nicht 0.0.0.0):
ZW_STEUER_BIND=
# gleich PBX_ADB_ZENTRALE_TOKEN in /etc/default/pbx-api auf CT 220:
ZW_STEUER_TOKEN=$(zufall)
ZW_LOKAL_TOKEN=$lokal
# pbx-api auf CT 220, z. B. http://<adresse>:8095
ZW_ANLAGE_URL=
ZW_LEERLAUF=30m
ZW_SITZUNG_BASIS=20000
EOT
    chgrp adb-zentrale /etc/adb-zentrale/env
    chmod 0640 /etc/adb-zentrale/env
    # rw-adb (als adbz) kennt nur den Lokal-Token: Sitzungen und Zustand, keine Peers
    cat > /etc/adb-zentrale/rw-adb.env <<EOT
ZW_URL=http://STEUER_BIND_EINTRAGEN
ZW_LOKAL_TOKEN=$lokal
ZW_SITZUNG_BASIS=20000
EOT
    chown root:adbz /etc/adb-zentrale/rw-adb.env
    chmod 0640 /etc/adb-zentrale/rw-adb.env
    echo "Neu: /etc/adb-zentrale/env - ZW_ENDPOINT_INTERN, ZW_STEUER_BIND, ZW_ANLAGE_URL eintragen,"
    echo "     in rw-adb.env ZW_URL=http://<ZW_STEUER_BIND>, dann: systemctl enable --now adb-zentrale"
fi

# sudo: jedes Konto aus der SSH-Zugriffsmatrix (Gruppe rw-verwaltet, auf diesem Host nur
# Technik) darf rw-adb-intern als adbz aufrufen - sonst nichts als adbz.
cat > /etc/sudoers.d/rw-adb <<'EOT'
# rw-adb: adb ueber den Fernwartungs-Tunnel (pbx/adb-zentrale). SUDO_USER = Person im Protokoll.
Defaults!/opt/adb-zentrale/rw-adb-intern env_reset, !setenv
%rw-verwaltet ALL=(adbz) NOPASSWD: /opt/adb-zentrale/rw-adb-intern, /opt/adb-zentrale/rw-adb-intern *
EOT
chmod 0440 /etc/sudoers.d/rw-adb
visudo -cf /etc/sudoers.d/rw-adb >/dev/null

# adb-Schluessel der Zentrale (entsteht beim ersten Start des adb-Servers von adbz).
# Der oeffentliche Teil geht an den Dienst (Fingerabdruck fuer /smartphones).
if [ ! -f /var/lib/adbz/.android/adbkey.pub ]; then
    sudo -u adbz env HOME=/var/lib/adbz ANDROID_USER_HOME=/var/lib/adbz/.android ANDROID_ADB_SERVER_PORT=5038 \
        adb start-server >/dev/null 2>&1 || true
    sudo -u adbz env HOME=/var/lib/adbz ANDROID_ADB_SERVER_PORT=5038 adb kill-server >/dev/null 2>&1 || true
fi
chmod 0700 /var/lib/adbz/.android 2>/dev/null || true
if [ -f /var/lib/adbz/.android/adbkey.pub ]; then
    install -m 0644 /var/lib/adbz/.android/adbkey.pub /etc/adb-zentrale/adbkey.pub
    echo "adb-Schluessel der Zentrale: $(awk '{print $1}' /etc/adb-zentrale/adbkey.pub | base64 -d | md5sum | awk '{print toupper($1)}' | sed 's/../&:/g; s/:$//')"
fi

# Firewall: Adressen des Hauses getrennt (oeffentliches Repo)
if [ ! -f /etc/adb-zentrale/nft-adressen.conf ]; then
    install -m 0644 "$hier/nft-adressen.beispiel.conf" /etc/adb-zentrale/nft-adressen.conf
    echo "Neu: /etc/adb-zentrale/nft-adressen.conf - echte Adressen eintragen, dann:"
    echo "     install -m 0644 $hier/nftables.conf /etc/nftables.conf && nft -c -f /etc/nftables.conf && systemctl enable --now nftables"
fi

systemctl daemon-reload
if systemctl is-enabled --quiet adb-zentrale 2>/dev/null; then systemctl restart adb-zentrale; fi
echo fertig
