import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ToolsManager } from '@ivotoby/openapi-mcp-server';
import type { ExtendedTool } from '@ivotoby/openapi-mcp-server';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createCatalog, generatorConfig, loadOpenApi } from '../src/openapi.js';
import { spec } from './spec.js';

const requests: { method: string; path: string; query: string; token: string; body?: unknown }[] = [];
let backend: ReturnType<typeof serve>;
let app: Awaited<ReturnType<typeof createApp>>;
let config: ReturnType<typeof loadConfig>;
let specResponse: unknown = spec;
const tools = new ToolsManager(generatorConfig(JSON.stringify(spec), 'https://api.example.com'));
await tools.initialize();

function toolName(method: string, path: string) {
  const match = (tools.getAllTools() as ExtendedTool[]).find((tool) => tool.httpMethod === method && tool.originalPath === path);
  assert.ok(match, `No generated tool for ${method} ${path}`);
  return match.name;
}

before(async () => {
  const upstream = new Hono();
  upstream.get('/public-api/openapi/public', (context) => context.json(specResponse));
  upstream.get('/public-api/oauth/context', (context) => {
    const token = context.req.header('Authorization');
    if (token === 'Bearer revoked') return context.json({}, 401);
    if (token === 'Bearer removed') return context.json({}, 403);
    if (token === 'Bearer missing-scopes') return context.json({ code: 'insufficient_scope', requiredScopes: ['user:org:read'] }, 403);
    if (token === 'Bearer untrusted-scopes') return context.json({ code: 'insufficient_scope', requiredScopes: ['admin:all'] }, 403);
    if (token === 'Bearer unavailable') return context.json({}, 503);
    if (token === 'Bearer malformed') return context.json({ unexpected: true });
    return context.json({
      userId: token === 'Bearer other-user' ? 'user_b' : 'user_a',
      organizationId: token === 'Bearer other-user' ? 'org_b' : 'org_a',
      clientId: 'client_test',
      scopes: ['user:org:read'],
      expiresAt: token === 'Bearer expired' ? 1 : Math.floor(Date.now() / 1000) + 3600,
    });
  });
  upstream.all('/public-api/*', async (context) => {
    const token = context.req.header('Authorization') ?? '';
    requests.push({ method: context.req.method, path: context.req.path, query: new URL(context.req.url).search, token, body: ['POST', 'PUT', 'PATCH'].includes(context.req.method) ? await context.req.json() : undefined });
    if (context.req.path.endsWith('/forbidden')) return context.json({ token: 'secret-do-not-return', error: 'private internals' }, 403);
    return context.json({ ok: true });
  });
  await new Promise<void>((resolve) => { backend = serve({ fetch: upstream.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve()); });
  const address = backend.address();
  assert.ok(address && typeof address === 'object');
  config = loadConfig({ MCP_PUBLIC_URL: 'http://localhost:3000/mcp', MCP_OAUTH_ISSUER: 'https://clerk.example.com', TEMBO_API_URL: `http://127.0.0.1:${address.port}/public-api`, MCP_TOOL_MODE: 'all' });
  app = await createApp(config, await loadOpenApi(config));
});
beforeEach(() => { requests.length = 0; specResponse = spec; });
after(async () => { await new Promise<void>((resolve) => backend.close(() => resolve())); });

async function rpc(method: string, params: Record<string, unknown> = {}, token = 'reader', application = app) {
  return application.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
  });
}

describe('OpenAPI-generated MCP', () => {
  it('exposes every operation, including billing, credentials, legacy, and future endpoints', async () => {
    const response = await rpc('tools/list', {}, 'writer');
    const payload = await response.json();
    assert.equal(payload.result.tools.length, 10);
    assert.deepEqual(new Set(payload.result.tools.map((tool: { name: string }) => tool.name)), new Set(tools.getAllTools().map((tool) => tool.name)));
  });

  it('completes initialization and a generated tool call with a real MCP SDK client', async () => {
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer writer' } },
      fetch: async (input, init) => app.request(new Request(input, init)),
    });
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 10);
      const response = await client.callTool({ name: toolName('GET', '/v1/widgets/{widgetId}'), arguments: { widgetId: 'widget-1' } });
      assert.equal(response.isError, undefined);
      assert.equal(requests[0]?.path, '/public-api/v1/widgets/widget-1');
    } finally { await client.close(); }
  });

  it('invokes generated GET, POST, PUT, PATCH, DELETE and preserves query/body parameters', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const path = ['GET', 'POST'].includes(method) ? '/v1/widgets' : '/v1/widgets/{widgetId}';
      const args = method === 'GET' ? { limit: 7 } : { ...(path.includes('{') ? { widgetId: 'widget-2' } : {}), ...(method !== 'DELETE' ? { content: 'hello', settings: { nested: true } } : {}) };
      const result = await (await rpc('tools/call', { name: toolName(method, path), arguments: args }, 'writer')).json();
      assert.equal(result.result.isError, undefined, JSON.stringify(result));
    }
    assert.deepEqual(requests.map((request) => request.method), ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    assert.equal(requests[0]?.query, '?limit=7');
    assert.deepEqual(requests[2]?.body, { content: 'hello', settings: { nested: true } });
    assert.equal(requests[2]?.path, '/public-api/v1/widgets/widget-2');
  });

  it('retains schemas from OpenAPI references', async () => {
    const response = await (await rpc('tools/list', {}, 'writer')).json();
    const create = response.result.tools.find((tool: { name: string }) => tool.name === toolName('POST', '/v1/widgets'));
    assert.equal(create.inputSchema.properties.content.type, 'string');
    assert.deepEqual(create.inputSchema.required, ['content']);
  });

  it('discovers a newly published operation on restart without tool code changes', async () => {
    specResponse = { ...spec, paths: { ...spec.paths, '/v1/another-new-endpoint': { get: { operationId: 'anotherNewEndpoint', responses: { '200': { description: 'ok' } } } } } };
    const updated = await createApp(config, await loadOpenApi(config));
    const response = await rpc('tools/list', {}, 'writer', updated);
    assert.equal((await response.json()).result.tools.length, 11);
  });

  it('fails startup on empty or invalid specs instead of silently exposing partial coverage', async () => {
    for (const value of [{}, { openapi: '3.1.0', paths: {} }]) {
      specResponse = value;
      await assert.rejects(loadOpenApi(config));
    }
  });

  it('permits approved OAuth clients to call public mutations', async () => {
    const listed = await (await rpc('tools/list')).json();
    assert.equal(listed.result.tools.length, 10);
    const response = await rpc('tools/call', { name: toolName('DELETE', '/v1/widgets/{widgetId}'), arguments: { widgetId: 'widget-1' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.isError, undefined);
    assert.equal(requests.length, 1);
  });

  it('does not share caller credentials across concurrent requests', async () => {
    await Promise.all(['reader', 'other-user'].map((token) => rpc('tools/call', { name: toolName('GET', '/v1/billing'), arguments: {} }, token)));
    assert.deepEqual(requests.map((request) => request.token).sort(), ['Bearer other-user', 'Bearer reader']);
  });

  it('rejects unknown tools instead of forwarding arbitrary paths', async () => {
    const response = await (await rpc('tools/call', { name: 'GET::internal__admin', arguments: {} }, 'writer')).json();
    assert.ok(response.error || response.result?.isError);
    assert.equal(requests.length, 0);
  });

  it('sanitizes upstream auth errors', async () => {
    const response = await (await rpc('tools/call', { name: toolName('GET', '/v1/widgets/{widgetId}'), arguments: { widgetId: 'forbidden' } })).json();
    assert.equal(response.result.isError, true);
    assert.ok(!JSON.stringify(response).includes('secret-do-not-return'));
    assert.ok(!JSON.stringify(response).includes('private internals'));
  });
});

describe('OAuth transport', () => {
  it('publishes canonical metadata without authentication', async () => {
    const response = await app.request('/.well-known/oauth-protected-resource/mcp', { headers: { Host: 'attacker.example.com' } });
    const metadata = await response.json();
    assert.equal(metadata.resource, config.publicUrl);
    assert.deepEqual(metadata.scopes_supported, ['user:org:read']);
  });
  it('challenges missing or malformed credentials', async () => {
    for (const authorization of ['', 'Basic test', 'Bearer token extra']) {
      const response = await app.request('/mcp', { method: 'POST', headers: { Authorization: authorization } });
      assert.equal(response.status, 401);
      assert.match(response.headers.get('www-authenticate') ?? '', /resource_metadata=/);
      assert.match(response.headers.get('www-authenticate') ?? '', /scope="user:org:read"/);
    }
  });
  it('distinguishes invalid grants, missing access, and provider outages', async () => {
    for (const [token, status] of [['revoked', 401], ['expired', 401], ['removed', 403], ['unavailable', 503], ['malformed', 503]] as const) {
      assert.equal((await rpc('tools/list', {}, token)).status, status);
    }
  });
  it('does not suggest broader consent for removed membership or unrecognized scopes', async () => {
    for (const token of ['removed', 'untrusted-scopes']) {
      const response = await rpc('tools/list', {}, token);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('www-authenticate'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  });
  it('propagates recognized scope failures from the identity API', async () => {
    const response = await rpc('tools/list', {}, 'missing-scopes');
    assert.equal(response.status, 403);
    assert.match(response.headers.get('www-authenticate') ?? '', /error="insufficient_scope"/);
    assert.match(response.headers.get('www-authenticate') ?? '', /scope="user:org:read"/);
  });
  it('rejects query credentials even when a valid header is present', async () => {
    for (const query of ['access_token=secret', 'token=secret', 'state=secret']) {
      const response = await app.request(`/mcp?${query}`, { method: 'POST', headers: { Authorization: 'Bearer writer' } });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('www-authenticate') ?? '', /error="invalid_request"/);
    }
    assert.equal(requests.length, 0);
  });
  it('rejects cross-origin browser requests', async () => {
    assert.equal((await app.request('/mcp', { method: 'POST', headers: { Origin: 'https://attacker.example.com', Authorization: 'Bearer writer' } })).status, 403);
  });
  it('bounds request size', async () => {
    assert.equal((await app.request('/mcp', { method: 'POST', headers: { Authorization: 'Bearer writer' }, body: 'x'.repeat(256 * 1024 + 1) })).status, 413);
  });
  it('rejects insecure configuration', () => {
    for (const apiUrl of ['http://api.example.com', 'https://user:pass@api.example.com', 'https://api.example.com?redirect=1']) {
      assert.throws(() => loadConfig({ MCP_PUBLIC_URL: 'http://localhost:3000/mcp', MCP_OAUTH_ISSUER: 'https://clerk.example.com', TEMBO_API_URL: apiUrl }));
    }
  });
});

describe('Canonical generated server', () => {
  it('paginates individual generated tools without losing operations', async () => {
    const extraPaths = Object.fromEntries(Array.from({ length: 55 }, (unused, index) => [`/v1/extra-${index}`, { get: { operationId: `getExtra${index}`, responses: { 200: { description: 'OK' } } } }]));
    const expanded = await createApp(config, JSON.stringify({ ...spec, paths: { ...spec.paths, ...extraPaths } }));
    const first = await (await rpc('tools/list', {}, 'reader', expanded)).json();
    const second = await (await rpc('tools/list', { cursor: first.result.nextCursor }, 'reader', expanded)).json();
    assert.equal(first.result.tools.length, 50);
    assert.equal(second.result.tools.length, 15);
    assert.equal(second.result.nextCursor, undefined);
    assert.equal(new Set([...first.result.tools, ...second.result.tools].map((tool: { name: string }) => tool.name)).size, 65);
  });

  it('rejects dot-segment path arguments before dispatch', async () => {
    for (const widgetId of ['.', '..']) {
      const result = await (await rpc('tools/call', { name: toolName('GET', '/v1/widgets/{widgetId}'), arguments: { widgetId } })).json();
      assert.equal(result.result.isError, true);
    }
    assert.equal(requests.length, 0);
  });

  it('negotiates the current protocol through the official SDK', async () => {
    const client = new Client({ name: 'modern-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer reader' } },
      fetch: async (input, init) => app.request(new Request(input, init)),
    });
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), 'modern');
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 10);
      assert.ok(tools.tools.every((tool) => tool.annotations && tool.outputSchema));
      const response = await client.callTool({ name: toolName('GET', '/v1/billing'), arguments: {} });
      assert.deepEqual(response.structuredContent, { data: { ok: true } });
    } finally { await client.close(); }
  });

  it('provides four compact tools and paginates the entire generated catalog', async () => {
    const compact = await createApp({ ...config, toolMode: 'compact' }, JSON.stringify(spec));
    const listed = await (await rpc('tools/list', {}, 'reader', compact)).json();
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ['search_tools', 'get_tool_schema', 'call_read_tool', 'call_write_tool']);
    const names: string[] = [];
    for (let offset = 0; offset < 10; offset += 2) {
      const result = await (await rpc('tools/call', { name: 'search_tools', arguments: { limit: 2, offset } }, 'reader', compact)).json();
      assert.equal(result.result.structuredContent.data.total, 10);
      names.push(...result.result.structuredContent.data.tools.map((tool: { name: string }) => tool.name));
    }
    assert.deepEqual(new Set(names), new Set(tools.getAllTools().map((tool) => tool.name)));
    assert.equal(requests.length, 0);
  });

  it('executes compact reads and writes with argument validation', async () => {
    const compact = await createApp({ ...config, toolMode: 'compact' }, JSON.stringify(spec));
    const writeName = toolName('POST', '/v1/widgets');
    const details = await (await rpc('tools/call', { name: 'get_tool_schema', arguments: { name: writeName } }, 'reader', compact)).json();
    assert.equal(details.result.structuredContent.data.annotations.destructiveHint, true);
    assert.ok(details.result.structuredContent.data.inputSchema.required.includes('content'));
    const input = { name: 'call_write_tool', arguments: { name: writeName, arguments: { content: 'new' } } };
    const wrongChannel = await (await rpc('tools/call', { ...input, name: 'call_read_tool' }, 'writer', compact)).json();
    assert.equal(wrongChannel.result.isError, true);
    const invalid = await (await rpc('tools/call', { name: 'call_write_tool', arguments: { name: writeName, arguments: { content: 42 } } }, 'writer', compact)).json();
    assert.equal(invalid.result.isError, true);
    assert.equal(requests.length, 0);
    const written = await (await rpc('tools/call', input, 'writer', compact)).json();
    assert.deepEqual(written.result.structuredContent, { data: { ok: true } });
    assert.deepEqual(requests[0]?.body, { content: 'new' });
    const read = await rpc('tools/call', { name: 'call_read_tool', arguments: { name: toolName('GET', '/v1/billing') } }, 'reader', compact);
    assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await read.json()).result.structuredContent, { data: { ok: true } });
  });

  it('supports closed union request bodies alongside path parameters', async () => {
    const unionSpec = { ...spec, paths: { ...spec.paths, '/v1/connections/{connectionId}': {
      parameters: [{ name: 'connectionId', in: 'path', required: true, schema: { type: 'string' } }],
      patch: { operationId: 'updateConnection', requestBody: { required: true, content: { 'application/json': { schema: { anyOf: [
        { type: 'object', properties: { type: { const: 'local', type: 'string' }, command: { type: 'string' } }, required: ['type', 'command'], additionalProperties: false },
        { type: 'object', properties: { type: { const: 'remote', type: 'string' }, url: { type: 'string' } }, required: ['type', 'url'], additionalProperties: false },
      ] } } } }, responses: { 200: { description: 'OK' } } },
    } } };
    const content = JSON.stringify(unionSpec);
    const catalog = await createCatalog(content, config.apiUrl);
    const name = catalog.entries.find((entry) => entry.path === '/v1/connections/{connectionId}')!.tool.name;
    const updated = await createApp(config, content);
    const result = await (await rpc('tools/call', { name, arguments: { connectionId: 'id-1', type: 'local', command: 'test' } }, 'writer', updated)).json();
    assert.equal(result.result.isError, undefined);
    assert.equal(requests[0]?.path, '/public-api/v1/connections/id-1');
    assert.deepEqual(requests[0]?.body, { type: 'local', command: 'test' });
    const invalid = await (await rpc('tools/call', { name, arguments: { connectionId: 'id-1', type: 'local', url: 'wrong-variant' } }, 'writer', updated)).json();
    assert.equal(invalid.result.isError, true);
    assert.equal(requests.length, 1);
  });

  it('rejects an HTTP routing header that disagrees with the modern request', async () => {
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer reader', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    });
    assert.equal(response.status, 400);
    assert.equal(requests.length, 0);
  });
});
