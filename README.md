# Tembo MCP

The Model Context Protocol interface to the **full Tembo public API**, generated from the same OpenAPI contract that drives the SDK. There are no handwritten endpoint tools or SDK-method mappings to maintain.

One package, one generated catalog, two standard transports:

- **Hosted Streamable HTTP:** Clerk OAuth, organization-scoped identity, and full public API access for explicitly approved OAuth clients.
- **Local stdio:** the same tools through `@tembo-io/mcp`, using your API key. Read-only unless you pass `--allow-writes`.

Both transports use the official MCP TypeScript SDK v2 serving entries and support the `2026-07-28` protocol plus legacy clients using the `2025-11-25` handshake. The old five-tool implementation is replaced, not maintained as a separate server.

## Full API access without a giant tool list

The default compact interface exposes four tools:

| Tool | Purpose |
| --- | --- |
| `search_tools` | Search all generated operations by keyword, method, or path; paginate with `offset` and `limit` |
| `get_tool_schema` | Retrieve an operation's exact name, input schema, method, path, and safety annotations |
| `call_read_tool` | Execute a discovered read-only operation |
| `call_write_tool` | Execute a discovered mutating operation after write authorization |

For example, search for `sessions`, inspect a returned operation with `get_tool_schema`, then supply its exact name and arguments to the appropriate call tool. The server rejects unknown operation names, invalid arguments, and attempts to send a mutation through the read tool. It is not an arbitrary-URL HTTP proxy or a code-execution sandbox.

Set `MCP_TOOL_MODE=all` to expose each generated operation directly instead. `tools/list` paginates at 50 tools. Both modes reach the same public operations and enforce the same permissions. Tool results include structured `{ "data": ... }` output and a text representation for compatible clients; annotations are hints, not authorization rules.

## Run from source

Requires Node.js 22 or newer.

```sh
npm ci
npm run build
node dist/index.js --help
```

### Local stdio

Create an API key in Tembo, then configure your MCP client to launch the built CLI:

```json
{
  "mcpServers": {
    "tembo": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/dist/index.js"],
      "env": {
        "TEMBO_API_KEY": "your-api-key"
      }
    }
  }
}
```

For local writes, add `--allow-writes` to `args`. The API key's server-side permissions still apply. Store the key in your client's secret mechanism where available, not in a committed configuration file. The CLI does not require Clerk settings in stdio mode and reserves stdout for protocol messages.

The package name remains `@tembo-io/mcp` and the executable remains `tembo-mcp`. After version 0.2.0 is published, `npx -y @tembo-io/mcp@0.2.0` launches this implementation. This PR does **not** publish that version; the existing registry release must not be mistaken for this code.

### Hosted HTTP with Clerk

```sh
cp .env.example .env
# Configure the canonical MCP URL, Clerk issuer, and API root.
npm run dev
```

For production, inject the environment and run `npm start` or the container. Configure clients with your deployed `/mcp` URL; the initial 401 response points them to public OAuth protected-resource metadata and requests the organization-selection scope.

Clerk handles login, consent, and refresh. The companion API uses the Clerk SDK to verify opaque access tokens, checks approved client IDs and expiry, resolves the selected organization through Clerk userinfo, and checks current membership. The hosted MCP process never stores a shared API key or Clerk secret.

Deployment requires the companion [API OAuth changes](https://github.com/tembo/monorepo/pull/11327). Configure that API with:

```dotenv
MCP_OAUTH_ISSUER=https://your-instance.clerk.accounts.dev
MCP_OAUTH_CLIENT_IDS=your-approved-clerk-oauth-client-id
```

The API reuses its existing `CLERK_SECRET_KEY`. `MCP_OAUTH_CLIENT_IDS` is a comma-separated allowlist of Clerk OAuth applications approved for full public API access. An empty list disables OAuth access. Only approve dedicated clients you control; this is client approval, not JWT resource-audience validation.

In Clerk, enable Organizations and consent and register supported public clients with exact redirect URIs and PKCE S256. Request `user:org:read` to select an organization. Clerk's development discovery did not advertise dynamic client registration: do not assume arbitrary MCP clients can register automatically. Use clients that support pre-registered OAuth credentials and validate their login flow before rollout.

**Hosted OAuth grants full public API access within the selected organization**, subject to existing user permissions. This includes writes, credential creation, billing changes, deletion, and agent execution. Make that clear in the OAuth application's name/description and client approval policy. There are no custom `tembo:*` scopes or read-to-write step-up flow. MCP tool approval remains the client's responsibility. No tool automatically retries a failed mutation.

## Configuration

| Variable | Applies to | Default / meaning |
| --- | --- | --- |
| `TEMBO_API_URL` | Both | `https://api.tembo.io`; local deployments must include the API prefix and `/public-api` |
| `MCP_TOOL_MODE` | Both | `compact`; use `all` for individual generated tools |
| `TEMBO_API_KEY` | Stdio | Required; forwarded only to the configured API |
| `MCP_PUBLIC_URL` | HTTP | Required canonical HTTPS URL ending exactly in `/mcp`; HTTP allowed on loopback |
| `MCP_OAUTH_ISSUER` | HTTP | Required Clerk HTTPS issuer origin |
| `MCP_ALLOWED_ORIGINS` | HTTP | Optional comma-separated browser origins, in addition to the server's own origin |
| `HOST` | HTTP | `127.0.0.1`; container sets `0.0.0.0` |
| `PORT` | HTTP | `3000` |

`--transport stdio` is the CLI default. `--transport http` starts the hosted server. `--allow-writes` is only valid for stdio; HTTP access comes from the approved OAuth client and existing API permissions.

```sh
docker build -t tembo-mcp .
docker run --rm --env-file .env -p 3000:3000 tembo-mcp
```

## OpenAPI lifecycle

At startup the server fetches `TEMBO_API_URL/openapi/public`. A maintained OpenAPI converter supplies operation metadata and request schemas; name abbreviation is disabled so operation names remain descriptive. The official MCP SDK supplies the protocol implementation. A shared adapter normalizes composed object schemas, validates arguments, and dispatches to the generated API client. No per-endpoint adapter is needed.

Startup checks that all public operations generate unique tools. The running process keeps a startup snapshot. Publish an endpoint through the normal public OpenAPI pipeline, then restart/redeploy MCP to discover it. This repository does not configure cross-repository deployment automation.

The coverage check currently validates **125 public operations** against generation and schema compilation. It does not call authenticated customer endpoints or prove that every possible request encoding works. New content types and unusual schemas need serialization regression tests. Internal routes and the existing sandbox-only MCP endpoint are not part of this public contract.

## Development and checks

```sh
npm run typecheck
npm test
npm run check:coverage
npm run build
npm pack --dry-run
npm audit
```

Tests cover current and legacy HTTP/stdio clients, generated CRUD, composed schemas, compact discovery, scope challenges, argument validation, and caller isolation. CI uses this single root package. A scheduled contract check catches drift in the deployed public OpenAPI specification without modifying customer data.

## Migration from 0.1.x

- The five handwritten tools (`create_task`, `list_tasks`, `search_tasks`, `list_repositories`, `get_current_user`) are replaced by generated discovery and execution. Update stored prompts or tool-name allowlists; old tool aliases are not retained.
- Existing local configurations can keep the package name and API-key variable, but local mutations now need `--allow-writes`.
- Hosted connections use Clerk OAuth instead of putting a shared API key in the server.
- There is no `remote/` package or separate dependency tree. Source, Docker, npm packaging, and CI all use the implementation at the repository root.

## Rollout boundary

The code is the main implementation, not a parallel preview. Merging it does not deploy a host, publish npm, or configure Clerk. Before enabling production, test real client login, org selection, consent denial, refresh, cross-org access, membership removal, and revocation. The API checks Clerk's current grant and organization membership on each request.

Deploy behind HTTPS and edge rate limits. Review upstream redirect policy and egress restrictions, and monitor provider failures without logging credentials or payloads. See [SECURITY.md](SECURITY.md).
