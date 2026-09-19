import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { createServer as createViteServer } from 'vite';

const PORT = Number(process.env.PORT) || 8080;
const HA_PORT = Number(process.env.HA_PORT) || 8123;
const HA_TARGET = `http://127.0.0.1:${HA_PORT}`;
const HA_CONFIG_DIR = process.env.HA_CONFIG_DIR || path.join(process.cwd(), 'config');
const STORAGE_DIR = path.join(HA_CONFIG_DIR, '.storage');
const isProduction = process.env.NODE_ENV === 'production';

// Ensure config and .storage directories exist
if (!fs.existsSync(HA_CONFIG_DIR)) {
  fs.mkdirSync(HA_CONFIG_DIR, { recursive: true });
}
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// Configured Home Assistant storage paths
const STORAGE_FILES = {
  onboarding: path.join(STORAGE_DIR, 'onboarding'),
  auth: path.join(STORAGE_DIR, 'core.auth'),
  authProvider: path.join(STORAGE_DIR, 'core.auth_provider.homeassistant'),
  deviceRegistry: path.join(STORAGE_DIR, 'core.device_registry'),
  entityRegistry: path.join(STORAGE_DIR, 'core.entity_registry'),
  restoreState: path.join(STORAGE_DIR, 'core.restore_state'),
  history: path.join(HA_CONFIG_DIR, 'history_log.json'),
};

function readStorage<T>(file: string, defaultValue: T): T {
  try {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(content);
      return parsed.data !== undefined ? parsed.data : parsed;
    }
  } catch (e) {
    console.warn(`[HA STORAGE] Failed to read ${file}:`, e);
  }
  return defaultValue;
}

// Proxy Middleware targeting Real Home Assistant Core Backend (port 8123)
const haProxy = createProxyMiddleware({
  target: HA_TARGET,
  changeOrigin: true,
  ws: true,
  on: {
    proxyReq: fixRequestBody,
    error: (err, req, res: any) => {
      console.warn(`[HA PROXY] Home Assistant Core at ${HA_TARGET} unavailable:`, err.message);
      if (res && res.status && !res.headersSent) {
        res.status(503).json({
          message: 'Home Assistant Core is starting up, please try again in a few seconds...',
          status: 'starting',
        });
      }
    },
  },
});

async function main() {
  const app = express();
  const server = http.createServer(app);

  // --- 1. Yimly Diagnostic Endpoints ---
  app.get('/api/yimly/server-status', async (req, res) => {
    const host = req.get('host') || `localhost:${PORT}`;
    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const companionUrl = `${protocol}://${host}`;

    let isHaRunning = false;
    let haVersion = '2024.12.5';

    try {
      const haCheck = await fetch(`${HA_TARGET}/manifest.json`, { signal: AbortSignal.timeout(1500) });
      if (haCheck.ok) {
        isHaRunning = true;
      }
    } catch (e) {
      isHaRunning = false;
    }

    const authData = readStorage<{ users: any[] }>(STORAGE_FILES.auth, { users: [] });
    const onboarding = readStorage<{ done: string[] }>(STORAGE_FILES.onboarding, { done: [] });

    res.json({
      ha_version: haVersion,
      is_ha_running: isHaRunning,
      ha_target: HA_TARGET,
      server_port: PORT,
      ha_port: HA_PORT,
      ha_pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
      recorder_active: true,
      python_version: 'Home Assistant Core Native Subsystem',
      companion_url: companionUrl,
      config_dir: HA_CONFIG_DIR,
      onboarding_done: onboarding.done?.includes('user') || false,
      owner_count: authData.users?.length || 0,
    });
  });

  // Web App Manifest for PWA
  app.get('/manifest.json', (req, res) => {
    res.json({
      name: 'Home Assistant / Yimly',
      short_name: 'Yimly',
      icons: [{ src: '/favicon.ico', sizes: '64x64', type: 'image/x-icon' }],
      start_url: '/',
      display: 'standalone',
      background_color: '#0f1117',
      theme_color: '#FF4FA3',
    });
  });

  // --- 2. Reverse Proxy to REAL Home Assistant Core (/api/* and /auth/*) ---
  app.use('/auth', haProxy);
  app.use('/api', haProxy);

  // --- 3. Body Parsing Middleware for Non-Proxied Routes ---
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // --- 4. WebSocket Upgrade Handling to REAL Home Assistant Core ---
  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    if (url.startsWith('/api/websocket') || url.startsWith('/api/ws') || url.startsWith('/auth')) {
      // @ts-ignore
      haProxy.upgrade(req, socket, head);
    }
  });

  // --- 5. Frontend Delivery (Vite Middleware in Dev / Static files in Production) ---
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Graceful shutdown handling
  const shutdown = () => {
    console.log('[SERVER] Shutting down gracefully...');
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`================================================================`);
    console.log(`🚀 Yimly Unified Proxy & UI Server running on http://0.0.0.0:${PORT}`);
    console.log(`🔌 Proxying API/Auth/WebSocket to Real Home Assistant Core at ${HA_TARGET}`);
    console.log(`📁 Persistent configuration storage: ${HA_CONFIG_DIR}`);
    console.log(`📱 Official Companion App endpoint: http://0.0.0.0:${PORT}`);
    console.log(`================================================================`);
  });
}

main().catch((err) => {
  console.error('[FATAL SERVER ERROR]', err);
});
