import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { AuthenticationError, BASE_SCOPES, verifyIdentity } from './api.js';
import type { Config } from './config.js';
import { sessionIdFromUri, startLiveSubscriptions } from './live.js';
import { createCatalog } from './openapi.js';
import { createServer } from './server.js';

const MAX_MCP_REQUEST_SIZE = 12 * 1024 * 1024;

export async function createApp(config: Config, openapi: string) {
  const app = new Hono();
  const publicUrl = new URL(config.publicUrl);
  const metadataUrl = `${publicUrl.origin}/.well-known/oauth-protected-resource/mcp`;
  const catalog = await createCatalog(openapi, config.apiUrl);
  const handler = createMcpHandler(({ authInfo }) => {
    if (!authInfo) throw new Error('Missing verified identity');
    return createServer(catalog, { apiUrl: config.apiUrl, token: authInfo.token, mode: config.toolMode, allowWrites: true,
      agentOrganizationId: typeof authInfo.extra?.agentOrganizationId === 'string' ? authInfo.extra.agentOrganizationId : undefined });
  });
  const challenge = (error?: string, scopes?: string[]) => [
    config.issuer ? `Bearer resource_metadata="${metadataUrl}"` : 'Bearer realm="tembo"',
    ...(error ? [`error="${error}"`] : []),
    ...(config.issuer && scopes ? [`scope="${scopes.join(' ')}"`] : []),
  ].join(', ');

  app.use('*', cors({
    origin: config.allowedOrigins,
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name', 'Mcp-Session-Id'],
    exposeHeaders: ['WWW-Authenticate', 'MCP-Protocol-Version'],
  }));
  app.get('/health', (context) => context.json({ status: 'ok' }));

  if (config.issuer) {
    const metadata = {
      resource: config.publicUrl,
      authorization_servers: [config.issuer],
      scopes_supported: BASE_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'Tembo',
    };
    app.get('/.well-known/oauth-protected-resource/mcp', (context) => context.json(metadata));
    app.get('/.well-known/oauth-protected-resource', (context) => context.json(metadata));
  }

  app.use('/mcp', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    await next();
    context.header('Cache-Control', 'no-store');
  });
  app.use('/mcp', bodyLimit({
    maxSize: MAX_MCP_REQUEST_SIZE,
    onError: (context) => context.json({ error: 'Request body too large' }, 413),
  }));
  app.all('/mcp', async (context) => {
    const origin = context.req.header('Origin');
    if (origin && !config.allowedOrigins.includes(origin)) return context.json({ error: 'Origin not allowed' }, 403);
    if (!['POST', 'GET', 'DELETE'].includes(context.req.method)) {
      context.header('Allow', 'POST, GET, DELETE, OPTIONS');
      return context.json({ error: 'Method not allowed' }, 405);
    }
    if (['access_token', 'token', 'state', 'apiKey'].some((name) => context.req.query(name) !== undefined)) {
      context.header('WWW-Authenticate', challenge('invalid_request'));
      return context.json({ error: 'Credentials must use a Bearer header' }, 400);
    }
    const token = context.req.header('Authorization')?.match(/^Bearer +([^\s]+)$/i)?.[1];
    if (!token) {
      context.header('WWW-Authenticate', challenge(undefined, BASE_SCOPES));
      return context.json({ error: config.issuer ? 'Connect with your Tembo account or provide a bearer credential' : 'Provide a Tembo API key or agent bearer credential' }, 401);
    }

    let identity;
    try {
      identity = await verifyIdentity(config.apiUrl, token, context.req.header('X-Agent-Org-Id'));
      if (!config.issuer && Object.hasOwn(identity, 'clientId')) throw new AuthenticationError(401);
    } catch (error) {
      const status = error instanceof AuthenticationError ? error.status : 503;
      if (status === 401) context.header('WWW-Authenticate', challenge('invalid_token', BASE_SCOPES));
      if (error instanceof AuthenticationError && error.requiredScopes) {
        context.header('WWW-Authenticate', challenge('insufficient_scope', error.requiredScopes));
      }
      return context.json({ error: status === 503 ? 'Tembo authentication temporarily unavailable' : 'Tembo authorization required' }, status);
    }

    const authInfo = {
      token,
      clientId: 'clientId' in identity ? identity.clientId : 'principal' in identity ? 'tembo-agent' : 'tembo-api-key',
      scopes: 'scopes' in identity ? identity.scopes : [],
      ...('expiresAt' in identity ? { expiresAt: identity.expiresAt } : {}),
      resource: publicUrl,
      extra: { ...('userId' in identity ? { userId: identity.userId } : {}), organizationId: identity.organizationId,
        ...('principal' in identity ? { agentOrganizationId: identity.organizationId } : {}) },
    };
    const mcpMethod = context.req.header('Mcp-Method');
    const listen = context.req.method === 'POST' && (!mcpMethod || mcpMethod === 'subscriptions/listen') ? await readLiveListen(context.req.raw) : undefined;
    if (!listen) return handler.fetch(context.req.raw, { authInfo });

    const controller = new AbortController();
    context.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true });
    const credentials = { apiUrl: config.apiUrl, token, ...('principal' in identity ? { agentOrganizationId: identity.organizationId } : {}) };
    const error = await startLiveSubscriptions(credentials, listen.uris, {
      onChange: (uri) => handler.notify.resourceUpdated(uri),
      onEnd: () => controller.abort(),
    }, controller.signal);
    if (error) return context.json({ jsonrpc: '2.0', id: listen.id, error: { code: -32602, message: error } });
    const response = await handler.fetch(new Request(context.req.raw, { signal: controller.signal }), { authInfo });
    return releaseWith(response, controller);
  });
  app.onError(() => new Response('Internal server error', { status: 500 }));
  return app;
}

/** A `subscriptions/listen` request naming Tembo message resources, which need an upstream watcher. */
async function readLiveListen(request: Request): Promise<{ id: unknown; uris: string[] } | undefined> {
  const message: unknown = await request.clone().json().catch(() => undefined);
  if (!message || typeof message !== 'object' || !('method' in message) || message.method !== 'subscriptions/listen' || !('params' in message)) return undefined;
  const params = message.params;
  const notifications = params && typeof params === 'object' && 'notifications' in params ? params.notifications : undefined;
  const requested = notifications && typeof notifications === 'object' && 'resourceSubscriptions' in notifications ? notifications.resourceSubscriptions : undefined;
  const uris = Array.isArray(requested) ? requested.filter((uri): uri is string => typeof uri === 'string' && Boolean(sessionIdFromUri(uri))) : [];
  return uris.length ? { id: 'id' in message ? message.id : null, uris } : undefined;
}

/** Stops the subscription's upstream watchers when its response stream ends or is cancelled. */
function releaseWith(response: Response, controller: AbortController): Response {
  if (!response.body) {
    controller.abort();
    return response;
  }
  const reader = response.body.getReader();
  return new Response(new ReadableStream({
    async pull(stream) {
      const { done, value } = await reader.read();
      if (done) {
        controller.abort();
        stream.close();
      } else {
        stream.enqueue(value);
      }
    },
    cancel(reason) {
      controller.abort();
      return reader.cancel(reason);
    },
  }), response);
}
