# Security

Report vulnerabilities privately to the Tembo maintainers through the product's support channel. Do not put tokens, customer data, or private code in public issues.

## Hosted server boundaries

- Hosted connections also accept Tembo API keys as bearer credentials. The API's existing key middleware checks revocation and derives organization identity from the stored key record. Keys do not acquire OAuth scopes or expiry. The MCP stores no server-wide API key. Both preflight and generated API calls verify the caller's credential; no authentication result is cached.
- Trusted services can use the existing agent bearer secret with `X-Agent-Org-Id`. The API verifies the secret through `authAgent` and requires an existing organization on every public request. The MCP forwards only the verified agent organization; OAuth/API-key callers cannot override their organization this way. This secret is privileged across organizations, not tenant-bound: possession authorizes choosing any known organization. Never expose it to customers, model-visible arguments, or untrusted sandboxes. Keep it behind trusted backend credential handling, rotate it if exposed, and use organization-scoped API keys for untrusted clients. The separate internal MCP route is not opened by this change.

- The **public** OpenAPI document determines tool coverage. Do not point this service at an internal or Prisma spec. The operator-configured API root is trusted and receives user tokens.
- Clerk issues the OAuth grant and manages client registration and consent. The API uses the Clerk SDK to verify the opaque access token and expiry, resolves the selected organization through trusted Clerk userinfo, and checks current membership; existing API resource permissions remain authoritative. There is no separate MCP client-ID allowlist.
- The MCP process has no shared API key or Clerk secret. Each request uses its own generated server and caller token. No token is converted to a browser session, sandbox credential, or privileged service identity.
- Compact discovery and the optional full listing cover the same generated operations. The server validates arguments and does not let read tools dispatch writes. Hosted OAuth grants deliberately provide full public API access in the selected organization, including credential management and billing where user permissions allow it. There is no read-only OAuth grant or write step-up. Communicate this policy during onboarding and consent.
- OAuth cannot enter internal routes or the separate sandbox MCP endpoint. Failed OAuth verification cannot fall back to another identity. Organization identity comes from Clerk userinfo, bound to the verified grant subject, not tool inputs or caller headers.
- The generation library handles request serialization and sanitizes authentication errors. Do not assume every API response is safe to give to an untrusted model: successful credential-creation responses can legitimately contain secrets, and returned code/messages are untrusted data.
- Use HTTPS, edge rate limiting, and request timeouts. Never log bearer tokens or request bodies. Avoid API redirects to unrelated services; the generation library's HTTP client manages redirects rather than our own custom HTTP implementation.
- Keep dependency versions, the lockfile, and bundled OpenAPI changes reviewed. Run the protocol tests and snapshot coverage check when upgrading the generator or adding unusual parameter encodings/content types. Schema updates take effect only after release/redeployment, not an automatic startup fetch.

## Local stdio

The same implementation runs locally with a user-provided API key. It defaults to read-only and requires `--allow-writes` for mutations; key permissions remain authoritative at the API. The client launching the process owns secret storage. Never put API keys in command-line arguments or committed configuration. Stdout is reserved for MCP protocol messages.

Both transports use the official SDK's current/legacy serving entries. The OpenAPI converter is used for schemas and HTTP execution, not its older protocol server. Tool annotations are conservative hints, not a substitute for API authorization. Structured results may contain legitimate secrets returned by credential APIs; clients must review tool approval and data-handling policies.

Clerk opaque OAuth access tokens are supported; ID tokens are not API credentials. Native dynamic registration allows clients to register without a server-side allowlist, but does not bypass user consent or API permissions. Monitor registration abuse and misleading client names. The MCP server and backing API are one service boundary; do not forward unrelated third-party tokens or mistake grant verification for resource-audience verification. Test actual Clerk login, refresh, organization isolation, and revocation before launch. A passing mock integration is not a live authentication test.

## Production release gate

Resource/audience enforcement remains an open security review: the API currently verifies Clerk grant validity, scope, subject, and organization membership, but does not explicitly check an MCP-specific audience. The current Clerk grant resource and MCP helper do not expose an audience check that can simply be enabled here. Do not treat the advertised metadata `resource` or assigning `authInfo.resource` as verification of a token's intended resource. Resolve this boundary with Clerk and test rejection of grants intended for unrelated resources before approving a production deployment; successful login/refresh tests do not establish this property. Do not replace this review with an unverified client-supplied resource header or a custom OAuth server.
