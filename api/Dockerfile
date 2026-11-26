FROM node:22-alpine

# poppler-utils -> pdftotext, fuer ZEV-Rechnungs-Parsing (Textlayer auslesen)
# openssl -> Client-Zertifikate fuers Stationsjournal signieren (routes/stations.js)
RUN apk add --no-cache poppler-utils openssl

WORKDIR /app

COPY api/package.json ./
RUN npm install --production

COPY api/server.js ./
# Aufgeteilte Module (inkrementeller Router-Split).
COPY api/lib/ ./lib/
COPY api/middleware/ ./middleware/
COPY api/routes/ ./routes/
# Druckvorlagen (Tuerschilder, Poster) – nur ueber /api/raum-qr/druck, nicht oeffentlich
COPY api/vorlagen/ ./vorlagen/
# Beispielmappe fuer die Verwaltung -> beim Start nach «Dokumente» (lib/ablage.js)
COPY docs/beispielmappe/Beispielmappe-Rosenweg.pdf ./ablage/
# MCP-Server fuer Agenten (mcp.rosenweg4303.ch), siehe docs/mcp.md
COPY api/mcp/ ./mcp/
# Dokumentation als MCP-Ressourcen (api/mcp/erweiterungen.js) – nur die
# geheimnisfreie Positivliste aus .dockerignore, keine Wildcard.
COPY docs/Home.md docs/README.md docs/verwaltung-anleitung.md docs/email.md \
     docs/energie.md docs/pwa-konzept.md docs/mqtt-display.md docs/aufwand-erfassung-konzept.md \
     docs/mcp.md docs/energie-api.md docs/datenbank.md docs/ssh-zugang.md \
     docs/netzwerk.md docs/routing.md docs/ip-zuordnung.md docs/systemuebersicht.md \
     docs/website.md docs/deswarm-plan.md docs/mqtt-authentik-login.md docs/technik-bot-konzept.md \
     docs/api.md docs/infrastruktur.md docs/active-directory.md docs/cloudflare.md docs/unifi.md \
     ./docs/
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
