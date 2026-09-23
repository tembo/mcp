import { z } from 'zod';

const urlWithoutSecrets = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    context.addIssue({ code: 'custom', message: 'Use HTTP(S) without credentials, query, or fragment' });
  }
});

const secureHttpUrl = urlWithoutSecrets.refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}, 'Use HTTPS, or HTTP on loopback');

const environmentSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MCP_PUBLIC_URL: urlWithoutSecrets,
  MCP_ALLOW_INSECURE_HTTP: z.stringbool().default(false),
  MCP_OAUTH_ISSUER: z.preprocess((value) => value === '' ? undefined : value, secureHttpUrl.refine((value) => new URL(value).protocol === 'https:' && new URL(value).pathname === '/', 'Use the Clerk HTTPS issuer origin').optional()),
  TEMBO_API_URL: secureHttpUrl.default('https://api.tembo.io'),
  MCP_TOOL_MODE: z.enum(['compact', 'all']).default('all'),
  MCP_OPENAPI_PATH: z.string().min(1).optional(),
  MCP_ALLOWED_ORIGINS: z.string().default(''),
});

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.parse(environment);
  if (new URL(parsed.MCP_PUBLIC_URL).pathname !== '/mcp') {
    throw new Error('MCP_PUBLIC_URL must end in /mcp (no trailing slash)');
  }
  const publicUrl = new URL(parsed.MCP_PUBLIC_URL);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
  if (publicUrl.protocol !== 'https:' && !loopback && (!parsed.MCP_ALLOW_INSECURE_HTTP || parsed.MCP_OAUTH_ISSUER)) {
    throw new Error('Non-loopback HTTP requires MCP_ALLOW_INSECURE_HTTP=true and OAuth disabled');
  }
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    publicUrl: parsed.MCP_PUBLIC_URL,
    issuer: parsed.MCP_OAUTH_ISSUER,
    apiUrl: parsed.TEMBO_API_URL.replace(/\/$/, ''),
    toolMode: parsed.MCP_TOOL_MODE,
    schemaPath: parsed.MCP_OPENAPI_PATH,
    allowedOrigins: [publicUrl.origin, ...parsed.MCP_ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean).map((value) => new URL(secureHttpUrl.parse(value)).origin)],
  };
}

export function loadStdioConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.pick({ TEMBO_API_URL: true, MCP_TOOL_MODE: true, MCP_OPENAPI_PATH: true }).extend({ TEMBO_API_KEY: z.string().min(1) }).parse(environment);
  return { apiUrl: parsed.TEMBO_API_URL.replace(/\/$/, ''), toolMode: parsed.MCP_TOOL_MODE, apiKey: parsed.TEMBO_API_KEY, schemaPath: parsed.MCP_OPENAPI_PATH };
}

export type Config = ReturnType<typeof loadConfig>;
