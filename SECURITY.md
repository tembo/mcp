# Security

Report vulnerabilities privately to the Tembo maintainers through the product's support channel. Do not put tokens, customer data, or private code in public issues.

## Hosted OAuth server boundaries

- The **public** OpenAPI document determines tool coverage. Do not point this service at an internal or Prisma spec. The operator-configured API root is trusted and receives user tokens.
- Clerk issues the OAuth grant. The API uses the Clerk SDK to verify the opaque access token, enforces an explicit approved-client allowlist and expiry, resolves the selected organization through trusted Clerk userinfo, and checks current membership; existing API resource permissions remain authoritative.
- The MCP process has no shared API key or Clerk secret. Each request uses its own generated server and caller token. No token is converted to a browser session, sandbox credential, or privileged service identity.
- Compact discovery and the optional full listing cover the same generated operations. The server validates arguments and does not let read tools dispatch writes. Approved hosted OAuth clients deliberately receive full public API access in the selected organization, including credential management and billing where user permissions allow it. There is no read-only OAuth grant or write step-up. Communicate this policy during client registration and consent.
- OAuth cannot enter internal routes or the separate sandbox MCP endpoint. Failed OAuth verification cannot fall back to another identity. Organization identity comes from Clerk userinfo, bound to the verified grant subject, not tool inputs or caller headers.
- The generation library handles request serialization and sanitizes authentication errors. Do not assume every API response is safe to give to an untrusted model: successful credential-creation responses can legitimately contain secrets, and returned code/messages are untrusted data.
- Use HTTPS, edge rate limiting, and request timeouts. Never log bearer tokens or request bodies. Avoid API redirects to unrelated services; the generation library's HTTP client manages redirects rather than our own custom HTTP implementation.
- Keep dependency versions and the lockfile reviewed. Run the protocol tests and live coverage check when upgrading the generator or adding unusual parameter encodings/content types.

## Local stdio

The same implementation runs locally with a user-provided API key. It defaults to read-only and requires `--allow-writes` for mutations; key permissions remain authoritative at the API. The client launching the process owns secret storage. Never put API keys in command-line arguments or committed configuration. Stdout is reserved for MCP protocol messages.

Both transports use the official SDK's current/legacy serving entries. The OpenAPI converter is used for schemas and HTTP execution, not its older protocol server. Tool annotations are conservative hints, not a substitute for API authorization. Structured results may contain legitimate secrets returned by credential APIs; clients must review tool approval and data-handling policies.

Clerk opaque OAuth access tokens are supported; ID tokens are not API credentials. Only explicitly approved Clerk OAuth client IDs are accepted. The MCP server and backing API are one service boundary; do not forward unrelated third-party tokens or mistake client approval for resource-audience verification. Test actual Clerk login, refresh, organization isolation, and revocation before launch. A passing mock integration is not a live authentication test.
