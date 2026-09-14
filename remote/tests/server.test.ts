import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolsManager } from '@ivotoby/openapi-mcp-server';
import type { ExtendedTool } from '@ivotoby/openapi-mcp-server';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { generatorConfig, loadOpenApi } from '../src/openapi.js';
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
    if (token === 'Bearer missing-scopes') return context.json({ code: 'insufficient_scope', requiredScopes: ['user:org:read', 'tembo:read'] }, 403);
    if (token === 'Bearer untrusted-scopes') return context.json({ code: 'insufficient_scope', requiredScopes: ['admin:all'] }, 403);
    if (token === 'Bearer unavailable') return context.json({}, 503);
    if (token === 'Bearer malformed') return context.json({ unexpected: true });
    return context.json({
      userId: token === 'Bearer other-user' ? 'user_b' : 'user_a',
      organizationId: token === 'Bearer other-user' ? 'org_b' : 'org_a',
      clientId: 'client_test',
      scopes: ['user:org:read', 'tembo:read', ...(token === 'Bearer writer' ? ['tembo:write'] : [])],
      expiresAt: token === 'Bearer expired' ? 1 : Math.floor(Date.now() / 1000) + 3600,
    });
  });
  upstream.all('/public-api/*', async (context) => {
    const token = context.req.header('Authorization') ?? '';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(context.req.method) && token !== 'Bearer writer') return context.json({}, 403);
    requests.push({ method: context.req.method, path: context.req.path, query: new URL(context.req.url).search, token, body: ['POST', 'PUT', 'PATCH'].includes(context.req.method) ? await context.req.json() : undefined });
    if (context.req.path.endsWith('/forbidden')) return context.json({ token: 'secret-do-not-return', error: 'private internals' }, 403);
    return context.json({ ok: true });
  });
  await new Promise<void>((resolve) => { backend = serve({ fetch: upstream.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve()); });
  const address = backend.address();
  assert.ok(address && typeof address === 'object');
  config = loadConfig({ MCP_PUBLIC_URL: 'http://localhost:3000/mcp', MCP_OAUTH_ISSUER: 'https://clerk.example.com', TEMBO_API_URL: `http://127.0.0.1:${address.port}/public-api` });
  app = await createApp(config, await loadOpenApi(config));
});
beforeEach(() => { requests.length = 0; specResponse = spec; });
after(async () => { await new Promise<void>((resolve) => backend.close(() => resolve())); });

async function rpc(method: string, params: unknown = {}, token = 'reader') {
  return app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
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
    const response = await updated.request('/mcp', { method: 'POST', headers: { Authorization: 'Bearer writer', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal((await response.json()).result.tools.length, 11);
  });

  it('fails startup on empty or invalid specs instead of silently exposing partial coverage', async () => {
    for (const value of [{}, { openapi: '3.1.0', paths: {} }]) {
      specResponse = value;
      await assert.rejects(loadOpenApi(config));
    }
  });

  it('keeps full discovery while requiring write consent before a mutation reaches the API', async () => {
    const listed = await (await rpc('tools/list')).json();
    assert.equal(listed.result.tools.length, 10);
    const response = await rpc('tools/call', { name: toolName('DELETE', '/v1/widgets/{widgetId}'), arguments: { widgetId: 'widget-1' } });
    assert.equal(response.status, 403);
    assert.match(response.headers.get('www-authenticate') ?? '', /error="insufficient_scope"/);
    assert.match(response.headers.get('www-authenticate') ?? '', /scope="user:org:read tembo:read tembo:write"/);
    assert.deepEqual((await response.json()).requiredScopes, ['user:org:read', 'tembo:read', 'tembo:write']);
    assert.equal(requests.length, 0);
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
    assert.deepEqual(metadata.scopes_supported, ['user:org:read', 'tembo:read']);
  });
  it('challenges missing or malformed credentials', async () => {
    for (const authorization of ['', 'Basic test', 'Bearer token extra']) {
      const response = await app.request('/mcp', { method: 'POST', headers: { Authorization: authorization } });
      assert.equal(response.status, 401);
      assert.match(response.headers.get('www-authenticate') ?? '', /resource_metadata=/);
      assert.match(response.headers.get('www-authenticate') ?? '', /scope="user:org:read tembo:read"/);
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
    assert.match(response.headers.get('www-authenticate') ?? '', /scope="user:org:read tembo:read"/);
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
