import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateOpenApiDocs } from '../scripts/generate-openapi-docs.js';

test('generated API reference matches the bundled OpenAPI schema', async () => {
  const schema = await readFile(new URL('../openapi/openapi.json', import.meta.url), 'utf8');
  const reference = await readFile(new URL('../docs/api-reference.md', import.meta.url), 'utf8');
  assert.equal(reference, await generateOpenApiDocs(schema));
});
