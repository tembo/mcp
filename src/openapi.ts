import { ToolsManager } from '@ivotoby/openapi-mcp-server';
import { readFile } from 'node:fs/promises';
import type { ExtendedTool, OpenAPIMCPServerConfig } from '@ivotoby/openapi-mcp-server';
import type { Tool } from '@modelcontextprotocol/server';
import { ToolSchema } from '@modelcontextprotocol/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import type { Config } from './config.js';
import { VERSION } from './version.js';

export function generatorConfig(spec: string, apiUrl: string): OpenAPIMCPServerConfig {
  return {
    name: 'tembo',
    version: VERSION,
    apiBaseUrl: apiUrl,
    openApiSpec: '',
    specInputMethod: 'inline',
    inlineSpecContent: spec,
    transportType: 'http',
    toolsMode: 'all',
    disableAbbreviation: true,
    verbose: false,
  };
}

export async function loadOpenApi(config: Pick<Config, 'apiUrl'> & { schemaPath?: string }): Promise<string> {
  const content = await readFile(config.schemaPath ?? new URL('../openapi/openapi.json', import.meta.url), 'utf8');
  await validateOpenApi(content, config.apiUrl);
  return content;
}

export async function validateOpenApi(content: string, apiUrl: string): Promise<void> {
  const spec: unknown = JSON.parse(content);
  if (!spec || typeof spec !== 'object' || !('openapi' in spec) || !('paths' in spec) || !spec.paths || typeof spec.paths !== 'object') {
    throw new Error('Invalid public OpenAPI specification');
  }
  const tools = new ToolsManager(generatorConfig(content, apiUrl));
  await tools.initialize();
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
  const operationCount = Object.values(spec.paths).reduce((count, path) =>
    count + Object.keys(path).filter((method) => methods.has(method)).length, 0);
  const generated = tools.getAllTools();
  if (!operationCount || generated.length !== operationCount || new Set(generated.map((tool) => tool.name)).size !== operationCount) {
    throw new Error('OpenAPI generation did not cover every public API operation');
  }
}

export async function createCatalog(spec: string, apiUrl: string) {
  const manager = new ToolsManager(generatorConfig(spec, apiUrl));
  await manager.initialize();
  const validator = new AjvJsonSchemaValidator();
  const entries = manager.getToolsWithIds().map(([id, generated]) => {
    const original = generated as ExtendedTool;
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(original.name)) throw new Error('Invalid generated operation name');
    const method = original.httpMethod?.toUpperCase();
    const path = original.originalPath;
    if (!method || !['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !path?.startsWith('/') || path.startsWith('//') || /[\\?#]/.test(path)) {
      throw new Error('Unsupported public API operation');
    }
    const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(method);
    const operation = manager.getOpenApiSpec()?.paths[path]?.[method.toLowerCase() as 'delete'];
    const hasRequestBody = Boolean(operation && 'requestBody' in operation && operation.requestBody);
    const inputSchema = normalizeInputSchema(original.inputSchema);
    const tool: Tool = ToolSchema.parse({
      name: original.name,
      description: original.description ?? `${method} ${path}`,
      inputSchema,
      outputSchema: { type: 'object', properties: { data: {} }, required: ['data'], additionalProperties: false },
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true },
    });
    return { id, tool, executionTool: { ...original, inputSchema: inputSchema as ExtendedTool['inputSchema'] }, method, path, readOnly, hasRequestBody, validate: validator.getValidator<Record<string, unknown>>(tool.inputSchema as Parameters<AjvJsonSchemaValidator['getValidator']>[0]) };
  });
  const byName = new Map(entries.map((entry) => [entry.tool.name, entry]));
  if (!entries.length || byName.size !== entries.length) throw new Error('Invalid generated tool catalog');
  return { manager, entries, byName };
}

export type Catalog = Awaited<ReturnType<typeof createCatalog>>;

function normalizeInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  const collect = (value: Record<string, unknown>) => {
    if (value.properties && typeof value.properties === 'object') {
      for (const [name, property] of Object.entries(value.properties)) {
        if (property && typeof property === 'object' && 'x-parameter-location' in property) parameters[name] = property;
      }
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      if (Array.isArray(value[keyword])) for (const branch of value[keyword]) if (branch && typeof branch === 'object') collect(branch);
    }
  };
  collect(schema);
  const extend = (value: Record<string, unknown>): Record<string, unknown> => {
    const result = { ...value };
    if (value.type === 'object' && Object.keys(parameters).length) result.properties = { ...parameters, ...(value.properties as Record<string, unknown> | undefined) };
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      if (Array.isArray(value[keyword])) result[keyword] = value[keyword].map((branch) => branch && typeof branch === 'object' ? extend(branch) : branch);
    }
    return result;
  };
  return { type: 'object', ...extend(schema), properties: { ...parameters, ...(schema.properties as Record<string, unknown> | undefined) } };
}
