# ---- Build Stage ----
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx vite build

# ---- Production Stage ----
FROM node:22-alpine AS runner

WORKDIR /app

RUN apk add --no-cache curl dumb-init && \
    addgroup -S app && adduser -S app -G app

# Install PM2
RUN npm install -g pm2

# Copy production deps only
COPY package.json package-lock.json ./
RUN npm ci --production && npm cache clean --force

# Copy built assets
COPY --from=builder /app/dist ./dist
COPY server/ ./server/
COPY ecosystem.config.js ./

# Create directories with correct permissions
RUN mkdir -p logs data && \
    chown -R app:app /app

USER app

EXPOSE 6004

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf http://127.0.0.1:6004/api/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["pm2-runtime", "start", "ecosystem.config.js"]
