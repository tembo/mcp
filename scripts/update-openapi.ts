import { mkdir, writeFile } from 'node:fs/promises';
import { createCatalog, validateOpenApi } from '../src/openapi.js';
import { generateOpenApiDocs } from './generate-openapi-docs.js';
import { normalizeOpenApi } from './normalize-openapi.js';

const source = 'https://api.tembo.io/public-api/openapi/public';
const response = await fetch(source, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
if (!response.ok) throw new Error(`Could not fetch public OpenAPI (${response.status})`);
const content = `${JSON.stringify(normalizeOpenApi(await response.json()), null, 2)}\n`;
await validateOpenApi(content, 'https://api.tembo.io');
const catalog = await createCatalog(content, 'https://api.tembo.io');
await mkdir(new URL('../openapi/', import.meta.url), { recursive: true });
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
await writeFile(new URL('../openapi/openapi.json', import.meta.url), content);
await writeFile(new URL('../docs/api-reference.md', import.meta.url), await generateOpenApiDocs(content));
console.log(`Updated bundled schema and API reference from ${source}: ${catalog.entries.length} operations.`);
