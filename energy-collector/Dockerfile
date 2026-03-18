FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY collector.js ./

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "collector.js"]
