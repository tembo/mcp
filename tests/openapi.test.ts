import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog, loadOpenApi } from '../src/openapi.js';
import { spec } from './spec.js';

it('loads the bundled catalog without a reachable API and generates stable names', async () => {
  const apiUrl = 'http://127.0.0.1:1';
  const content = await loadOpenApi({ apiUrl });
  const first = await createCatalog(content, apiUrl);
  const second = await createCatalog(content, apiUrl);
  assert.ok(first.entries.length > 0);
  assert.deepEqual([...first.byName.keys()], [...second.byName.keys()]);
});

it('loads an explicit local snapshot and fails closed on missing or invalid files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tembo-schema-'));
  const config = { apiUrl: 'http://127.0.0.1:1', schemaPath: join(directory, 'schema.json') };
  try {
    await assert.rejects(loadOpenApi(config));
    await writeFile(config.schemaPath, JSON.stringify(spec));
    assert.deepEqual(JSON.parse(await loadOpenApi(config)), spec);
    for (const content of ['not json', '{}', '{"openapi":"3.1.0","paths":{}}']) {
      await writeFile(config.schemaPath, content);
      await assert.rejects(loadOpenApi(config));
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});
