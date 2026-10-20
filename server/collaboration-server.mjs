import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { docs, setupWSConnection } from 'y-websocket/bin/utils';

const ROOM_PATH = /^\/collaboration\/([a-zA-Z0-9_-]{1,128})$/;

/** Local development relay. Room links are edit capabilities, not authenticated accounts. */
export function createCollaborationServer({
  allowedOrigins = [],
  maxConnections = 128,
  maxRooms = 100,
  maxPayload = 8 * 1024 * 1024,
  roomTtlMs = 5 * 60 * 1000,
} = {}) {
  const server = http.createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
    } else {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
  const idleRooms = new Map();
  const roomNames = new Set();

  const reject = (socket, status, reason) => {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    let url;
    try { url = new URL(request.url ?? '/', 'http://localhost'); } catch { reject(socket, 400, 'Bad Request'); return; }
    const match = ROOM_PATH.exec(url.pathname);
    if (!match || url.search) { reject(socket, 404, 'Not Found'); return; }

    // Vite supplies x-forwarded-host on its loopback-only upstream. An explicit
    // allowlist is required when exposing this relay independently in production.
    const origin = request.headers.origin;
    if (origin) {
      let sameHost = false;
      try {
        const parsed = new URL(origin);
        const forwardedHost = request.headers['x-forwarded-host'];
        const trustedProxy = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
        const host = trustedProxy && typeof forwardedHost === 'string' ? forwardedHost : request.headers.host;
        sameHost = ['http:', 'https:'].includes(parsed.protocol) && parsed.host === host;
      } catch { /* Reject malformed origins below. */ }
      if (!(allowedOrigins.length ? allowedOrigins.includes(origin) : sameHost)) {
        reject(socket, 403, 'Forbidden'); return;
      }
    }
    const roomName = match[1];
    if (websocketServer.clients.size >= maxConnections || (!roomNames.has(roomName) && roomNames.size >= maxRooms)) {
      reject(socket, 503, 'Service Unavailable'); return;
    }
    websocketServer.handleUpgrade(request, socket, head, (connection) => {
      clearTimeout(idleRooms.get(roomName));
      idleRooms.delete(roomName);
      roomNames.add(roomName);
      connection.on('error', () => {});
      setupWSConnection(connection, request, { docName: roomName });
      connection.on('close', () => {
        const doc = docs.get(roomName);
        if (doc?.conns.size) return;
        const timer = setTimeout(() => {
          const current = docs.get(roomName);
          if (!current?.conns.size) {
            current?.destroy();
            docs.delete(roomName);
            roomNames.delete(roomName);
          }
          idleRooms.delete(roomName);
        }, roomTtlMs);
        timer.unref();
        idleRooms.set(roomName, timer);
      });
    });
  });

  return {
    server,
    websocketServer,
    async close() {
      for (const timer of idleRooms.values()) clearTimeout(timer);
      idleRooms.clear();
      for (const connection of websocketServer.clients) connection.terminate();
      await new Promise((resolve) => websocketServer.close(resolve));
      if (server.listening) {
        await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
      }
      for (const name of roomNames) { docs.get(name)?.destroy(); docs.delete(name); }
      roomNames.clear();
      for (const timer of idleRooms.values()) clearTimeout(timer);
      idleRooms.clear();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.COLLABORATION_PORT ?? 1234);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('COLLABORATION_PORT must be an integer from 1 to 65535.');
  const host = process.env.COLLABORATION_HOST ?? '127.0.0.1';
  const allowedOrigins = (process.env.COLLABORATION_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const relay = createCollaborationServer({ allowedOrigins });
  relay.server.on('error', (error) => { console.error(`Collaboration server: ${error.message}`); process.exit(1); });
  relay.server.listen(port, host, () => {
    console.log(`Collaboration relay listening on ${host}:${port}`);
    process.send?.({ type: 'ready' });
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await relay.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('disconnect', stop);
}
