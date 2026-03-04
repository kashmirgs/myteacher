import './env.js'; // Must be first — loads .env before any other imports
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { handleConnection } from './ws/handler.js';

const PORT = Number(process.env.PORT) || 3001;

const httpServer = createServer((_req, res) => {
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
