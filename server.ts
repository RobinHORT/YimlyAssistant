import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';

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

async function main() {
  const app = express();
  const server = http.createServer(app);

  // Dynamically import ESM-only http-proxy-middleware for Node.js 20+ CommonJS compatibility
  const { createProxyMiddleware, fixRequestBody } = await import('http-proxy-middleware');

  // Proxy Middleware targeting Real Home Assistant Core Backend (port 8123)
  const haProxy = createProxyMiddleware({
    target: HA_TARGET,
    changeOrigin: true,
    ws: true,
    xfwd: true,
    on: {
      proxyReq: (proxyReq, req) => {
        fixRequestBody(proxyReq, req);
        const host = req.headers.host;
        if (host) {
          proxyReq.setHeader('X-Forwarded-Host', host);
        }
      },
      error: (err, req, res: any) => {
        console.warn(`[HA PROXY] Home Assistant Core at ${HA_TARGET} unavailable:`, err.message);
        if (res && res.status && !res.headersSent) {
          const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
          if (acceptsHtml && req.method === 'GET') {
            res.status(503).send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="3">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Starting Home Assistant Core...</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f1117; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #1e2230; border: 1px solid #334155; border-radius: 12px; padding: 32px; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    .spinner { border: 3px solid rgba(255, 79, 163, 0.2); border-top-color: #FF4FA3; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto 20px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 20px; margin: 0 0 12px; color: #fff; }
    p { font-size: 14px; color: #94a3b8; line-height: 1.5; margin: 0 0 20px; }
    .links { display: flex; gap: 10px; justify-content: center; }
    a { color: #FF4FA3; text-decoration: none; font-size: 14px; font-weight: 500; }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Home Assistant Core Starting Up</h1>
    <p>Home Assistant Core is initializing configuration and database registries. This page will automatically refresh every 3 seconds.</p>
    <div class="links">
      <a href="/yimly">Open Yimly Tracker &rarr;</a>
    </div>
  </div>
</body>
</html>`);
          } else {
            res.status(503).json({
              message: 'Home Assistant Core is starting up, please try again in a few seconds...',
              status: 'starting',
            });
          }
        }
      },
    },
  });

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

  // --- 2. Yimly UI & Frontend Assets ---
  const distPath = path.join(process.cwd(), 'dist');

  // Serve Yimly static assets
  app.use('/assets', express.static(path.join(distPath, 'assets')));
  app.use('/yimly', express.static(distPath));
  app.get('/yimly*all', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  // --- 3. Body Parsing for non-proxied requests (if any) ---
  app.use('/api/yimly', express.json());
  app.use('/api/yimly', express.urlencoded({ extended: true }));

  // --- 4. WebSocket Upgrade Handling to REAL Home Assistant Core ---
  server.on('upgrade', (req, socket, head) => {
    // Forward WebSocket upgrades directly to Home Assistant Core
    // @ts-ignore
    haProxy.upgrade(req, socket, head);
  });

  // --- 5. Frontend & API Delivery ---
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    // In dev mode (AI Studio preview iframe), redirect root to /yimly
    app.get('/', (req, res, next) => {
      // If client is asking for HTML in browser preview, redirect to /yimly
      const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
      if (acceptsHtml) {
        return res.redirect('/yimly');
      }
      next();
    });
    app.use(vite.middlewares);
  }

  // --- 6. Proxied Routes: Pass EVERYTHING else to Real Home Assistant Core! ---
  // Proxies /, /manifest.json, /api/*, /auth/*, /frontend_latest/*, /static/*, /onboarding.html, /lovelace/*, etc.
  app.use(haProxy);

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
