# CLAUDE.md

## Commands

- `npm run build` — compile TypeScript to `dist/`
- `npm run typecheck` — `tsc --noEmit`
- `npm run check` / `npm run fix` — Biome lint + format (check / write)
- `npm test` / `npm run test:watch` — vitest
- `npm run dev` — `tsc --watch`

## Architecture

Stdio MCP server for the Tembo API. `src/index.ts` is the thin bin entry point
(env parsing, client construction, stdio connect). `src/server.ts` exports
`createServer(tembo)` which registers the five tools against an injected client
satisfying the structural `TemboApi` interface. `src/client.ts` wraps
`@tembo-io/sdk`. Tests in `tests/` drive the server over the MCP SDK's
`InMemoryTransport` with a plain-object mock client — no network, no real key.

## Notes

- ESM with Node16 module resolution: relative imports need `.js` extensions.
- The server version is read from `package.json` at runtime; don't hardcode it.
