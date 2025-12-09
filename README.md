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