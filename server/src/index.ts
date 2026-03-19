import './env.js'; // Must be first — loads .env before any other imports
import './db/index.js'; // Initialize DB early
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { handleConnection } from './ws/handler.js';
import { handleTopicsAPI } from './api/topics.js';

const PORT = Number(process.env.PORT) || 3001;

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
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('myteacher server');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('[ws] client connected');
  handleConnection(ws);
});

httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
