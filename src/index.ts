#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createApp } from './app.js';
import { loadConfig, loadStdioConfig } from './config.js';
import { createCatalog, loadOpenApi } from './openapi.js';
import { createServer } from './server.js';

async function main() {
  const { values } = parseArgs({ options: { transport: { type: 'string', default: 'stdio' }, 'allow-writes': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log('Usage: tembo-mcp [--transport stdio|http] [--allow-writes]\n\nstdio: TEMBO_API_KEY required; read-only unless --allow-writes.\nhttp: MCP_PUBLIC_URL and MCP_OAUTH_ISSUER required; Clerk OAuth grants access subject to API permissions.\nMCP_TOOL_MODE=compact (default) or all. TEMBO_API_URL defaults to https://api.tembo.io.\nUses the bundled OpenAPI snapshot; MCP_OPENAPI_PATH overrides it with a local file.');
    return;
  }
  if (!['http', 'stdio'].includes(values.transport)) throw new Error('Invalid transport');
  if (values.transport === 'http') {
    if (values['allow-writes']) throw new Error('HTTP writes require OAuth consent, not --allow-writes');
    const config = loadConfig();
    const app = await createApp(config, await loadOpenApi(config));
    const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
    console.error(`Tembo MCP listening on ${config.host}:${config.port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 10_000).unref();
      });
    }
  } else {
    const config = loadStdioConfig();
    const catalog = await createCatalog(await loadOpenApi(config), config.apiUrl);
    const server = serveStdio(() => createServer(catalog, { apiUrl: config.apiUrl, token: config.apiKey, mode: config.toolMode, allowWrites: values['allow-writes'] }), { onerror: () => console.error('MCP transport error') });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close().finally(() => process.exit(0)); });
  }
}

main().catch(() => {
  console.error('MCP startup failed. Check configuration and the OpenAPI snapshot; run --help for usage.');
  process.exitCode = 1;
});
