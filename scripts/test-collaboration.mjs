import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// The upstream relay utilities are CommonJS; use one Yjs instance in Node.
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
import WebSocket from 'ws';
import { docs } from 'y-websocket/bin/utils';
import { createCollaborationServer } from '../server/collaboration-server.mjs';

async function withRelay(callback, options = {}) {
  const relay = createCollaborationServer(options);
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  const port = relay.server.address().port;
  const providers = [];
  const makeClient = (room) => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collaboration`, room, doc, {
      WebSocketPolyfill: WebSocket, disableBc: true, connect: false,
    });
    providers.push({ provider, doc });
    return { provider, doc };
  };
  try { await callback({ relay, port, makeClient }); } finally {
    for (const { provider, doc } of providers) { provider.destroy(); doc.destroy(); }
    await relay.close();
  }
}

async function eventually(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for collaboration state.');
    await delay(10);
  }
}
async function connect(client) { client.provider.connect(); await eventually(() => client.provider.synced); }
function upgradeStatus(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Upgrade timed out')); }, 5000);
    socket.on('error', () => {});
    socket.once('open', () => { clearTimeout(timer); socket.close(); resolve(101); });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer); response.resume(); socket.terminate(); resolve(response.statusCode);
    });
  });
}

test('health check responds without exposing rooms', { timeout: 10000 }, () => withRelay(async ({ port }) => {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal((await fetch(`http://127.0.0.1:${port}/unknown`)).status, 404);
}));

test('two real WebSocket clients synchronize edits', { timeout: 10000 }, () => withRelay(async ({ makeClient }) => {
  const room = randomUUID();
  const first = makeClient(room); const second = makeClient(room);
  await Promise.all([connect(first), connect(second)]);
  first.doc.getArray('operations').push([{ id: 'first', type: 'ADD_NODE' }]);
  await eventually(() => second.doc.getArray('operations').length === 1);
  second.doc.getArray('operations').push([{ id: 'second', type: 'MOVE_NODE' }]);
  await eventually(() => first.doc.getArray('operations').length === 2);
  assert.deepEqual(first.doc.toJSON(), second.doc.toJSON());
}));

test('offline edits converge after reconnect', { timeout: 10000 }, () => withRelay(async ({ makeClient }) => {
  const room = randomUUID();
  const first = makeClient(room); const second = makeClient(room);
  await Promise.all([connect(first), connect(second)]);
  second.provider.disconnect();
  first.doc.getArray('operations').push([{ id: 'online' }]);
  second.doc.getArray('operations').push([{ id: 'offline' }]);
  await connect(second);
  await eventually(() => first.doc.getArray('operations').length === 2 && second.doc.getArray('operations').length === 2);
  assert.deepEqual(first.doc.toJSON(), second.doc.toJSON());
}));

test('different rooms cannot read each other', { timeout: 10000 }, () => withRelay(async ({ makeClient }) => {
  const first = makeClient(randomUUID()); const second = makeClient(randomUUID());
  await Promise.all([connect(first), connect(second)]);
  first.doc.getMap('private').set('value', 'only-first-room');
  await delay(60);
  assert.equal(second.doc.getMap('private').has('value'), false);
}));

test('invalid room paths and query parameters are rejected', { timeout: 10000 }, () => withRelay(async ({ port }) => {
  for (const path of ['/wrong/room', '/collaboration/', '/collaboration/a/b', '/collaboration/a?token=x', `/collaboration/${'a'.repeat(129)}`]) {
    assert.equal(await upgradeStatus(`ws://127.0.0.1:${port}${path}`), 404);
  }
}));

test('cross-origin browser upgrades are rejected by default', { timeout: 10000 }, () => withRelay(async ({ port }) => {
  const url = `ws://127.0.0.1:${port}/collaboration/${randomUUID()}`;
  assert.equal(await upgradeStatus(url, { Origin: 'https://untrusted.example' }), 403);
  assert.equal(await upgradeStatus(url, { Origin: `http://127.0.0.1:${port}` }), 101);
}));

test('explicit deployment origin allowlist is enforced', { timeout: 10000 }, () => withRelay(async ({ port }) => {
  const url = `ws://127.0.0.1:${port}/collaboration/${randomUUID()}`;
  assert.equal(await upgradeStatus(url, { Origin: 'https://editor.example' }), 101);
  assert.equal(await upgradeStatus(url, { Origin: `http://127.0.0.1:${port}` }), 403);
}, { allowedOrigins: ['https://editor.example'] }));

test('oversized messages are closed with WebSocket code 1009', { timeout: 10000 }, () => withRelay(async ({ port }) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/collaboration/${randomUUID()}`);
  socket.on('error', () => {});
  await once(socket, 'open');
  socket.send(Buffer.alloc(2048));
  const [code] = await once(socket, 'close');
  assert.equal(code, 1009);
}, { maxPayload: 1024 }));

test('idle room state is released after its retention period', { timeout: 10000 }, () => withRelay(async ({ port }) => {
  const room = randomUUID();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/collaboration/${room}`);
  await once(socket, 'open');
  assert.equal(docs.has(room), true);
  socket.close();
  await once(socket, 'close');
  await eventually(() => !docs.has(room));
}, { roomTtlMs: 20 }));
