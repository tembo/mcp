import { z } from 'zod';

const httpUrl = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    context.addIssue({ code: 'custom', message: 'Use HTTPS, or HTTP on loopback, without credentials, query, or fragment' });
  }
});

const environmentSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MCP_PUBLIC_URL: httpUrl,
  MCP_OAUTH_ISSUER: httpUrl.refine((value) => new URL(value).protocol === 'https:' && new URL(value).pathname === '/', 'Use the Clerk HTTPS issuer origin'),
  TEMBO_API_URL: httpUrl.default('https://api.tembo.io'),
  MCP_TOOL_MODE: z.enum(['compact', 'all']).default('compact'),
  MCP_ALLOWED_ORIGINS: z.string().default(''),
});

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.parse(environment);
  if (new URL(parsed.MCP_PUBLIC_URL).pathname !== '/mcp') {
    throw new Error('MCP_PUBLIC_URL must end in /mcp (no trailing slash)');
  }
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    publicUrl: parsed.MCP_PUBLIC_URL,
    issuer: parsed.MCP_OAUTH_ISSUER,
    apiUrl: parsed.TEMBO_API_URL.replace(/\/$/, ''),
    toolMode: parsed.MCP_TOOL_MODE,
    allowedOrigins: [new URL(parsed.MCP_PUBLIC_URL).origin, ...parsed.MCP_ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean).map((value) => new URL(httpUrl.parse(value)).origin)],
  };
}

export function loadStdioConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.pick({ TEMBO_API_URL: true, MCP_TOOL_MODE: true }).extend({ TEMBO_API_KEY: z.string().min(1) }).parse(environment);
  return { apiUrl: parsed.TEMBO_API_URL.replace(/\/$/, ''), toolMode: parsed.MCP_TOOL_MODE, apiKey: parsed.TEMBO_API_KEY };
}

export type Config = ReturnType<typeof loadConfig>;
