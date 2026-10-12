FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 PI_AUTH_DIR=/data/pi PI_AUTH_PATH=/data/pi/auth.json TELEGRAM_SESSION_DIR=/data/telegram
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && mkdir -p /data/pi /data/telegram /app/tmp && chown -R node:node /data /app/tmp \
    && chmod 700 /data/pi /data/telegram /app/tmp
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY model-data ./model-data
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
