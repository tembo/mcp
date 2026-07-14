<p align="center">
  <img src="https://github.com/user-attachments/assets/2d6b9c98-5c2a-4022-a48a-c07058149fc5" alt="Tembo app icon" width="250" height="250">
</p>

# Tembo MCP Server

An [MCP server](https://spec.modelcontextprotocol.io/) for the [Tembo](https://tembo.io) [API](https://docs.tembo.io/api-reference/public-api/).

## Features

This MCP server provides the following tools:

- **create_task** - Create new tasks in Tembo with optional repository and branch targeting
- **list_tasks** - Get a paginated list of tasks for your organization
- **search_tasks** - Search for tasks by query string in title or description
- **list_repositories** - Get enabled code repositories for your organization
- **get_current_user** - Retrieve information about the authenticated user

## Installation

### Using npx

```bash
npx -y @tembo-io/mcp
```

### Installing globally

```bash
npm install -g @tembo-io/mcp
```

A global install exposes the binary as `tembo-mcp`.

## Usage

### 1. Get an API Key

Head to the [API Keys page](https://app.tembo.io/settings/api-keys) and obtain a new key to use with the MCP server.

### 2. Configure Your MCP Client

#### Claude Code

```bash
claude mcp add tembo -e TEMBO_API_KEY=your-api-key -- npx -y @tembo-io/mcp
```

#### Claude Desktop

Add the following to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tembo": {
      "command": "npx",
      "args": ["-y", "@tembo-io/mcp"],
      "env": {
        "TEMBO_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TEMBO_API_KEY` | Yes | Your Tembo API key |
| `TEMBO_API_URL` | No | Tembo API base URL (default `https://api.tembo.io`) |

## Tools

### create_task

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | One of `prompt`/`description` | Description of the task to be performed |
| `description` | string | — | Deprecated alias for `prompt` |
| `repositories` | string[] | No | Code repository URLs the task relates to |
| `branch` | string | No | Specific git branch to target |
| `agent` | string | No | Agent to use (e.g. `claudeCode:claude-4-5-sonnet`) |
| `queueRightAway` | boolean | No (default `true`) | Queue the task for processing immediately |

### list_tasks / search_tasks

Both accept `limit` (1-100, default 10) and `page` (default 1); `search_tasks` also requires `q`, the search query.

### list_repositories / get_current_user

No parameters.

## Development

```bash
git clone https://github.com/tembo/mcp.git
cd mcp
npm install
npm run build      # compile to dist/
npm test           # run the vitest suite
npm run check      # lint + format check (Biome)
npm run typecheck  # tsc --noEmit
```

Smoke-test the built server without a real API key:

```bash
TEMBO_API_KEY=test npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
```

## License

[MIT](LICENSE)
