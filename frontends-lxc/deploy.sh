#!/usr/bin/env bash
# De-Swarm Frontend-Deploy — läuft INNERHALB eines Frontend-LXC.
# Holt den aktuellen Repo-Stand, installiert die passende nginx-Config und baut
# den site-spezifischen docroot (entspricht der jeweiligen Dockerfile-Logik).
#
# Steady-state-Deploy:  ssh root@<lxc>  '/opt/rosenweg/repo/frontends-lxc/deploy.sh'
# Config je LXC in /etc/rosenweg-frontend.conf:  SITE=meg  TYPE=stweg
set -euo pipefail

REPO=/opt/rosenweg/repo
WEBROOT=/var/www/rosenweg
CONF=/etc/rosenweg-frontend.conf
SRC="$REPO/frontends-lxc"

[ -f "$CONF" ] || { echo "FEHLER: $CONF fehlt (SITE/TYPE)"; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
: "${SITE:?SITE nicht gesetzt}" "${TYPE:?TYPE nicht gesetzt}"

echo "[deploy] SITE=$SITE TYPE=$TYPE"

# 1) Repo aktualisieren (falls schon geklont — provision.sh klont initial)
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" fetch --depth 1 origin main
  git -C "$REPO" reset --hard origin/main
fi

# 2) nginx-Config installieren (idempotent)
install -D -m644 "$SRC/nginx/upstreams.conf" /etc/nginx/conf.d/00-upstreams.conf
install -D -m644 "$SRC/nginx/$TYPE.conf"     /etc/nginx/sites-available/rosenweg.conf
ln -sf /etc/nginx/sites-available/rosenweg.conf /etc/nginx/sites-enabled/rosenweg.conf
rm -f /etc/nginx/sites-enabled/default

# 3) docroot in temp bauen, dann atomar nach $WEBROOT spiegeln
build="$(mktemp -d /var/www/.rosenweg-build.XXXXXX)"
trap 'rm -rf "$build"' EXIT
cd "$REPO"

assemble_website() {
  # Positivliste: nur Web-Inhalt. Die fruehere Sperrliste veraltete mit jedem neuen
  # Repo-Ordner (docs/, JOURNAL.md, mailcow/, backend-lxc/ … waeren oeffentlich
  # geworden — wie am 5.9.2026). Stand fe-www 25.10.2026: css/ img/ js/ und im
  # Wurzelverzeichnis HTML, PNG, PDF, Manifeste, Service-Worker, drei JSON.
  # rsync: die erste passende Regel gewinnt — Ausschluesse daher zuerst.
  rsync -a \
    --exclude='/isp.html' --exclude='/isp-admin.html' --exclude='/isp-mein-zugang.html' \
    --exclude='/wlan.html' --exclude='/tv.html' --exclude='/netzwerk.html' \
    --exclude='/verbindungen.html' --exclude='/dmarc.html' --exclude='/pbx-admin.html' \
    --exclude='/js/nav-isp.js' \
    --include='/css/***' --include='/img/***' --include='/js/***' \
    --include='/*.html' --include='/*.png' --include='/*.pdf' --include='/*.webmanifest' \
    --include='/*-sw.js' --include='/CNAME' \
    --include='/site-config.json' --include='/zaehler-config.json' --include='/access-manifest.json' \
    --exclude='*' \
    ./ "$build/"
}

assemble_isp() {
  # Entspricht Dockerfile.isp (Whitelist).
  mkdir -p "$build/js"
  cp isp.html isp-admin.html isp-mein-zugang.html wlan.html tv.html \
     netzwerk.html verbindungen.html dmarc.html noc-fullscreen.html \
     logo-rosenweg.png logo-rosenweg-isp.png site-config.json "$build/"
  rsync -a js/ "$build/js/"
  # ISP-only-Nav überlagert die große Hauptseiten-Nav
  cp "$build/js/nav-isp.js" "$build/js/nav.js"
  rm -f "$build/js/nav-isp.js"
  ln -sf isp.html "$build/index.html"
}

assemble_stweg() {
  # Entspricht Dockerfile.stweg. Alle STWEG/MEG-Dirs + Shared; $site-Map wählt zur Laufzeit.
  rsync -a stweg1 stweg2 stweg3 stweg4 stweg5 stweg6 stweg7 meg js css "$build/"
  cp site-config.json logo-rosenweg.png logo-stweg3-rosenweg9.png logo-stweg6-rosenweg1.png "$build/"
  cp waschkueche.html "$build/_waschkueche.html"
  cp steuerung.html "$build/steuerung.html"
}

assemble_pwa() {
  # PWA-Subdomain: pwa/-Inhalt = Docroot (Übersicht /index.html + /reparatur/ + /icons/),
  # plus shared js/ (Apps brauchen authentik-auth.js) + Logo/site-config.
  rsync -a pwa/ "$build/"
  mkdir -p "$build/js"
  rsync -a js/ "$build/js/"
  cp logo-rosenweg.png site-config.json "$build/" 2>/dev/null || true
}

case "$TYPE" in
  website) assemble_website ;;
  isp)     assemble_isp ;;
  stweg)   assemble_stweg ;;
  pwa)     assemble_pwa ;;
  *) echo "FEHLER: unbekannter TYPE=$TYPE"; exit 1 ;;
esac

mkdir -p "$WEBROOT"
# .alt = Sicherungen von scripts/rw-web-ausrollen.sh — nicht mitloeschen
rsync -a --delete --filter='P *.alt' "$build/" "$WEBROOT/"
chown -R www-data:www-data "$WEBROOT"

# 4) Config testen + reload
nginx -t
systemctl reload nginx 2>/dev/null || nginx -s reload
echo "[deploy] OK — $SITE ($TYPE) deployed, nginx reloaded"
