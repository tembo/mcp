<p align="center">
  <img src="https://github.com/user-attachments/assets/2d6b9c98-5c2a-4022-a48a-c07058149fc5" alt="Tembo app icon" width="250" height="250">
</p>

# Tembo MCP Server

An [MCP server](https://spec.modelcontextprotocol.io/) for the [Tembo](https://tembo.io) [API](https://docs.tembo.io/api-reference/public-api/).

## Features

This repository contains two entry points:

| Server | Authentication | API coverage | Status |
| --- | --- | --- | --- |
| Local stdio package (this page) | API key | Five existing tools | Existing entry point, unchanged |
| [Hosted server](remote/README.md) | Clerk OAuth | Generated from the full public OpenAPI spec | Preview; not deployed |

The hosted server lives in `remote/` with its own dependencies and Docker build. It starts with read-only consent and challenges writes for additional scope. It requires the companion API OAuth changes in [tembo/monorepo#11327](https://github.com/tembo/monorepo/pull/11327). See its README for protocol support and remaining launch checks; it is not a replacement for the existing `npx` command yet.

### Existing local tools

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

## Usage

### 1. Get an API Key

Head to the [API Keys page](https://app.tembo.io/settings/api-keys) and obtain a new key to use with the MCP server.

### 2. Configure Your MCP Client

Add the following configuration to your MCP client settings (e.g., Claude Desktop's `claude_desktop_config.json`):

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
