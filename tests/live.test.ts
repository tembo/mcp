import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Hono } from 'hono';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const FORBIDDEN = '22222222-2222-4222-8222-222222222222';
const REJECTED = '33333333-3333-4333-8333-333333333333';
const uri = (sessionId: string) => `tembo://sessions/${sessionId}/messages`;
const response = { '200': { description: 'Success', content: { 'application/json': { schema: { type: 'object' } } } } };
const liveSpec = {
  openapi: '3.1.0',
  info: { title: 'Tembo Public API', version: 'test' },
  paths: {
    '/v1/messages': { get: { operationId: 'listMessages', parameters: [{ name: 'sessionId', in: 'query', schema: { type: 'string' } }], responses: response } },
    '/v1/messages/live': {
      post: { operationId: 'messageLiveTicket', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { scope: { type: 'object' } }, required: ['scope'] } } } }, responses: response },
      get: { operationId: 'messageLive', parameters: [{ name: 'ticket', in: 'query', required: true, schema: { type: 'string' } }], responses: { '101': { description: 'Authorized native WebSocket' } } },
    },
    '/v1/integrations/sync': { post: { operationId: 'syncIntegrations', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false } } } }, responses: response } },
  },
};

const sockets = new Set<Socket>();
const tickets = new Map<string, string>();
const bodies: unknown[] = [];
let revoked = false;
let backend: ReturnType<typeof serve>;
let mcp: ReturnType<typeof serve>;
let apiUrl: string;
let mcpUrl: URL;
let directory: string;
let schemaPath: string;

function sendFrame(socket: Socket, value: unknown) {
  const payload = Buffer.from(JSON.stringify(value));
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
}

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

before(async () => {
  const upstream = new Hono();
  upstream.get('/public-api/auth/context', (context) =>
    context.req.header('Authorization') === 'Bearer api-key' ? context.json({ userId: 'user_a', organizationId: 'org_a' }) : context.json({}, 401));
  upstream.get('/public-api/v1/messages', (context) => {
    const sessionId = context.req.query('sessionId');
    return sessionId === FORBIDDEN ? context.json({ error: 'Session not found' }, 404) : context.json({ data: [{ id: 'message-1', sessionId }] });
  });
  upstream.post('/public-api/v1/messages/live', async (context) => {
    const { scope } = await context.req.json();
    if (scope.sessionId === FORBIDDEN) return context.json({ error: 'Session not found' }, 404);
    if (revoked) return context.json({ error: 'Forbidden' }, 403);
    // Issue a ticket the WebSocket endpoint will not accept, so the upgrade is rejected with 401.
    if (scope.sessionId === REJECTED) return context.json({ ticket: 'unknown-ticket' });
    const ticket = randomUUID();
    tickets.set(ticket, scope.sessionId);
    return context.json({ ticket });
  });
  upstream.post('/public-api/v1/integrations/sync', async (context) => {
    bodies.push(await context.req.json());
    return context.json({ ok: true });
  });
  await new Promise<void>((resolve) => { backend = serve({ fetch: upstream.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve()); });
  backend.on('upgrade', (request, socket: Socket) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const ticket = url.searchParams.get('ticket') ?? '';
    if (url.pathname !== '/public-api/v1/messages/live' || !tickets.delete(ticket)) return void socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (data: Buffer) => { if (((data[0] ?? 0) & 0x0f) === 0x8) socket.end(Buffer.from([0x88, 0])); });
    sendFrame(socket, { type: 'ready' });
  });
  const backendAddress = backend.address();
  assert.ok(backendAddress && typeof backendAddress === 'object');
  apiUrl = `http://127.0.0.1:${backendAddress.port}/public-api`;

  const app = await createApp(loadConfig({ MCP_PUBLIC_URL: 'http://localhost:3000/mcp', TEMBO_API_URL: apiUrl, MCP_TOOL_MODE: 'all' }), JSON.stringify(liveSpec));
  await new Promise<void>((resolve) => { mcp = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve()); });
  const mcpAddress = mcp.address();
  assert.ok(mcpAddress && typeof mcpAddress === 'object');
  mcpUrl = new URL(`http://127.0.0.1:${mcpAddress.port}/mcp`);

  directory = await mkdtemp(join(tmpdir(), 'tembo-live-'));
  schemaPath = join(directory, 'openapi.json');
  await writeFile(schemaPath, JSON.stringify(liveSpec));
});
beforeEach(() => { bodies.length = 0; revoked = false; });
after(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => mcp.close(() => resolve()));
  await new Promise<void>((resolve) => backend.close(() => resolve()));
  await rm(directory, { recursive: true });
});

function httpClient() {
  const client = new Client({ name: 'live-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const transport = new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: 'Bearer api-key' } } });
  return { client, transport };
}

function stdioClient(modern: boolean) {
  const client = new Client({ name: 'live-stdio-test', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts', '--allow-writes'], cwd: process.cwd(), env: { TEMBO_API_KEY: 'api-key', TEMBO_API_URL: apiUrl, MCP_OPENAPI_PATH: schemaPath }, stderr: 'pipe' });
  return { client, transport };
}

function within<T>(promise: Promise<T>, message: string) {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), 5_000))]);
}

function updates(client: Client) {
  const received: string[] = [];
  client.setNotificationHandler('notifications/resources/updated', (notification) => { received.push(notification.params.uri); });
  return received;
}

describe('live session messages', () => {
  it('serves WebSocket handshakes as resources rather than tools and sends empty bodies as {}', async () => {
    const { client, transport } = httpClient();
    try {
      await client.connect(transport);
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ['list-messages', 'message-live-ticket', 'sync-integrations']);
      assert.equal((await client.callTool({ name: 'sync-integrations', arguments: {} })).isError, undefined);
      assert.deepEqual(bodies, [{}]);
    } finally { await client.close(); }
  });

  it('lists and reads the session messages resource', async () => {
    const { client, transport } = httpClient();
    try {
      await client.connect(transport);
      assert.deepEqual((await client.listResourceTemplates()).resourceTemplates.map((template) => template.uriTemplate), ['tembo://sessions/{sessionId}/messages']);
      const { contents } = await client.readResource({ uri: uri(SESSION) });
      assert.deepEqual(JSON.parse(String(contents[0] && 'text' in contents[0] ? contents[0].text : '')), { data: [{ id: 'message-1', sessionId: SESSION }] });
      await assert.rejects(client.readResource({ uri: uri(FORBIDDEN) }));
      await assert.rejects(client.readResource({ uri: 'tembo://sessions/not-a-session/messages' }));
    } finally { await client.close(); }
  });

  it('pushes resource updates over HTTP subscriptions/listen and releases the upstream socket on close', async () => {
    const { client, transport } = httpClient();
    const received = updates(client);
    try {
      await client.connect(transport);
      const subscription = await client.listen({ resourceSubscriptions: [uri(SESSION)] });
      assert.deepEqual(subscription.honoredFilter.resourceSubscriptions, [uri(SESSION)]);
      await waitFor(() => sockets.size === 1, 'upstream WebSocket not opened');
      for (const socket of sockets) sendFrame(socket, { resource: 'message', sessionId: SESSION });
      await waitFor(() => received.length === 1, 'resource update not delivered');
      assert.deepEqual(received, [uri(SESSION)]);
      for (const socket of sockets) socket.destroy();
      await waitFor(() => received.length === 2 && sockets.size === 1, 'upstream WebSocket not reconnected with a reconciling update');
      await subscription.close();
      await waitFor(() => sockets.size === 0, 'upstream WebSocket not released');
    } finally { await client.close(); }
  });

  it('rejects subscriptions to sessions the caller cannot watch', async () => {
    const { client, transport } = httpClient();
    try {
      await client.connect(transport);
      await assert.rejects(client.listen({ resourceSubscriptions: [uri(FORBIDDEN)] }));
      assert.equal(sockets.size, 0);
    } finally { await client.close(); }
  });

  it('fails fast when the upstream WebSocket upgrade is rejected', async () => {
    const { client, transport } = httpClient();
    try {
      await client.connect(transport);
      await assert.rejects(within(client.listen({ resourceSubscriptions: [uri(REJECTED)] }), 'listen hung'), (error: Error) => error.message !== 'listen hung');
      assert.equal(sockets.size, 0);
    } finally { await client.close(); }
  });

  it('keeps stdio responsive after a rejected upgrade and closes listens when access is revoked', async () => {
    const { client, transport } = stdioClient(true);
    try {
      await client.connect(transport);
      await assert.rejects(within(client.listen({ resourceSubscriptions: [uri(REJECTED)] }), 'listen hung'), (error: Error) => error.message !== 'listen hung');
      assert.equal((await within(client.listTools(), 'stdio queue blocked')).tools.length, 3);
      const subscription = await client.listen({ resourceSubscriptions: [uri(SESSION)] });
      await waitFor(() => sockets.size === 1, 'upstream WebSocket not opened');
      revoked = true;
      for (const socket of sockets) socket.destroy();
      assert.equal(await within(subscription.closed, 'subscription not closed after revocation'), 'graceful');
      assert.equal(sockets.size, 0);
    } finally { await client.close(); }
  });

  for (const modern of [false, true]) {
    it(`pushes resource updates over ${modern ? 'current' : 'legacy'} stdio`, async () => {
      const { client, transport } = stdioClient(modern);
      const received = updates(client);
      try {
        await client.connect(transport);
        const subscription = modern ? await client.listen({ resourceSubscriptions: [uri(SESSION)] }) : undefined;
        if (!modern) await client.subscribeResource({ uri: uri(SESSION) });
        await waitFor(() => sockets.size === 1, 'upstream WebSocket not opened');
        for (const socket of sockets) sendFrame(socket, { resource: 'message', sessionId: SESSION });
        await waitFor(() => received.length === 1, 'resource update not delivered');
        assert.deepEqual(received, [uri(SESSION)]);
        if (subscription) await subscription.close();
        else await client.unsubscribeResource({ uri: uri(SESSION) });
        await waitFor(() => sockets.size === 0, 'upstream WebSocket not released');
        await assert.rejects(modern ? client.listen({ resourceSubscriptions: [uri(FORBIDDEN)] }) : client.subscribeResource({ uri: uri(FORBIDDEN) }));
      } finally { await client.close(); }
    });
  }
});
