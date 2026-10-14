import { mkdir, writeFile } from 'node:fs/promises';
import { createCatalog, validateOpenApi } from '../src/openapi.js';
import { normalizeOpenApi } from './normalize-openapi.js';

const source = process.env.TEMBO_OPENAPI_URL ?? 'https://api.tembo.io/public-api/openapi/public';
const apiUrl = process.env.TEMBO_API_URL ?? 'https://api.tembo.io';
const response = await fetch(source, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
if (!response.ok) throw new Error(`Could not fetch public OpenAPI (${response.status})`);
const content = `${JSON.stringify(normalizeOpenApi(await response.json()), null, 2)}\n`;
await validateOpenApi(content, apiUrl);
const catalog = await createCatalog(content, apiUrl);
await mkdir(new URL('../openapi/', import.meta.url), { recursive: true });
await writeFile(new URL('../openapi/openapi.json', import.meta.url), content);
console.log(`Updated bundled schema from ${source}: ${catalog.entries.length} operations.`);
