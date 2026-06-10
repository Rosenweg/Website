FROM node:22-bookworm-slim

# Chromium fuer whatsapp-web.js / puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 \
    libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
    ca-certificates dumb-init wget \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./

# Session-Verzeichnis (Volume-Mount empfohlen)
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "index.js"]
