FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src/ ./src/
ENV PORT=80
EXPOSE 80
CMD ["node", "src/index.js"]
