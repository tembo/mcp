import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { loadOpenApi } from './openapi.js';

const config = loadConfig();
const openapi = await loadOpenApi(config);
const app = await createApp(config, openapi);
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
console.log(`Tembo MCP listening on ${config.host}:${config.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
