#!/bin/bash
set -e

echo "================================================================"
echo "🚀 Initializing Yimly Home Assistant Core Container"
echo "================================================================"

# 1. Ensure /config directory exists and has full read/write permissions
mkdir -p /config
chmod -R 777 /config 2>/dev/null || true

# 2. Check and initialize /config from default_config if configuration.yaml is missing
# (Never overwrite existing /config to preserve persistent storage)
if [ ! -f /config/configuration.yaml ]; then
  echo "[INIT] /config is empty or missing configuration.yaml. Copying template config..."
  cp -r /app/default_config/. /config/
  chmod -R 777 /config 2>/dev/null || true
  echo "[INIT] /config initialized successfully with template configuration and .storage."
else
  echo "[INIT] Existing /config detected. Preserving all existing user accounts, auth credentials, and database."
fi

# 3. Configure jemalloc for Home Assistant Core if available in the container image
if [ -f "/usr/local/lib/libjemalloc.so.2" ]; then
  export LD_PRELOAD="/usr/local/lib/libjemalloc.so.2"
  export MALLOC_CONF="background_thread:true,metadata_thp:auto,dirty_decay_ms:20000,muzzy_decay_ms:20000"
fi

# 4. Determine Ports
export HA_PORT="${HA_PORT:-8123}"
export PORT="${PORT:-8080}"
export HA_CONFIG_DIR="/config"

echo "[HA] Starting Real Home Assistant Core on internal port ${HA_PORT}..."
# Start Home Assistant Core in the background
python3 -m homeassistant --config /config &
HA_PID=$!
echo "[HA] Home Assistant Core started with PID ${HA_PID}"

# 5. Trap termination signals for clean shutdown of both processes
shutdown() {
  echo "[SHUTDOWN] Received termination signal. Stopping services cleanly..."
  if [ -n "$NODE_PID" ] && kill -0 "$NODE_PID" 2>/dev/null; then
    echo "[SHUTDOWN] Stopping Node proxy (PID ${NODE_PID})..."
    kill -TERM "$NODE_PID" 2>/dev/null || true
  fi
  if [ -n "$HA_PID" ] && kill -0 "$HA_PID" 2>/dev/null; then
    echo "[SHUTDOWN] Stopping Home Assistant Core (PID ${HA_PID})..."
    kill -TERM "$HA_PID" 2>/dev/null || true
    wait "$HA_PID" 2>/dev/null || true
  fi
  echo "[SHUTDOWN] All services stopped successfully."
  exit 0
}

trap shutdown SIGINT SIGTERM

echo "[NODE] Starting Yimly Reverse Proxy & UI Server on public port ${PORT}..."
# Start Node.js Proxy & UI Server in the background
node dist/server.cjs &
NODE_PID=$!
echo "[NODE] Yimly Proxy Server started with PID ${NODE_PID}"

# 6. Monitor both processes. If either exits, log and shutdown gracefully.
wait -n "$HA_PID" "$NODE_PID"
EXIT_STATUS=$?
echo "[WARN] A background service exited with status ${EXIT_STATUS}. Initiating container shutdown..."
shutdown
