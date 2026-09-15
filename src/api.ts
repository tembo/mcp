import { z } from 'zod';

export const BASE_SCOPES = ['user:org:read'];

const scopeErrorSchema = z.object({
  code: z.literal('insufficient_scope'),
  requiredScopes: z.array(z.literal('user:org:read')).min(1).max(1),
});

const apiKeyIdentitySchema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1),
}).strict();

export const identitySchema = z.union([z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  clientId: z.string().min(1),
  scopes: z.array(z.string()),
  expiresAt: z.number().int().positive(),
}), apiKeyIdentitySchema]);

export type Identity = z.infer<typeof identitySchema>;

export class AuthenticationError extends Error {
  constructor(public readonly status: 401 | 403 | 503, public readonly requiredScopes?: string[]) {
    super('Authentication failed');
  }
}

export async function verifyIdentity(apiUrl: string, token: string): Promise<Identity> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/auth/context`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AuthenticationError(503);
  }
  if (!response.ok) {
    if (response.status === 403) {
      const scopeError = scopeErrorSchema.safeParse(await response.json().catch(() => null));
      throw new AuthenticationError(403, scopeError.success ? scopeError.data.requiredScopes : undefined);
    }
    throw new AuthenticationError(response.status === 401 ? 401 : response.status === 403 ? 403 : 503);
  }
  const result = identitySchema.safeParse(await response.json().catch(() => null));
  if (!result.success) throw new AuthenticationError(503);
  if ('expiresAt' in result.data && result.data.expiresAt <= Date.now() / 1000) throw new AuthenticationError(401);
  if ('scopes' in result.data && !result.data.scopes.includes('user:org:read')) {
    throw new AuthenticationError(403, BASE_SCOPES);
  }
  return result.data;
}
