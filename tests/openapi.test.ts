import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog, loadOpenApi } from '../src/openapi.js';
import { spec } from './spec.js';
import { normalizeOpenApi } from '../scripts/normalize-openapi.js';

it('ignores generated response timestamps while preserving request defaults and API changes', () => {
  const schema = (timestamp: string, description = 'Created') => ({
    openapi: '3.1.0',
    paths: { '/test': { post: {
      requestBody: { content: { 'application/json': { schema: { type: 'string', default: '2026-01-01T00:00:00.000Z' } } } },
      responses: { '200': { description, content: { 'application/json': { schema: { type: 'object', properties: {
        createdAt: { type: 'string', default: timestamp },
        name: { type: 'string', default: 'untitled', example: { default: '2026-01-01T00:00:00.000Z' } },
      } } } } } },
    } } },
  });
  const first = schema('2026-01-01T00:00:00.000Z');
  const normalized = normalizeOpenApi(first) as typeof first;
  assert.deepEqual(normalized, normalizeOpenApi(schema('2026-01-02T00:00:00.000Z')));
  assert.notDeepEqual(normalized, normalizeOpenApi(schema('2026-01-02T00:00:00.000Z', 'Changed')));
  assert.deepEqual(normalized.paths['/test'].post.requestBody, first.paths['/test'].post.requestBody);
  assert.equal(normalized.paths['/test'].post.responses['200'].content['application/json'].schema.properties.name.default, 'untitled');
  assert.deepEqual(normalized.paths['/test'].post.responses['200'].content['application/json'].schema.properties.name.example, first.paths['/test'].post.responses['200'].content['application/json'].schema.properties.name.example);
  assert.equal(first.paths['/test'].post.responses['200'].content['application/json'].schema.properties.createdAt.default, '2026-01-01T00:00:00.000Z');
});

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
