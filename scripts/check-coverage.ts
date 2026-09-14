import { createCatalog, loadOpenApi } from '../src/openapi.js';

const apiUrl = process.env.TEMBO_API_URL ?? 'https://api.tembo.io';
const spec = await loadOpenApi({ apiUrl });
const catalog = await createCatalog(spec, apiUrl);
console.log(`Verified ${catalog.entries.length} public OpenAPI operations → ${catalog.entries.length} generated MCP tools.`);
