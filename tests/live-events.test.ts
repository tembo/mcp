import { after, before, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startLiveSubscriptions } from '../src/live.js';
import { liveEventSnapshot } from '../src/live-events.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const MISSING = '22222222-2222-4222-8222-222222222222';
const uri = (sessionId = SESSION) => `tembo://sessions/${sessionId}/events`;
const success = { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } };
const spec = { openapi: '3.1.0', info: { title: 'Live events', version: '1' }, paths: {
  '/v1/live': {
    post: { operationId: 'liveConnectionTicket', responses: success },
    get: { operationId: 'liveConnection', responses: { '101': { description: 'WebSocket' } } },
  },
  '/v1/sessions/{sessionId}/events': { get: { operationId: 'listSessionEvents', parameters: [{ in: 'path', name: 'sessionId', required: true, schema: { type: 'string' } }], responses: success } },
} };
let backend: Server;
let mcp: ReturnType<typeof serve>;
let apiUrl: string;
let mcpUrl: URL;
let directory: string;
let schemaPath: string;
let revoked = false;
let hold = false;
let rejectUpgrade = false;
let deltaOnReady = false;
const tickets = new Set<string>();
const issued: string[] = [];
const connected: string[] = [];
const sockets = new Map<Socket, string | undefined>();

function send(socket: Socket, value: unknown, raw = false) {
  const payload = Buffer.from(raw ? String(value) : JSON.stringify(value));
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.alloc(4);
  if (payload.length >= 126) { header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  socket.write(Buffer.concat([header, payload]));
}

function delta(message = 'LIVE_OUTPUT', index = 0) {
  return { type: 'delta', data: { event: 'response.output_text.delta', message: JSON.stringify({ delta: message, sequence_number: index }), messageId: 'message-1' } };
}

async function waitFor(check: () => unknown, message = 'Timed out') {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function within<Type>(promise: Promise<Type>): Promise<Type> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Request hung')), 5000); })]); }
  finally { clearTimeout(timer!); }
}

before(async () => {
  backend = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    response.setHeader('content-type', 'application/json');
    if (path === '/public-api/auth/context') return response.end(JSON.stringify({ userId: 'user-1', organizationId: 'org-1' }));
    if (path === '/public-api/v1/live' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      assert.equal(body, '');
      assert.ok(request.headers.authorization?.startsWith('Bearer '));
      if (revoked) { response.statusCode = 403; return response.end('{"error":"Revoked"}'); }
      const ticket = randomUUID(); tickets.add(ticket); issued.push(ticket);
      return response.end(JSON.stringify({ ticket }));
    }
    if (path === `/public-api/v1/sessions/${SESSION}/events` && !revoked) return response.end('{"items":[],"nextCursor":null}');
    response.statusCode = 404;
    response.end('{"error":"Not found"}');
  });
  backend.on('upgrade', (request, socket: Socket) => {
    const url = new URL(request.url!, 'http://localhost');
    const ticket = url.searchParams.get('ticket') ?? '';
    if (url.pathname !== '/public-api/v1/live' || !tickets.has(ticket) || rejectUpgrade) return void socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    connected.push(ticket);
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.set(socket, undefined);
    socket.on('close', () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const opcode = buffered[0]! & 0x0f;
        const shortLength = buffered[1]! & 0x7f;
        const header = shortLength === 126 ? 4 : 2;
        if (buffered.length < header + 4) return;
        const length = shortLength === 126 ? buffered.readUInt16BE(2) : shortLength;
        if (buffered.length < header + 4 + length) return;
        const mask = buffered.subarray(header, header + 4);
        const payload = Buffer.from(buffered.subarray(header + 4, header + 4 + length));
        buffered = buffered.subarray(header + 4 + length);
        for (let index = 0; index < payload.length; index++) payload[index] = payload[index]! ^ mask[index % 4]!;
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString());
        assert.equal(message.op, 'subscribe');
        assert.equal(message.resource, 'sessions.events');
        if (message.input.scope.sessionId !== SESSION) send(socket, { id: message.id, type: 'error', status: 404, message: 'Not found' });
        else {
          sockets.set(socket, message.id);
          if (!hold) send(socket, { id: message.id, type: 'ready' });
          if (!hold && deltaOnReady) send(socket, { id: message.id, type: 'event', data: delta() });
        }
      }
    });
    send(socket, { type: 'ready' });
  });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address(); assert.ok(address && typeof address === 'object');
  apiUrl = `http://127.0.0.1:${address.port}/public-api`;
  const app = await createApp(loadConfig({ MCP_PUBLIC_URL: 'http://localhost:3000/mcp', TEMBO_API_URL: apiUrl }), JSON.stringify(spec));
  await new Promise<void>(resolve => { mcp = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve()); });
  const mcpAddress = mcp.address(); assert.ok(mcpAddress && typeof mcpAddress === 'object');
  mcpUrl = new URL(`http://127.0.0.1:${mcpAddress.port}/mcp`);
  directory = await mkdtemp(join(tmpdir(), 'tembo-events-'));
  schemaPath = join(directory, 'openapi.json');
  await writeFile(schemaPath, JSON.stringify(spec));
});

beforeEach(() => { revoked = false; hold = false; rejectUpgrade = false; deltaOnReady = false; issued.length = 0; connected.length = 0; });
after(async () => {
  for (const socket of sockets.keys()) socket.destroy();
  await new Promise<void>(resolve => mcp.close(() => resolve()));
  await new Promise<void>(resolve => backend.close(() => resolve()));
  await rm(directory, { recursive: true });
});

function clientFor(mode: 'http' | 'stdio' | 'legacy', token = 'api-key') {
  const client = new Client({ name: 'events-test', version: '1' }, mode === 'legacy' ? {} : { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const transport = mode === 'http' ? new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
    : new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'], cwd: process.cwd(), env: { TEMBO_API_KEY: token, TEMBO_API_URL: apiUrl, MCP_OPENAPI_PATH: schemaPath }, stderr: 'pipe' });
  return { client, transport };
}

async function read(client: Client) {
  const result = await client.readResource({ uri: uri() });
  const content = result.contents[0]; assert.ok(content && 'text' in content);
  return JSON.parse(content.text);
}

for (const mode of ['http', 'stdio', 'legacy'] as const) {
  it(`serves actual output deltas before persistence over ${mode}`, async () => {
    const { client, transport } = clientFor(mode);
    const updates: string[] = [];
    client.setNotificationHandler('notifications/resources/updated', notification => { updates.push(notification.params.uri); });
    try {
      await client.connect(transport);
      assert.deepEqual((await client.listResourceTemplates()).resourceTemplates.map(template => template.uriTemplate), ['tembo://sessions/{sessionId}/events']);
      const subscription = mode === 'legacy' ? undefined : await client.listen({ resourceSubscriptions: [uri()] });
      if (mode === 'legacy') await client.subscribeResource({ uri: uri() });
      for (const [socket, id] of sockets) send(socket, { id, type: 'event', data: delta() });
      await waitFor(() => updates.length === 1);
      const snapshot = await read(client);
      assert.deepEqual(snapshot.recorded.items, []);
      assert.deepEqual(snapshot.live.deltas, [{ cursor: 1, data: delta() }]);
      assert.equal(snapshot.live.truncated, false);
      if (subscription) await subscription.close(); else await client.unsubscribeResource({ uri: uri() });
      await waitFor(() => sockets.size === 0);
      assert.deepEqual((await read(client)).live.deltas, []);
    } finally { await client.close(); }
  });
}

it('delivers output that arrives while the HTTP listen is starting', async () => {
  const { client, transport } = clientFor('http');
  const updates: string[] = [];
  client.setNotificationHandler('notifications/resources/updated', notification => { updates.push(notification.params.uri); });
  deltaOnReady = true;
  try {
    await client.connect(transport);
    const subscription = await client.listen({ resourceSubscriptions: [uri()] });
    await waitFor(() => updates.length === 1, 'Startup output was never announced');
    assert.deepEqual((await read(client)).live.deltas, [{ cursor: 1, data: delta() }]);
    await subscription.close();
    await waitFor(() => sockets.size === 0);
  } finally { await client.close(); }
});

it('sends one update per delta when several credentials watch a session', async () => {
  const clients = ['api-key-a', 'api-key-b', 'api-key-c'].map(token => ({ ...clientFor('http', token), updates: [] as string[] }));
  try {
    const subscriptions = [];
    for (const entry of clients) {
      entry.client.setNotificationHandler('notifications/resources/updated', notification => { entry.updates.push(notification.params.uri); });
      await entry.client.connect(entry.transport);
      subscriptions.push(await entry.client.listen({ resourceSubscriptions: [uri()] }));
    }
    await waitFor(() => [...sockets.values()].filter(Boolean).length === clients.length);
    for (const [socket, id] of sockets) send(socket, { id, type: 'event', data: delta() });
    await waitFor(() => clients.every(entry => entry.updates.length >= 1));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(clients.map(entry => entry.updates.length), clients.map(() => 1));
    for (const subscription of subscriptions) await subscription.close();
    await waitFor(() => sockets.size === 0);
  } finally { for (const entry of clients) await entry.client.close(); }
});

it('waits for subscription-level ready and fails scoped authorization cleanly', async () => {
  const { client, transport } = clientFor('http');
  hold = true;
  try {
    await client.connect(transport);
    let settled = false;
    const pending = client.listen({ resourceSubscriptions: [uri()] }).then(subscription => { settled = true; return subscription; });
    await waitFor(() => [...sockets.values()].includes('events'));
    assert.equal(settled, false);
    for (const [socket, id] of sockets) send(socket, { id, type: 'ready' });
    await (await pending).close();
    hold = false;
    await assert.rejects(within(client.listen({ resourceSubscriptions: [uri(MISSING)] })));
    await waitFor(() => sockets.size === 0);
  } finally { await client.close(); }
});

it('reconnects with fresh tickets and marks potentially missed output', async () => {
  const { client, transport } = clientFor('http');
  const updates: string[] = [];
  client.setNotificationHandler('notifications/resources/updated', notification => { updates.push(notification.params.uri); });
  try {
    await client.connect(transport);
    const subscription = await client.listen({ resourceSubscriptions: [uri()] });
    for (const [socket, id] of sockets) { send(socket, { id, type: 'event', data: delta() }); }
    await waitFor(() => updates.length === 1);
    for (const socket of sockets.keys()) socket.destroy();
    await waitFor(() => connected.length === 2 && updates.length === 2);
    assert.equal(issued.length, 2);
    assert.notEqual(connected[0], connected[1]);
    assert.equal((await read(client)).live.gap, true);
    await subscription.close();
    await waitFor(() => sockets.size === 0);
  } finally { await client.close(); }
});

it('keeps buffers bounded, marks truncation, and isolates callers', async () => {
  const { client, transport } = clientFor('http');
  const other = clientFor('http', 'other-key');
  const updates: string[] = [];
  client.setNotificationHandler('notifications/resources/updated', notification => { updates.push(notification.params.uri); });
  try {
    await client.connect(transport);
    await other.client.connect(other.transport);
    const subscription = await client.listen({ resourceSubscriptions: [uri()] });
    for (const [socket, id] of sockets) for (let index = 0; index < 110; index++) send(socket, { id, type: 'event', data: delta('x'.repeat(6000), index) });
    await waitFor(() => updates.length >= 1);
    let snapshot = await read(client);
    for (const deadline = Date.now() + 5000; snapshot.live.cursor < 110 && Date.now() < deadline;) {
      await new Promise(resolve => setTimeout(resolve, 10));
      snapshot = await read(client);
    }
    assert.equal(snapshot.live.cursor, 110);
    assert.ok(updates.length < 110, 'Bursts of deltas should be coalesced');
    assert.equal(snapshot.live.truncated, true);
    assert.ok(snapshot.live.deltas.length <= 100);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot.live.deltas)) < 270000);
    assert.deepEqual((await read(other.client)).live.deltas, []);
    revoked = true;
    await assert.rejects(client.readResource({ uri: uri() }));
    await subscription.close();
    await waitFor(() => sockets.size === 0);
  } finally { await client.close(); await other.client.close(); }
});

it('fails rejected upgrades promptly without blocking the stdio queue', async () => {
  const { client, transport } = clientFor('stdio');
  rejectUpgrade = true;
  try {
    await client.connect(transport);
    await assert.rejects(within(client.listen({ resourceSubscriptions: [uri()] })));
    assert.ok((await within(client.listTools())).tools.length);
    assert.equal(sockets.size, 0);
  } finally { await client.close(); }
});

it('closes a revoked stdio listen and releases its buffer', async () => {
  const { client, transport } = clientFor('stdio');
  try {
    await client.connect(transport);
    const subscription = await client.listen({ resourceSubscriptions: [uri()] });
    for (const [socket, id] of sockets) send(socket, { id, type: 'error', status: 404, message: 'Revoked' });
    assert.equal(await within(subscription.closed), 'graceful');
    await waitFor(() => sockets.size === 0);
    assert.deepEqual((await read(client)).live.deltas, []);
  } finally { await client.close(); }
});

it('abort during scoped authorization releases sockets and buffers', async () => {
  hold = true;
  const controller = new AbortController();
  const credentials = { apiUrl, token: 'api-key' };
  const pending = startLiveSubscriptions(credentials, [uri()], { onChange() {}, onEnd() {} }, controller.signal);
  await waitFor(() => sockets.size === 1);
  controller.abort();
  assert.equal(typeof await within(pending), 'string');
  await waitFor(() => sockets.size === 0);
  assert.deepEqual(liveEventSnapshot(credentials, SESSION).deltas, []);
});

it('shares one upstream per caller/session without duplicating deltas or stopping other listeners', async () => {
  const first = clientFor('http');
  const second = clientFor('http');
  const notifications: [number, number] = [0, 0];
  first.client.setNotificationHandler('notifications/resources/updated', () => { notifications[0]++; });
  second.client.setNotificationHandler('notifications/resources/updated', () => { notifications[1]++; });
  try {
    await first.client.connect(first.transport);
    await second.client.connect(second.transport);
    const one = await first.client.listen({ resourceSubscriptions: [uri()] });
    const two = await second.client.listen({ resourceSubscriptions: [uri()] });
    assert.equal(sockets.size, 1);
    const aborted = new AbortController();
    const joined = startLiveSubscriptions({ apiUrl, token: 'api-key' }, [uri()], { onChange() {}, onEnd() {} }, aborted.signal);
    aborted.abort();
    assert.equal(typeof await joined, 'string');
    assert.equal(sockets.size, 1);
    for (const [socket, id] of sockets) send(socket, { id, type: 'event', data: delta() });
    await waitFor(() => notifications[0] === 1 && notifications[1] === 1);
    assert.equal((await read(first.client)).live.deltas.length, 1);
    await one.close();
    assert.equal(sockets.size, 1);
    for (const [socket, id] of sockets) send(socket, { id, type: 'event', data: delta('second', 1) });
    await waitFor(() => notifications[1] === 2);
    assert.equal((await read(second.client)).live.deltas.length, 2);
    await two.close();
    await waitFor(() => sockets.size === 0);
  } finally { await first.client.close(); await second.client.close(); }
});
