# Security

Report vulnerabilities privately to the Tembo maintainers through the product's support channel. Do not put tokens, customer data, or private code in public issues.

## Hosted OAuth server boundaries

- The **public** OpenAPI document determines tool coverage. Do not point this service at an internal or Prisma spec. The operator-configured API root is trusted and receives user tokens.
- Clerk issues the OAuth grant. The API verifies signature, issuer, shared resource audience, expiry, token type, current scopes, and organization membership; existing API resource permissions remain authoritative.
- The MCP process has no shared API key or Clerk secret. Each request uses its own generated server and caller token. No token is converted to a browser session, sandbox credential, or privileged service identity.
- The hosted server lists all generated tools, but checks write scope before executing mutating calls. Initial consent is read-only. API-side method/scope checks remain authoritative. Full write grants deliberately cover every public mutating operation the user is permitted to perform, including credential management and billing—not just coding tasks. The root stdio package continues to use an API key rather than Clerk OAuth.
- OAuth cannot enter internal routes or the separate sandbox MCP endpoint. Failed OAuth verification cannot fall back to another identity. Organization identity comes from the verified token, not tool inputs or caller headers.
- The generation library handles request serialization and sanitizes authentication errors. Do not assume every API response is safe to give to an untrusted model: successful credential-creation responses can legitimately contain secrets, and returned code/messages are untrusted data.
- Use HTTPS, edge rate limiting, and request timeouts. Never log bearer tokens or request bodies. Avoid API redirects to unrelated services; the generation library's HTTP client manages redirects rather than our own custom HTTP implementation.
- Keep dependency versions and the lockfile reviewed. Run the protocol tests and live coverage check when upgrading the generator or adding unusual parameter encodings/content types.

JWT-only OAuth is supported in this first version. Test actual Clerk login, refresh, organization isolation, and revocation before launch. A passing mock integration is not a live authentication test.
