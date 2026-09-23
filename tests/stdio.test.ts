import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Hono } from 'hono';
import { spec } from './spec.js';

let backend: ReturnType<typeof serve>;
let apiUrl: string;
let directory: string;
let schemaPath: string;
const requests: { authorization: string | undefined; method: string }[] = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tembo-mcp-'));
  schemaPath = join(directory, 'openapi.json');
  await writeFile(schemaPath, JSON.stringify(spec));
  const app = new Hono();
  app.all('*', (context) => {
    requests.push({ authorization: context.req.header('Authorization'), method: context.req.method });
    return context.json({ ok: true });
  });
  await new Promise<void>((resolve) => { backend = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve()); });
  const address = backend.address();
  assert.ok(address && typeof address === 'object');
  apiUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => { await new Promise<void>((resolve) => backend.close(() => resolve())); await rm(directory, { recursive: true }); });

for (const modern of [false, true]) {
  it(`runs the canonical CLI over ${modern ? 'current' : 'legacy'} stdio without protocol noise`, async () => {
    const client = new Client({ name: 'stdio-test', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'], cwd: process.cwd(), env: { TEMBO_API_KEY: 'test-only-key', TEMBO_API_URL: apiUrl, MCP_OPENAPI_PATH: schemaPath }, stderr: 'pipe' });
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), modern ? 'modern' : 'legacy');
      assert.equal((await client.listTools()).tools.length, 10);
      assert.equal((await client.callTool({ name: 'create-widget', arguments: { content: 'blocked' } })).isError, true);
      assert.deepEqual((await client.callTool({ name: 'list-widgets' })).structuredContent, { data: { ok: true } });
      assert.equal(requests.at(-1)?.authorization, 'Bearer test-only-key');
      assert.ok(requests.every((request) => request.method === 'GET'));
    } finally { await client.close(); }
  });
}

it('allows local mutations only with the explicit CLI flag', async () => {
  const client = new Client({ name: 'stdio-writer', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts', '--allow-writes'], cwd: process.cwd(), env: { TEMBO_API_KEY: 'test-only-key', TEMBO_API_URL: apiUrl, MCP_OPENAPI_PATH: schemaPath }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'create-widget', arguments: { content: 'allowed' } });
    assert.deepEqual(result.structuredContent, { data: { ok: true } });
    assert.equal(requests.at(-1)?.method, 'POST');
  } finally { await client.close(); }
});
