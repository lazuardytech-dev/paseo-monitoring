# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
ENV NODE_ENV=development

RUN apk add --no-cache \
    g++ \
    linux-headers \
    make \
    python3

COPY package.json package-lock.json ./
RUN npm install --include=dev

FROM deps AS builder
WORKDIR /app
COPY . .
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

RUN apk add --no-cache \
    ca-certificates \
    curl \
    gcompat \
    libstdc++ \
    tini \
  && addgroup -S app \
  && adduser -S -G app -h /home/app app \
  && mkdir -p /app/data /app/logs \
  && chown -R app:app /app /home/app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json package-lock.json ./
COPY server ./server

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=6004 \
    STATE_FILE_PATH=/app/data/state.json \
    METRICS_DB_PATH=/app/data/metrics.db

USER app

EXPOSE 6004

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf http://127.0.0.1:6004/api/health || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "if [ \"$SERVICE_ROLE\" = \"collector\" ]; then npm run start:collector; else npm run start:web; fi"]
