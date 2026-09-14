# Tembo MCP Server

**The public OpenAPI spec is the source of truth.** This server loads it on startup and uses `@ivotoby/openapi-mcp-server` to generate a tool for every operation. There are no hand-written endpoint handlers, endpoint lists, or SDK-method mappings to maintain.

```text
Tembo public OpenAPI → existing OpenAPI-to-MCP library → full MCP tool surface
MCP client → Clerk login/consent → MCP server → Tembo public API
```

The small application wrapper handles Clerk OAuth discovery and per-request identity. The generation library handles schemas, tool names, HTTP methods, path/query/body serialization, and API execution. Scalar can continue generating the SDK from the same public spec; the MCP server no longer depends on that SDK.

## Coverage and updates

- All operations in `TEMBO_API_URL/openapi/public` become tools, including public billing, API-key, project, integration, session, and legacy endpoints.
- All grants discover the same tool catalog. Read-only grants can execute GET/HEAD/OPTIONS; calling a mutating tool returns an HTTP 403 scope challenge before the API is invoked. Clients must obtain explicit `tembo:write` consent to execute mutations.
- The API separately enforces scopes, current organization membership, and existing resource permissions. Tool visibility is not an authorization boundary.
- Adding an endpoint means adding it to the **public OpenAPI spec**, then restarting/redeploying the MCP process. No MCP source changes or generation commits are required.
- The spec is fetched once at startup, not on each tool call. A running process retains its snapshot until restart. The service fails startup if fetching/generation fails or the generated tool count/name uniqueness does not match the operation count.
- Internal and sandbox-only routes are not public API operations. The existing sandbox MCP endpoint remains separately protected and unavailable to customer OAuth grants.

Check the currently deployed public contract without credentials or API mutations:

```sh
npm run check:coverage
```

On September 14, 2026, this check generated **125 tools from 125 public operations**. The count is not hard-coded. All current public request bodies use JSON; new content types and unusual OpenAPI constructs should be tested against the generation library before launch. API-side validation remains authoritative.

## Run

Requires Node.js 22+ and the companion OAuth changes deployed in the Tembo API.

From the repository root, enter `remote/` before running these commands. This is a separately deployed preview service, not the existing root npm package.

```sh
npm ci
cp .env.example .env
# Set your issuer, public MCP URL, and API root.
npm run dev
```

| Server variable | Meaning |
| --- | --- |
| `MCP_PUBLIC_URL` | Canonical client-facing URL ending exactly in `/mcp` |
| `MCP_OAUTH_ISSUER` | Exact Clerk HTTPS issuer origin |
| `TEMBO_API_URL` | Public API root; defaults to `https://api.tembo.io`. For local deployments include any API prefix and `/public-api` |
| `HOST` | Listen address; defaults to `127.0.0.1` |
| `PORT` | Listen port; defaults to `3000` |

The server discovers the public spec at `${TEMBO_API_URL}/openapi/public` and verifies callers at `${TEMBO_API_URL}/oauth/context`. No shared API key or Clerk secret is stored in this process. HTTPS is required except on loopback. The operator-configured API root is the destination; the spec's `servers` entries do not override it.

## Clerk and API setup

Use the same Clerk instance as Tembo, acting as an OAuth authorization server. The companion API deployment requires:

```dotenv
CLERK_SECRET_KEY=your-existing-clerk-secret
MCP_OAUTH_ISSUER=https://your-instance.clerk.accounts.dev
MCP_OAUTH_RESOURCE=https://your-mcp-host.example/mcp
```

`MCP_OAUTH_RESOURCE` must equal the MCP server's `MCP_PUBLIC_URL`. The MCP endpoint and public API operations intentionally form **one protected resource**, identified by that URL.

1. Enable Organizations, OAuth consent, and an appropriate approved-client registration policy. Use public-client authorization code flow with PKCE; do not put client secrets in desktop clients.
2. Create/assign/advertise `tembo:read` and `tembo:write` custom scopes. Request `user:org:read` so Clerk's consent flow selects an organization. Configure default scopes for clients that omit them.
3. Enable JWT OAuth access tokens. Clients must send the canonical MCP URL as the RFC 8707 `resource`. Tokens must contain the exact issuer and audience, an OAuth access-token header type, `sub`, `org_id`, `client_id`, and `exp`.
4. Test actual tokens and organization selection before enabling the public endpoint. This first version rejects opaque and resource-unbound tokens.

Discovery and initial challenges request only `user:org:read tembo:read`. Known write-tool calls require `user:org:read tembo:read tembo:write` and return a scoped `WWW-Authenticate` challenge when that grant is missing. A client must support step-up authorization or explicitly reconnect with the write scopes. Membership denials are not converted into scope-escalation requests. Full tool discovery remains available without write permission; visibility never grants execution rights.

**Write consent is broad:** it enables all public mutating operations permitted to the user, potentially including billing changes, credential creation, deletion, and agent execution. Existing organization/resource permissions still apply. Legacy read-like operations implemented using POST also require write scope.

Clerk manages login, consent, token issuance, and refresh. The API verifies signatures, issuer/audience, current token state and scopes, and current organization membership. JWT revocation behavior must be verified against Clerk; do not promise immediate invalidation solely because verification is performed on every call.

## Build, deploy, connect

```sh
npm run typecheck
npm test
npm run build
HOST=0.0.0.0 node --env-file=.env dist/index.js

# Or use the included non-root container:
docker build -t tembo-mcp .
docker run --rm --env-file .env -e HOST=0.0.0.0 -p 3000:3000 tembo-mcp
```

Deploy behind HTTPS and edge rate limiting. Preserve MCP headers. Do not log credentials or tool bodies. The service uses stateless Streamable HTTP, requires no sticky routing, and does not share caller credentials. `/health` is process liveness; startup has already loaded/validated the public spec, but health does not continuously probe Clerk or the API.

Discovery is available at `/.well-known/oauth-protected-resource/mcp` and the root protected-resource metadata path. Cross-origin browser calls are denied by default; native/remote server-side MCP clients do not need browser CORS. Old clients relying on authorization-server metadata at the MCP host are not supported.

After deploying, configure an MCP client with the endpoint URL and connect through OAuth—do not paste an API key:

```json
{
  "mcpServers": {
    "tembo": { "url": "https://your-mcp-host.example/mcp" }
  }
}
```

## Validation and remaining launch work

Tests exercise an actual MCP SDK client, generated CRUD operations, parameter/reference handling, spec updates, write-scope challenges, per-caller credentials, failures, and discovery against a mock API. `check:coverage` reads the live public spec but does not invoke customer operations. A real Clerk login/consent/refresh flow is still required.

## Preview limitations and release gates

- The pinned SDK supports protocol revision `2025-11-25` and older negotiated revisions. It does not implement `2026-07-28`; do not advertise compatibility with that revision. Upgrade the SDK/generator together and verify target-client compatibility before general availability.
- Every public operation is listed as a tool. Compact discovery and richer generated safety/output metadata remain follow-up work; no endpoint is intentionally omitted to reduce catalog size.
- Write challenges are tested at the HTTP boundary, not through a live client's Clerk consent screen. The API remains authoritative if permissions change after preflight. Upstream tool errors are not automatically retried.
- Spec and identity fetches reject redirects; the generation library's API client has a separate redirect policy that needs deployment review.
- Run all commands on this page from `remote/`. The root package remains the existing API-key stdio client and is not changed by these instructions.

Before launch: deploy the companion API changes; configure Clerk and both services; test real login, refresh, consent denial, read-only write denial, cross-org access, membership removal, and revocation; confirm HTTPS and rate limiting; and resolve the release gates above. The remote npm package stays private to prevent accidental publication. This PR does not deploy the service or change the existing local package's release configuration.

Provider references:
- [Generation library](https://github.com/ivo-toby/mcp-openapi-server)
- [Clerk OAuth and organization selection](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth)
- [Clerk OAuth token verification](https://clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens)
- [Clerk resource indicators](https://github.com/clerk/openapi-specs/blob/main/fapi/2026-05-12.yml)
