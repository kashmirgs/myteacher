import './env.js'; // Must be first — loads .env before any other imports
await import('./db/index.js'); // Initialize DB early (async — PG needs await)
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleConnection } from './ws/handler.js';
import { handleTopicsAPI } from './api/topics.js';

const PORT = Number(process.env.PORT) || 3001;
const IS_PROD = process.env.NODE_ENV === 'production';
const __dirname = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, '../../client/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

async function serveStatic(url: string, res: import('node:http').ServerResponse): Promise<boolean> {
  if (!IS_PROD) return false;
  const filePath = join(STATIC_DIR, url === '/' ? 'index.html' : url);
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    // File not found — try SPA fallback
    try {
      const index = await readFile(join(STATIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(index);
      return true;
    } catch {
      return false;
    }
  }
}

const httpServer = createServer(async (req, res) => {
  if (req.url?.startsWith('/api/topics')) {
    try {
      const handled = await handleTopicsAPI(req, res);
      if (handled) return;
    } catch (err) {
      console.error('[api] unhandled error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal server error' }));
      return;
    }
  }

  // Try static files in production
  if (await serveStatic(req.url ?? '/', res)) return;

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('myteacher server');
});

const wss = new WebSocketServer({ server: httpServer });

// WebSocket ping/pong keepalive (Fly proxy closes idle connections)
const PING_INTERVAL = 30_000;
setInterval(() => {
  wss.clients.forEach((ws) => {
    const client = ws as WebSocket & { isAlive?: boolean };
    if (!client.isAlive) { client.terminate(); return; }
    client.isAlive = false;
    client.ping();
  });
}, PING_INTERVAL);

wss.on('connection', (ws) => {
  console.log('[ws] client connected');
  (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  ws.on('pong', () => { (ws as WebSocket & { isAlive?: boolean }).isAlive = true; });
  handleConnection(ws);
});

const HOST = IS_PROD ? '0.0.0.0' : 'localhost';
httpServer.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT}`);
});
