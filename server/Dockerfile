# Castify backend — Node 20 on Alpine.
# better-sqlite3 needs a compiler on musl, so build tools are installed first.
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public

ENV PORT=3001 \
    DB_PATH=/app/data/castify.db

VOLUME ["/app/data"]
EXPOSE 3001

CMD ["node", "server.js"]
