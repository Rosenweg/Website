FROM node:22-alpine

# poppler-utils -> pdftotext, fuer ZEV-Rechnungs-Parsing (Textlayer auslesen)
RUN apk add --no-cache poppler-utils

WORKDIR /app

COPY api/package.json ./
RUN npm install --production

COPY api/server.js ./
# Aufgeteilte Module (inkrementeller Router-Split).
COPY api/lib/ ./lib/
COPY api/middleware/ ./middleware/
COPY api/routes/ ./routes/
COPY api/scripts/ ./scripts/
# site-config.json wird vom Auto-Seed gelesen (legacy Verwaltung -> DB)
COPY site-config.json ./
# nav.js ist die einzige Quelle der Seitenliste; die Stationen leiten
# daraus ihre Programme ab (lib/stationapps.js).
COPY js/nav.js ./nav.js

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
