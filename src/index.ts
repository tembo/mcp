#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTemboClient } from './client.js';
import { createServer } from './server.js';

const TEMBO_API_KEY = process.env.TEMBO_API_KEY;
const TEMBO_API_URL = process.env.TEMBO_API_URL || 'https://api.tembo.io';

if (!TEMBO_API_KEY) {
    console.error('Error: TEMBO_API_KEY environment variable is required');
    process.exit(1);
}

const temboClient = createTemboClient({
    apiKey: TEMBO_API_KEY,
    baseUrl: TEMBO_API_URL,
});

const server = createServer(temboClient);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Tembo MCP server running on stdio');
}

main().catch((error) => {
    console.error('Fatal error in main():', error);
    process.exit(1);
});
