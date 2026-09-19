# ==============================================================================
# Yimly Home Assistant Server - Production Dockerfile for Blitz.cloud
# Combines Real Home Assistant Core Backend with Custom Yimly Frontend
# ==============================================================================

# Stage 1: Build the Custom Yimly Frontend & Node Server
FROM --platform=linux/amd64 node:22-alpine AS frontend-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . ./
RUN npm run build

# Stage 2: Real Home Assistant Core Base Image
FROM --platform=linux/amd64 ghcr.io/home-assistant/home-assistant:2024.12.5 AS production

# Install Node.js runtime to host the unified Yimly server proxy
RUN apk add --no-cache nodejs npm curl bash

WORKDIR /app

# Copy production dependencies and compiled frontend/server bundle
COPY package*.json ./
RUN npm ci --only=production
COPY --from=frontend-builder /app/dist ./dist
COPY config ./default_config

# Create non-root user (UID/GID 1000) if not present, and set up permissions
RUN if ! id -u 1000 >/dev/null 2>&1; then \
      addgroup -g 1000 yimly && \
      adduser -u 1000 -G yimly -s /bin/bash -D yimly; \
    fi && \
    mkdir -p /app/config && \
    chown -R 1000:1000 /app /app/config /app/default_config

# Persistent storage volume for HA Core configuration, auth, recorder, and registries
VOLUME ["/app/config"]

# Expose Blitz HTTP Port
EXPOSE 8080

# Environment variables
ENV PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    HA_CONFIG_DIR=/app/config \
    HA_PORT=8123 \
    PORT=8080

# Run container as non-root user 1000
USER 1000:1000

# Health check directly verifying Yimly & Home Assistant Core proxy status
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD curl -f http://localhost:8080/api/yimly/server-status || exit 1

# Start script: Initializes config if empty, boots HA Core in background, then starts Yimly Unified Proxy & UI Server
CMD ["sh", "-c", "[ -f /app/config/configuration.yaml ] || cp -r /app/default_config/* /app/config/ ; python3 -m homeassistant -c /app/config & exec node dist/server.cjs"]

