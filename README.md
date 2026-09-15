# Tembo MCP

The Model Context Protocol interface to the **full Tembo public API**, generated from the same OpenAPI contract that drives the SDK. There are no handwritten endpoint tools or SDK-method mappings to maintain.

One package, one generated catalog, two standard transports:

- **Hosted Streamable HTTP:** native Clerk OAuth, organization-scoped identity, and public API access subject to existing user permissions.
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

Clerk handles client registration, login, consent, and refresh. The companion API uses the Clerk SDK to verify opaque access tokens and expiry, resolves the selected organization through Clerk userinfo, and checks current membership. The hosted MCP process never stores a shared API key or Clerk secret. There are no custom registration, authorization, or token endpoints here.

Deployment requires the companion [API OAuth changes](https://github.com/tembo/monorepo/pull/11327). Configure that API with:

```dotenv
MCP_OAUTH_ISSUER=https://your-instance.clerk.accounts.dev
```

The API reuses its existing `CLERK_SECRET_KEY`. Both services must use the same Clerk instance. There is no MCP client-ID allowlist; Clerk manages client registration and user consent. Leaving the API's issuer unset disables OAuth access.

In Clerk, enable Organizations, require PKCE, and configure default OAuth scopes to include `user:org:read` for organization selection. Enable native Dynamic Client Registration for clients that require it, so users can connect using only the MCP URL. Keep consent enabled. DCR exposes a public registration endpoint: monitor registered clients and understand that client names are not proof of trust. Prefer Clerk's CIMD support for compatible clients where available. See Clerk's guide: https://clerk.com/docs/guides/ai/mcp/connect-mcp-client.

**Hosted OAuth grants full public API access within the selected organization**, subject to existing user permissions. This includes writes, credential creation, billing changes, deletion, and agent execution. Make that clear during onboarding and consent. There are no custom `tembo:*` scopes or read-to-write step-up flow. MCP tool approval remains the client's responsibility. No tool automatically retries a failed mutation.

## Configuration

| Variable | Applies to | Default / meaning |
| --- | --- | --- |
| `TEMBO_API_URL` | Both | `https://api.tembo.io`; local deployments must include the API prefix and `/public-api` |
| `MCP_TOOL_MODE` | Both | `compact`; use `all` for individual generated tools |
| `MCP_OPENAPI_PATH` | Both | Optional local JSON file for development/self-hosting; defaults to the bundled snapshot |
| `TEMBO_API_KEY` | Stdio | Required; forwarded only to the configured API |
| `MCP_PUBLIC_URL` | HTTP | Required canonical HTTPS URL ending exactly in `/mcp`; HTTP allowed on loopback |
| `MCP_OAUTH_ISSUER` | HTTP | Required Clerk HTTPS issuer origin |
| `MCP_ALLOWED_ORIGINS` | HTTP | Optional comma-separated browser origins, in addition to the server's own origin |
| `HOST` | HTTP | `127.0.0.1`; container sets `0.0.0.0` |
| `PORT` | HTTP | `3000` |

`--transport stdio` is the CLI default. `--transport http` starts the hosted server. `--allow-writes` is only valid for stdio; HTTP access comes from the Clerk OAuth grant and existing API permissions.

```sh
docker build -t tembo-mcp .
docker run --rm --env-file .env -p 3000:3000 tembo-mcp
```

## OpenAPI lifecycle

At startup the server reads the versioned `openapi/openapi.json` bundled in npm and Docker releases, without fetching a live schema. A maintained OpenAPI converter supplies operation metadata and request schemas; name abbreviation is disabled so operation names remain descriptive. The official MCP SDK supplies the protocol implementation. A shared adapter normalizes composed object schemas, validates arguments, and dispatches to the generated API client. No per-endpoint adapter is needed.

Startup checks that all public operations generate unique tools. `npm run update:openapi` fetches the canonical public contract and validates coverage and schemas before updating the snapshot. The update workflow opens or updates a review PR on `production-api-deployed` repository dispatch, manual invocation on main, or a daily fallback. Unchanged schemas produce no diff. Merge the reviewed snapshot, then release/redeploy MCP; restarting an old release does not change its tools. SDK releases are independent.

Automation requires the public CI GitHub App installed on this repository with contents and pull-request write permissions, `CI_PUBLIC_BOT_APP_ID` as a repository variable, and `CI_PUBLIC_BOT_PRIVATE_KEY` as a secret (reuse the SDK/docs bot). The companion monorepo workflow sends `production-api-deployed` independently to this repo and the SDK after a successful production API rollout. Its existing `CI_BOT_APP_ID`/`CI_BOT_PRIVATE_KEY` bot must also be installed on `tembo/mcp` with contents write permission to send that event. Until both PRs are merged and configured, use the manual schema-update trigger. npm publication remains separate.

The coverage check currently validates **125 public operations** against generation and schema compilation. It does not call authenticated customer endpoints or prove that every possible request encoding works. New content types and unusual schemas need serialization regression tests. Internal routes and the existing sandbox-only MCP endpoint are not part of this public contract.

The sync script omits ISO timestamp defaults from response definitions: the public schema evaluates some generated date defaults at fetch time, which otherwise creates a diff on every refresh. Request defaults and actual API responses are unchanged.

## Development and checks

```sh
npm run typecheck
npm test
npm run check:coverage
npm run build
npm pack --dry-run
npm audit
```

Tests cover current and legacy HTTP/stdio clients, generated CRUD, composed schemas, compact discovery, scope challenges, argument validation, caller isolation, and offline schema loading. CI checks the committed snapshot, not a changing production schema. Only the schema-update workflow fetches the deployed contract; it never calls customer operations.

## Image publishing and deployment

The `Publish MCP image` workflow runs manually on `main` or when a GitHub release is published. It requires the source commit to be on main, runs tests, typecheck, schema coverage, and dependency audit, then publishes a Linux amd64 image to the shared ECR repository `tembo-mcp`. The image tag is the **full 40-character MCP commit SHA**, not the monorepo commit or a mutable `latest` tag. Rerunning a publication reuses the existing immutable image. The workflow summary records its tag and digest. Publishing does not deploy anything or publish npm.

Before publishing, configure the `release` GitHub environment in this repo:

- Set `ECR_REPO_PREFIX` to the shared registry host and `ECR_ROLE_ARN` to the publishing role, as repository or environment variables.
- Have infra create `tembo-mcp` in the shared registry in `us-east-1`, with immutable SHA tags and mutable `*.mcp` environment tags, matching the existing ECR pattern.
- Scope the publishing role's GitHub OIDC trust to `repo:tembo/mcp:environment:release`. Give it ECR push/pull and image lookup permissions for `tembo-mcp`, not ECS deployment permissions. No long-lived AWS credentials are needed.
- Protect the `release` environment with approved branch/tag rules and required reviewers. The separate check job runs without AWS credentials.

The monorepo's manual `Deploy MCP` workflow accepts `environment` (`dev`, `staging`, or `prod`) and the image SHA. It reuses `deploy-ecs.yaml`, including its rollout/stability checks and environment tagging. It uses the existing monorepo environment roles/registry variables and maps dev to the `test` GitHub environment, staging to `staging`, and prod to `production`. Production approval is controlled by that existing GitHub environment; verify its required-reviewer policy before launch. Deployments run only from monorepo main and serialize per environment. The same image can be promoted without rebuilding; rollback selects a previous published SHA.

Infra must provision the following contract before running deployment (no resources are created by these workflows):

| Resource | Expected value |
| --- | --- |
| ECS clusters | `tembo-use1-{dev,staging,prod}-api` |
| Service and task-definition family | `tembo-use1-{dev,staging,prod}-mcp` |
| Container name | `tembo-mcp` |
| Container port / health path | `3000` / `/health` |
| Runtime environment | `MCP_PUBLIC_URL`, `MCP_OAUTH_ISSUER`, `TEMBO_API_URL`; image defaults `HOST=0.0.0.0` |
| Public routing | Host routing to both `/mcp` and `/.well-known/oauth-protected-resource*`; production vanity domain `mcp.tembo.io` |

Use each environment's own API URL and Clerk issuer. The MCP container needs no Clerk secret, database credentials, or shared API key. Ensure the task execution role can pull the shared ECR image and deploy/tagging roles can access the new service/repository. Configure TLS, rate limits, logs, and streaming timeouts in infra. Create registry/IAM first, publish an initial image, then provision services using that image and promote through dev, staging, and production.

Schema review and deployment are intentionally separate: API deploy → schema PR → review/merge → publish image → deploy that SHA. No schema-update event can automatically deploy production.

## Migration from 0.1.x

- The five handwritten tools (`create_task`, `list_tasks`, `search_tasks`, `list_repositories`, `get_current_user`) are replaced by generated discovery and execution. Update stored prompts or tool-name allowlists; old tool aliases are not retained.
- Existing local configurations can keep the package name and API-key variable, but local mutations now need `--allow-writes`.
- Hosted connections use Clerk OAuth instead of putting a shared API key in the server.
- There is no `remote/` package or separate dependency tree. Source, Docker, npm packaging, and CI all use the implementation at the repository root.

## Rollout boundary

The code is the main implementation, not a parallel preview. Merging it does not deploy a host, publish npm, or configure Clerk. Before enabling production, test real client login, org selection, consent denial, refresh, cross-org access, membership removal, and revocation. The API checks Clerk's current grant and organization membership on each request.

Deploy behind HTTPS and edge rate limits. Review upstream redirect policy and egress restrictions, and monitor provider failures without logging credentials or payloads. See [SECURITY.md](SECURITY.md).
