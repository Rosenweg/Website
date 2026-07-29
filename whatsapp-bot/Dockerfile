FROM node:22-bookworm-slim

# 1) ca-certificates + Basis-Libs/Tools aus dem STANDARD-Repo. ca-certificates MUSS
#    zuerst da sein, sonst scheitert unten HTTPS zu snapshot.debian.org (das Basis-Image
#    hat keine Certs; die Default-Repos gehen ueber HTTP und brauchen keine).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates dumb-init wget \
    fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 \
    libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# 2) Chromium fuer whatsapp-web.js / puppeteer — auf 149 GEPINNT.
#    WICHTIG: Chromium 150 (bookworm) crasht in unserem LXC beim Start (SIGTRAP, rc=133);
#    149 laeuft sauber. Das aktuelle bookworm-security-Repo fuehrt nur noch 150 -> darum
#    aus snapshot.debian.org (debian-security, Stand nach first_seen 2026-06-26) ziehen
#    + apt-mark hold, damit kein spaeteres update sie wieder auf 150 anhebt.
#    Die Lib-Abhaengigkeiten kommen aus dem Standard-Repo (Schritt 1, forward-kompatibel).
ARG CHROMIUM_VERSION=149.0.7827.196-1~deb12u1
ARG DEB_SNAPSHOT=20260628T000000Z
RUN printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' "$DEB_SNAPSHOT" > /etc/apt/sources.list.d/snapshot-chromium.list \
  && apt-get -o Acquire::Check-Valid-Until=false update \
  && apt-get install -y --no-install-recommends \
    chromium=${CHROMIUM_VERSION} chromium-common=${CHROMIUM_VERSION} \
  && apt-mark hold chromium chromium-common \
  && rm -f /etc/apt/sources.list.d/snapshot-chromium.list \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app
# Build-Context ist das Repo-Root (siehe .github/workflows/deploy.yml) damit das
# geteilte js/ + die Web-UI mitkopiert werden koennen.
COPY whatsapp-bot/package.json ./
# python3/make/g++ nur falls better-sqlite3 kein prebuilt-Binary hat.
# git: für die whatsapp-web.js-GitHub-Dependency (Fix-Branch PR #201850, bis upstream released).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git \
  && npm install --omit=dev \
  && apt-get purge -y python3 make g++ git && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY whatsapp-bot/index.js whatsapp-bot/gateway.js ./
# Gateway-Web-UI (statisch, wird von gateway.js via express.static('public') serviert).
COPY whatsapp-bot/public ./public

# Session-Verzeichnis (Volume-Mount empfohlen)
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "index.js"]
