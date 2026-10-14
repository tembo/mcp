import { z } from 'zod';
import type { ApiCredentials } from './live.js';

export const EVENTS_URI_TEMPLATE = 'tembo://sessions/{sessionId}/events';
const deltaSchema = z.object({ type: z.literal('delta'), data: z.object({
  event: z.string().min(1), message: z.string(), provider: z.string().optional(),
  messageId: z.string().optional(), createdAt: z.string().optional(),
}) });
const frameSchema = z.union([
  z.object({ type: z.literal('ready'), id: z.string().optional() }),
  z.object({ type: z.literal('event'), id: z.string(), data: deltaSchema }),
  z.object({ type: z.literal('error'), id: z.string(), status: z.number().int(), message: z.string() }),
]);
type Delta = z.infer<typeof deltaSchema>;
type Entry = { cursor: number; bytes: number; truncated: boolean; gap: boolean; deltas: { cursor: number; data: Delta; bytes: number }[] };
const buffers = new Map<string, Entry>();
const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_BUFFER_DELTAS = 100;

function scopeKey(credentials: ApiCredentials, sessionId: string) {
  return JSON.stringify([credentials.apiUrl, credentials.token, credentials.agentOrganizationId, sessionId]);
}

function retain(credentials: ApiCredentials, sessionId: string) {
  const key = scopeKey(credentials, sessionId);
  const entry: Entry = { cursor: 0, bytes: 0, truncated: false, gap: false, deltas: [] };
  buffers.set(key, entry);
  let released = false;
  return {
    append(data: Delta) {
      if (released) return;
      const bytes = Buffer.byteLength(JSON.stringify(data));
      entry.cursor++;
      entry.deltas.push({ cursor: entry.cursor, data, bytes });
      entry.bytes += bytes;
      while (entry.bytes > MAX_BUFFER_BYTES || entry.deltas.length > MAX_BUFFER_DELTAS) {
        entry.bytes -= entry.deltas.shift()!.bytes;
        entry.truncated = true;
      }
    },
    gap() { entry.gap = true; },
    release() {
      if (released) return;
      released = true;
      if (buffers.get(key) === entry) buffers.delete(key);
    },
  };
}

export function liveEventSnapshot(credentials: ApiCredentials, sessionId: string) {
  const entry = buffers.get(scopeKey(credentials, sessionId));
  return { cursor: entry?.cursor ?? 0, truncated: entry?.truncated ?? false, gap: entry?.gap ?? false,
    deltas: entry?.deltas.map(({ cursor, data }) => ({ cursor, data })) ?? [] };
}

class LiveEventsError extends Error {
  constructor(public readonly status: number, message = 'Live session events unavailable') { super(message); }
}

async function issueTicket(credentials: ApiCredentials, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${credentials.apiUrl.replace(/\/$/, '')}/v1/live`, {
    method: 'POST', headers: { Authorization: `Bearer ${credentials.token}`,
      ...(credentials.agentOrganizationId ? { 'X-Agent-Org-Id': credentials.agentOrganizationId } : {}) },
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) throw new LiveEventsError(response.status);
  const result = z.object({ ticket: z.string().min(1) }).safeParse(await response.json());
  if (!result.success) throw new LiveEventsError(502);
  return result.data.ticket;
}

function connect(credentials: ApiCredentials, sessionId: string, ticket: string, onDelta: (delta: Delta) => void, signal: AbortSignal) {
  const url = new URL(`${credentials.apiUrl.replace(/\/$/, '')}/v1/live`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  return new Promise<{ socket: WebSocket; closed: Promise<Error | undefined> }>((resolve, reject) => {
    const socket = new WebSocket(url);
    let ready = false;
    let subscribed = false;
    let ended = false;
    let finish!: (error?: Error) => void;
    const closed = new Promise<Error | undefined>(done => { finish = done; });
    const abort = () => fail(new DOMException('Aborted', 'AbortError'));
    const fail = (error: Error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (!ready) reject(error);
      finish(error);
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    };
    const timer = setTimeout(() => fail(new Error('Live events connection timed out')), 15000);
    signal.addEventListener('abort', abort, { once: true });
    socket.addEventListener('message', event => {
      if (ended) return;
      let parsed;
      try { parsed = frameSchema.safeParse(JSON.parse(String(event.data))); } catch { return fail(new LiveEventsError(400, 'Invalid live frame')); }
      if (!parsed.success) return fail(new LiveEventsError(400, 'Invalid live frame'));
      const frame = parsed.data;
      if (frame.type === 'ready' && frame.id === undefined) {
        if (subscribed) return fail(new LiveEventsError(400, 'Repeated connection readiness'));
        subscribed = true;
        socket.send(JSON.stringify({ op: 'subscribe', id: 'events', resource: 'sessions.events', input: { scope: { sessionId } } }));
      } else if (frame.id === 'events') {
        if (frame.type === 'error') return fail(new LiveEventsError(frame.status, frame.message));
        if (frame.type === 'ready' && !ready) {
          ready = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          resolve({ socket, closed });
        } else if (frame.type === 'event') {
          if (!ready) return fail(new LiveEventsError(400, 'Event before subscription readiness'));
          onDelta(frame.data);
        }
      }
    });
    socket.addEventListener('error', () => fail(new Error('Live events connection failed')));
    socket.addEventListener('close', () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (!ready) reject(new Error('Live events connection closed before readiness'));
      finish();
    });
    if (signal.aborted) abort();
  });
}

function backoff(delay: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, delay);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function runSessionEvents(credentials: ApiCredentials, sessionId: string,
  handlers: { onChange: () => void; onEnd: () => void }, signal: AbortSignal): Promise<void> {
  const buffer = retain(credentials, sessionId);
  let connection: Awaited<ReturnType<typeof connect>> | undefined;
  let active = true;
  const stop = () => {
    if (!active) return;
    active = false;
    signal.removeEventListener('abort', stop);
    buffer.release();
    connection?.socket.close();
  };
  const open = async () => connect(credentials, sessionId, await issueTicket(credentials, signal), delta => {
    if (!active) return;
    buffer.append(delta);
    handlers.onChange();
  }, signal);
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    connection = await open();
    if (!active || signal.aborted) { connection.socket.close(); return; }
  } catch (error) {
    stop();
    throw error;
  }
  void (async () => {
    try {
      while (active) {
        const failure = await connection!.closed;
        if (!active) return;
        if (failure instanceof LiveEventsError && failure.status >= 400 && failure.status < 500 && failure.status !== 429) { stop(); handlers.onEnd(); return; }
        let delay = 1000;
        while (active) {
          await backoff(delay, signal);
          if (!active) return;
          try {
            connection = await open();
            if (!active) { connection.socket.close(); return; }
            buffer.gap();
            handlers.onChange();
            break;
          } catch (error) {
            if (!active) return;
            if (error instanceof LiveEventsError && error.status >= 400 && error.status < 500 && error.status !== 429) { stop(); handlers.onEnd(); return; }
            delay = Math.min(delay * 2, 30000);
          }
        }
      }
    } catch {
      if (active) { stop(); handlers.onEnd(); }
    }
  })();
}

type EventHandlers = { onChange: (uri: string) => void; onEnd: () => void };
type Observer = { handlers: EventHandlers; release: () => void };
type SharedWatch = { controller: AbortController; observers: Set<Observer>; ready: Promise<void>; ended: boolean };
const watches = new Map<string, SharedWatch>();

export async function watchSessionEvents(credentials: ApiCredentials, sessionId: string,
  handlers: EventHandlers, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const key = scopeKey(credentials, sessionId);
  let shared = watches.get(key);
  if (!shared) {
    shared = { controller: new AbortController(), observers: new Set(), ready: Promise.resolve(), ended: false };
    watches.set(key, shared);
    const current = shared;
    current.ready = runSessionEvents(credentials, sessionId, {
      onChange: () => {
        const notified = new Set<EventHandlers['onChange']>();
        for (const observer of current.observers) {
          if (notified.has(observer.handlers.onChange)) continue;
          notified.add(observer.handlers.onChange);
          observer.handlers.onChange(`tembo://sessions/${sessionId}/events`);
        }
      },
      onEnd: () => {
        current.ended = true;
        if (watches.get(key) === current) watches.delete(key);
        for (const observer of [...current.observers]) { observer.release(); observer.handlers.onEnd(); }
      },
    }, current.controller.signal);
  }
  const current = shared;
  let released = false;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', abort);
    current.observers.delete(observer);
    if (!current.observers.size && !current.ended) {
      if (watches.get(key) === current) watches.delete(key);
      current.controller.abort();
    }
  };
  const abort = () => { release(); rejectAbort(new DOMException('Aborted', 'AbortError')); };
  const observer = { handlers, release };
  current.observers.add(observer);
  signal.addEventListener('abort', abort, { once: true });
  try {
    await Promise.race([current.ready, aborted]);
    if (current.ended || signal.aborted || released) throw new Error('Live events ended during authorization');
  } catch (error) {
    release();
    throw error;
  }
}
