import { mkdir, writeFile } from 'node:fs/promises';
import { createCatalog, validateOpenApi } from '../src/openapi.js';

const source = 'https://api.tembo.io/public-api/openapi/public';
const response = await fetch(source, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
if (!response.ok) throw new Error(`Could not fetch public OpenAPI (${response.status})`);
const content = `${JSON.stringify(await response.json(), null, 2)}\n`;
await validateOpenApi(content, 'https://api.tembo.io');
const catalog = await createCatalog(content, 'https://api.tembo.io');
await mkdir(new URL('../openapi/', import.meta.url), { recursive: true });
await writeFile(new URL('../openapi/openapi.json', import.meta.url), content);
console.log(`Updated bundled schema from ${source}: ${catalog.entries.length} operations.`);
