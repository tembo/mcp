import { ToolsManager } from '@ivotoby/openapi-mcp-server';
import { generatorConfig, loadOpenApi } from '../src/openapi.js';

const apiUrl = process.env.TEMBO_API_URL ?? 'https://api.tembo.io';
const spec = await loadOpenApi({ apiUrl, host: '127.0.0.1', port: 3000, publicUrl: 'http://localhost:3000/mcp', issuer: 'https://clerk.example.com' });
const manager = new ToolsManager(generatorConfig(spec, apiUrl));
await manager.initialize();
console.log(`Verified ${manager.getAllTools().length} public OpenAPI operations → ${manager.getAllTools().length} generated MCP tools.`);
