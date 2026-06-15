FROM node:22-alpine

WORKDIR /app

COPY api/package.json ./
RUN npm install --production

COPY api/server.js ./
# Aufgeteilte Module (inkrementeller Router-Split). routes/ wird ergaenzt
# sobald die erste Domaene rausgezogen ist.
COPY api/lib/ ./lib/
COPY api/middleware/ ./middleware/
COPY api/scripts/ ./scripts/
# site-config.json wird vom Auto-Seed gelesen (legacy Verwaltung -> DB)
COPY site-config.json ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
