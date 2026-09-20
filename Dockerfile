# ==============================================================================
# Yimly Home Assistant Server - Production Dockerfile for Blitz.cloud
# Combines Real Home Assistant Core Backend with Custom Yimly Frontend
# ==============================================================================

# Stage 1: Build the Custom Yimly Frontend & Node Server
FROM node:22-alpine AS frontend-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . ./
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Real Home Assistant Core Base Image (Multi-arch native, no hardcoded platform)
FROM ghcr.io/home-assistant/home-assistant:2024.12.5 AS production

# Install Node.js runtime and networking utilities for proxy
RUN apk add --no-cache nodejs curl bash

WORKDIR /app

# Copy production node dependencies and compiled frontend/server bundle
COPY --from=frontend-builder --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=frontend-builder --chown=1000:1000 /app/dist ./dist
COPY --chown=1000:1000 config ./default_config

# Create non-root user (UID/GID 1000) and ensure directories exist with correct permissions
RUN if ! id -u 1000 >/dev/null 2>&1; then \
      addgroup -g 1000 yimly && \
      adduser -u 1000 -G yimly -s /bin/bash -D yimly; \
    fi && \
    mkdir -p /config /app && \
    chown -R 1000:1000 /config /app

# Persistent storage volume for HA Core configuration, auth, recorder, and registries
VOLUME ["/config"]

# Expose HTTP Port
EXPOSE 8080

# Environment variables
ENV PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    HA_CONFIG_DIR=/config \
    HA_PORT=8123 \
    PORT=8080

# Run container as non-root user 1000
USER 1000:1000

# Clear base image S6-overlay entrypoint so non-root CMD executes directly
ENTRYPOINT []

# Health check directly verifying Yimly & Home Assistant Core proxy status
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD curl -f http://localhost:${PORT:-8080}/api/yimly/server-status || exit 1

# Start script: Initializes config (including hidden .storage dotfiles) if empty, boots HA Core in background, then starts Yimly Unified Proxy & UI Server
CMD ["sh", "-c", "[ -f /config/configuration.yaml ] || cp -r /app/default_config/. /config/ ; python3 -m homeassistant -c /config & exec node dist/server.cjs"]
