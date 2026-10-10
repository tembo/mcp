import type { Transport } from '@modelcontextprotocol/server';

export const MESSAGES_URI_TEMPLATE = 'tembo://sessions/{sessionId}/messages';
export const MAX_LIVE_SUBSCRIPTIONS = 10;
const messagesUri = /^tembo:\/\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/messages$/;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export type ApiCredentials = { apiUrl: string; token: string; agentOrganizationId?: string };

export function sessionIdFromUri(uri: string): string | undefined {
  return messagesUri.exec(uri)?.[1];
}

export class LiveAuthorizationError extends Error {
  constructor(public readonly status: number) {
    super('Live message authorization failed');
  }
}

async function issueTicket(credentials: ApiCredentials, sessionId: string): Promise<string> {
  const response = await fetch(`${credentials.apiUrl.replace(/\/$/, '')}/v1/messages/live`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      'Content-Type': 'application/json',
      ...(credentials.agentOrganizationId ? { 'X-Agent-Org-Id': credentials.agentOrganizationId } : {}),
    },
    body: JSON.stringify({ scope: { sessionId } }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new LiveAuthorizationError(response.status);
  const body: unknown = await response.json().catch(() => null);
  const ticket = body && typeof body === 'object' && 'ticket' in body ? body.ticket : undefined;
  if (typeof ticket !== 'string' || !ticket) throw new LiveAuthorizationError(502);
  return ticket;
}

function connect(credentials: ApiCredentials, sessionId: string, ticket: string, onChange: () => void): Promise<WebSocket> {
  const url = new URL(`${credentials.apiUrl.replace(/\/$/, '')}/v1/messages/live`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => socket.close(), 15_000);
    socket.addEventListener('message', (event) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!frame || typeof frame !== 'object') return;
      if ('type' in frame && frame.type === 'ready') {
        clearTimeout(timer);
        resolve(socket);
      } else if ('resource' in frame && frame.resource === 'message' && 'sessionId' in frame && frame.sessionId === sessionId) {
        onChange();
      }
    });
    // A rejected upgrade (for example a 401) fires `error` without `close` on Node 22.
    const fail = () => {
      clearTimeout(timer);
      if (socket.readyState !== WebSocket.CLOSED) socket.close();
      reject(new Error('Live message connection failed'));
    };
    socket.addEventListener('error', fail, { once: true });
    socket.addEventListener('close', fail, { once: true });
  });
}

/**
 * Watches persisted message changes for one session through the API's live WebSocket.
 * Resolves once the first connection is authorized and ready, and rejects if it is not.
 * Afterwards it reconnects with backoff until `signal` aborts, reporting a change after each
 * reconnect so readers reconcile anything missed, and calls `onEnd` if access is revoked.
 */
export async function watchSessionMessages(
  credentials: ApiCredentials,
  sessionId: string,
  handlers: { onChange: () => void; onEnd: () => void },
  signal: AbortSignal,
): Promise<void> {
  let socket = await connect(credentials, sessionId, await issueTicket(credentials, sessionId), handlers.onChange);
  const close = () => socket.close(1000);
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) return close();
  void (async () => {
    let delay = RETRY_MIN_MS;
    while (!signal.aborted) {
      if (socket.readyState !== WebSocket.CLOSED) await new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (signal.aborted) return;
        try {
          socket = await connect(credentials, sessionId, await issueTicket(credentials, sessionId), handlers.onChange);
          if (signal.aborted) return close();
          delay = RETRY_MIN_MS;
          handlers.onChange();
          break;
        } catch (error) {
          if (error instanceof LiveAuthorizationError && [401, 403, 404].includes(error.status)) {
            signal.removeEventListener('abort', close);
            return handlers.onEnd();
          }
          delay = Math.min(delay * 2, RETRY_MAX_MS);
        }
      }
    }
  })();
}

/**
 * Starts watchers for every Tembo messages URI in `uris` with the caller's credentials.
 * Returns an error message, after stopping anything started, if the set is too large or the
 * caller cannot watch one of the sessions. Other URIs are left to the MCP SDK as usual.
 */
export async function startLiveSubscriptions(
  credentials: ApiCredentials,
  uris: string[],
  handlers: { onChange: (uri: string) => void; onEnd: () => void },
  signal: AbortSignal,
): Promise<string | undefined> {
  const watched = [...new Set(uris)].filter((uri) => sessionIdFromUri(uri));
  if (watched.length > MAX_LIVE_SUBSCRIPTIONS) return `At most ${MAX_LIVE_SUBSCRIPTIONS} Tembo message subscriptions are allowed per request`;
  const controller = new AbortController();
  signal.addEventListener('abort', () => controller.abort(), { once: true });
  const results = await Promise.allSettled(watched.map((uri) =>
    watchSessionMessages(credentials, sessionIdFromUri(uri)!, { onChange: () => handlers.onChange(uri), onEnd: handlers.onEnd }, controller.signal)));
  const failed = results.findIndex((result) => result.status === 'rejected');
  if (failed === -1) return undefined;
  controller.abort();
  return `Cannot subscribe to ${watched[failed]}: session not found or live updates unavailable`;
}

/**
 * Wraps a stdio transport so Tembo message subscriptions get upstream watchers. Listen requests
 * (2026-07-28) are authorized here and then served by the SDK; 2025-era resources/subscribe and
 * unsubscribe are answered here. `notify` must emit through the connection's server instance.
 */
export function withLiveSubscriptions(inner: Transport, credentials: ApiCredentials, notify: (uri: string) => void): Transport {
  const subscriptions = new Map<string, AbortController>();
  const stop = (key: string) => {
    subscriptions.get(key)?.abort();
    subscriptions.delete(key);
  };
  const stopAll = () => [...subscriptions.keys()].forEach(stop);
  const subscribe = async (key: string, uris: string[], onEnd?: () => void) => {
    stop(key);
    const controller = new AbortController();
    subscriptions.set(key, controller);
    const error = await startLiveSubscriptions(credentials, uris, {
      onChange: notify,
      onEnd: () => {
        stop(key);
        onEnd?.();
      },
    }, controller.signal);
    if (error) stop(key);
    return error;
  };
  const reply = (id: string | number, error?: string) => inner.send(error
    ? { jsonrpc: '2.0', id, error: { code: -32602, message: error } }
    : { jsonrpc: '2.0', id, result: {} });

  const outer: Transport = {
    start: () => inner.start(),
    send: (message, options) => inner.send(message, options),
    close: async () => {
      stopAll();
      await inner.close();
    },
    ...(inner.setProtocolVersion ? { setProtocolVersion: (version: string) => inner.setProtocolVersion?.(version) } : {}),
  };
  let queue = Promise.resolve();
  inner.onmessage = (message, extra) => {
    queue = queue.then(async () => {
      const method = 'method' in message ? message.method : undefined;
      const id = 'id' in message ? message.id : undefined;
      const params: Record<string, unknown> = 'params' in message && message.params && typeof message.params === 'object' ? message.params : {};
      if (method === 'subscriptions/listen' && id !== undefined) {
        const notifications = params.notifications;
        const requested = notifications && typeof notifications === 'object' && 'resourceSubscriptions' in notifications ? notifications.resourceSubscriptions : undefined;
        const uris = Array.isArray(requested) ? requested.filter((uri): uri is string => typeof uri === 'string' && Boolean(sessionIdFromUri(uri))) : [];
        if (uris.length) {
          // If access is revoked, cancel the SDK's subscription and send the terminal listen result
          // so the client sees the subscription close instead of silently receiving nothing.
          const error = await subscribe(`listen:${String(id)}`, uris, () => {
            outer.onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
            void inner.send({ jsonrpc: '2.0', id, result: { resultType: 'complete', _meta: { 'io.modelcontextprotocol/subscriptionId': id } } })
              .catch((sendError: unknown) => outer.onerror?.(sendError instanceof Error ? sendError : new Error(String(sendError))));
          });
          if (error) return void await reply(id, error);
        }
      } else if (method === 'notifications/cancelled' && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) {
        stop(`listen:${String(params.requestId)}`);
      } else if ((method === 'resources/subscribe' || method === 'resources/unsubscribe') && id !== undefined && typeof params.uri === 'string' && sessionIdFromUri(params.uri)) {
        if (method === 'resources/unsubscribe') {
          stop(`resource:${params.uri}`);
          return void await reply(id);
        }
        return void await reply(id, await subscribe(`resource:${params.uri}`, [params.uri]));
      }
      outer.onmessage?.(message, extra);
    }).catch((error: unknown) => outer.onerror?.(error instanceof Error ? error : new Error(String(error))));
  };
  inner.onclose = () => {
    stopAll();
    outer.onclose?.();
  };
  inner.onerror = (error) => outer.onerror?.(error);
  return outer;
}
