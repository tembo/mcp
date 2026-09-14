import { OpenAPIServer, ToolsManager } from '@ivotoby/openapi-mcp-server';
import type { OpenAPIMCPServerConfig } from '@ivotoby/openapi-mcp-server';
import type { Config } from './config.js';

export function generatorConfig(spec: string, apiUrl: string): OpenAPIMCPServerConfig {
  return {
    name: 'tembo',
    version: '0.2.0',
    apiBaseUrl: apiUrl,
    openApiSpec: '',
    specInputMethod: 'inline',
    inlineSpecContent: spec,
    transportType: 'http',
    toolsMode: 'all',
    verbose: false,
  };
}

export async function loadOpenApi(config: Config): Promise<string> {
  const response = await fetch(`${config.apiUrl}/openapi/public`, {
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Could not load public OpenAPI specification (${response.status})`);
  const spec: unknown = await response.json();
  if (!spec || typeof spec !== 'object' || !('openapi' in spec) || !('paths' in spec) || !spec.paths || typeof spec.paths !== 'object') {
    throw new Error('Invalid public OpenAPI specification');
  }
  const content = JSON.stringify(spec);
  const tools = new ToolsManager(generatorConfig(content, config.apiUrl));
  await tools.initialize();
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
  const operationCount = Object.values(spec.paths).reduce((count, path) =>
    count + Object.keys(path).filter((method) => methods.has(method)).length, 0);
  const generated = tools.getAllTools();
  if (!operationCount || generated.length !== operationCount || new Set(generated.map((tool) => tool.name)).size !== operationCount) {
    throw new Error('OpenAPI generation did not cover every public API operation');
  }
  return content;
}

export function createGeneratedServer(spec: string, apiUrl: string, token: string) {
  return new OpenAPIServer({
    ...generatorConfig(spec, apiUrl),
    headers: { Authorization: `Bearer ${token}` },
  });
}
