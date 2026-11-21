# Stufe 1: Docroot aus dem Repo zusammenstellen (Positivliste).
FROM alpine:3.20 AS webroot
RUN apk add --no-cache rsync
COPY . /src
# rsync: die erste passende Regel gewinnt — Ausschluesse daher zuerst.
RUN rsync -a \
      --exclude='/isp.html' --exclude='/isp-admin.html' --exclude='/isp-mein-zugang.html' \
      --exclude='/wlan.html' --exclude='/tv.html' --exclude='/netzwerk.html' \
      --exclude='/verbindungen.html' --exclude='/dmarc.html' --exclude='/pbx-admin.html' \
      --exclude='/js/nav-isp.js' \
      --include='/css/***' --include='/img/***' --include='/js/***' --include='/door-signs/' --include='/door-signs/*.html' \
      --include='/*.html' --include='/*.png' --include='/*.pdf' --include='/*.webmanifest' \
      --include='/*-sw.js' --include='/CNAME' \
      --include='/site-config.json' --include='/zaehler-config.json' --include='/access-manifest.json' \
      --exclude='*' \
      /src/ /out/

FROM nginx:1.27-alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Gemeinsame Sicherheits-Header (per include in nginx.conf)
COPY frontends-lxc/nginx/sicherheit-header.conf /etc/nginx/snippets/rosenweg-sicherheit.conf

# Website-Dateien per Positivliste (wie assemble_website in frontends-lxc/deploy.sh).
# Frueher "COPY . " plus Sperrliste: jede neue Repo-Datei (Schluessel-Exporte,
# docs/, Installer …) landete ungefragt im oeffentlichen Docroot.
COPY --from=webroot /out/ /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/health || exit 1
