import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const token = process.env.TEMBO_API_KEY;
const sessionId = process.env.TEMBO_TEST_SESSION_ID;
if (!token || !sessionId) throw new Error('Set TEMBO_API_KEY and TEMBO_TEST_SESSION_ID to a dedicated dev test session.');
const apiUrl = process.env.TEMBO_API_URL ?? 'https://internal.tembo-development.com/public-api';
const runAgent = process.env.RUN_AGENT === '1';
const forceReconnect = process.env.FORCE_RECONNECT === '1' && runAgent;
if (forceReconnect) await import('./dev-reconnect.js');
const directory = await mkdtemp(join(tmpdir(), 'tembo-dev-live-'));
const schemaPath = join(directory, 'openapi.json');
const schema = process.env.MCP_OPENAPI_PATH ? await readFile(process.env.MCP_OPENAPI_PATH, 'utf8') : await (async () => {
  const response = await fetch(`${apiUrl}/openapi/public`, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  return response.text();
})();
await writeFile(schemaPath, schema);
const uri = `tembo://sessions/${sessionId}/events`;
let server: ReturnType<typeof serve> | undefined;
try {
  const app = await createApp(loadConfig({ MCP_PUBLIC_URL: 'http://localhost:3000/mcp', TEMBO_API_URL: apiUrl }), schema);
  await new Promise<void>(resolve => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve()); });
  const address = server!.address(); assert.ok(address && typeof address === 'object');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  for (const mode of ['http', 'stdio'] as const) {
    const client = new Client({ name: 'dev-live-validation', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const transport = mode === 'http' ? new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
      : new StdioClientTransport({ command: process.execPath, args: [...(forceReconnect ? ['--import', 'tsx', '--import', join(process.cwd(), 'scripts/dev-reconnect.ts')] : []), 'dist/index.js', ...(runAgent ? ['--allow-writes'] : [])], cwd: process.cwd(),
        env: { TEMBO_API_KEY: token, TEMBO_API_URL: apiUrl, MCP_OPENAPI_PATH: schemaPath }, stderr: 'pipe' });
    let subscription: Awaited<ReturnType<Client['listen']>> | undefined;
    let messageId: string | undefined;
    let updates = 0;
    client.setNotificationHandler('notifications/resources/updated', notification => { if (notification.params.uri === uri) updates++; });
    try {
      await client.connect(transport);
      assert.ok((await client.listResourceTemplates()).resourceTemplates.some(template => template.uriTemplate === 'tembo://sessions/{sessionId}/events'));
      subscription = await client.listen({ resourceSubscriptions: [uri] });
      console.log(`PASS dev MCP ${mode} subscription authorized`);
      await assert.rejects(client.listen({ resourceSubscriptions: ['tembo://sessions/00000000-0000-4000-8000-000000000000/events'] }));
      console.log(`PASS dev MCP ${mode} missing-session subscription refused`);
      if (!runAgent) continue;
      let cursor = 0;
      for (let round = 0; round < (forceReconnect ? 2 : 1); round++) {
        const marker = `LIVE_API_MCP_${mode.toUpperCase()}_${round ? 'RECONNECTED_' : ''}OK`;
        const sent = await client.callTool({ name: 'create-message', arguments: { sessionId, content: `Reply with exactly ${marker}. Do not use tools. This tests public MCP live output.` } });
        assert.notEqual(sent.isError, true);
        messageId = z.object({ data: z.object({ message: z.object({ id: z.string() }) }) }).parse(sent.structuredContent).data.message.id;
        const deadline = Date.now() + 180000;
        let output = '';
        let completed = false;
        while (!completed && Date.now() < deadline) {
          if (!updates) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
          const result = await client.readResource({ uri });
          const content = result.contents[0]; assert.ok(content && 'text' in content);
          const snapshot = JSON.parse(content.text);
          assert.equal(snapshot.live.truncated, false);
          for (const frame of snapshot.live.deltas) {
            if (frame.cursor <= cursor) continue;
            cursor = frame.cursor;
            if (frame.data.data.messageId !== messageId) continue;
            if (frame.data.data.event === 'response.output_text.delta') output += JSON.parse(frame.data.data.message).delta;
            if (frame.data.data.event === 'response.completed') completed = true;
          }
          if (!completed) await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(completed, 'MCP live test timed out before expected output');
        assert.equal(output.trim(), marker);
        assert.ok(cursor > 0 && updates > 0);
        console.log(`PASS real MCP ${mode} token stream (${messageId}, ${updates} notifications)`);
        if (forceReconnect && round === 0) {
          const deadline = Date.now() + 15000;
          let gap = false;
          while (!gap && Date.now() < deadline) {
            const result = await client.readResource({ uri });
            const content = result.contents[0]; assert.ok(content && 'text' in content);
            gap = JSON.parse(content.text).live.gap;
            if (!gap) await new Promise(resolve => setTimeout(resolve, 50));
          }
          assert.ok(gap, 'MCP did not reconnect and mark the stream gap');
          console.log(`PASS real MCP ${mode} reconnect reauthorizes and resubscribes`);
        }
      }
    } finally {
      await subscription?.close();
      if (messageId) {
        const stopped = await client.callTool({ name: 'stop-session', arguments: { sessionId, cancelQueued: true } });
        assert.notEqual(stopped.isError, true);
      }
      await client.close();
    }
  }
} finally {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true });
}
