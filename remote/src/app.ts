import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ToolsManager, type ExtendedTool } from '@ivotoby/openapi-mcp-server';
import { AuthenticationError, BASE_SCOPES, verifyIdentity } from './api.js';
import type { Config } from './config.js';
import { createGeneratedServer, generatorConfig } from './openapi.js';

export async function createApp(config: Config, openapi: string) {
  const app = new Hono();
  const publicUrl = new URL(config.publicUrl);
  const metadataUrl = `${publicUrl.origin}/.well-known/oauth-protected-resource/mcp`;
  const tools = new ToolsManager(generatorConfig(openapi, config.apiUrl));
  await tools.initialize();
  const catalog = new Map((tools.getAllTools() as ExtendedTool[]).map((tool) => [tool.name, tool]));
  const challenge = (error?: string, scopes?: string[]) => [
    `Bearer resource_metadata="${metadataUrl}"`,
    ...(error ? [`error="${error}"`] : []),
    ...(scopes ? [`scope="${scopes.join(' ')}"`] : []),
  ].join(', ');

  app.use('*', cors({
    origin: publicUrl.origin,
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version', 'Mcp-Session-Id'],
    exposeHeaders: ['WWW-Authenticate', 'MCP-Protocol-Version'],
  }));
  app.get('/health', (context) => context.json({ status: 'ok' }));

  const metadata = {
    resource: config.publicUrl,
    authorization_servers: [config.issuer],
    scopes_supported: BASE_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Tembo',
  };
  app.get('/.well-known/oauth-protected-resource/mcp', (context) => context.json(metadata));
  app.get('/.well-known/oauth-protected-resource', (context) => context.json(metadata));

  app.use('/mcp', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('/mcp', bodyLimit({
    maxSize: 256 * 1024,
    onError: (context) => context.json({ error: 'Request body too large' }, 413),
  }));
  app.all('/mcp', async (context) => {
    const origin = context.req.header('Origin');
    if (origin && origin !== publicUrl.origin) return context.json({ error: 'Origin not allowed' }, 403);
    if (!['POST', 'GET', 'DELETE'].includes(context.req.method)) {
      context.header('Allow', 'POST, GET, DELETE, OPTIONS');
      return context.json({ error: 'Method not allowed' }, 405);
    }
    if (['access_token', 'token', 'state'].some((name) => context.req.query(name) !== undefined)) {
      context.header('WWW-Authenticate', challenge('invalid_request'));
      return context.json({ error: 'OAuth credentials must use a Bearer header' }, 400);
    }
    const token = context.req.header('Authorization')?.match(/^Bearer +([^\s]+)$/i)?.[1];
    if (!token) {
      context.header('WWW-Authenticate', challenge(undefined, BASE_SCOPES));
      return context.json({ error: 'Connect with your Tembo account' }, 401);
    }

    let identity;
    try {
      identity = await verifyIdentity(config.apiUrl, token);
    } catch (error) {
      const status = error instanceof AuthenticationError ? error.status : 503;
      if (status === 401) context.header('WWW-Authenticate', challenge('invalid_token', BASE_SCOPES));
      if (error instanceof AuthenticationError && error.requiredScopes) {
        context.header('WWW-Authenticate', challenge('insufficient_scope', error.requiredScopes));
      }
      return context.json({ error: status === 503 ? 'Tembo authentication temporarily unavailable' : 'Tembo authorization required' }, status);
    }

    if (context.req.method === 'POST') {
      const request = CallToolRequestSchema.safeParse(await context.req.raw.clone().json().catch(() => null));
      const tool = request.success ? catalog.get(request.data.params.name) : undefined;
      if (tool && !['get', 'head', 'options'].includes(tool.httpMethod?.toLowerCase() ?? '') && !identity.scopes.includes('tembo:write')) {
        const requiredScopes = [...BASE_SCOPES, 'tembo:write'];
        context.header('WWW-Authenticate', challenge('insufficient_scope', requiredScopes));
        return context.json({ error: 'Write access requires explicit consent', code: 'insufficient_scope', requiredScopes }, 403);
      }
    }

    const server = createGeneratedServer(openapi, config.apiUrl, token);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.start(transport);
      return await transport.handleRequest(context.req.raw, {
        authInfo: {
          token,
          clientId: identity.clientId,
          scopes: identity.scopes,
          expiresAt: identity.expiresAt,
          resource: publicUrl,
          extra: { userId: identity.userId, organizationId: identity.organizationId },
        },
      });
    } finally {
      await transport.close();
    }
  });
  app.onError(() => new Response('Internal server error', { status: 500 }));
  return app;
}
