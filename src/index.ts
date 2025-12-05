#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createTemboClient } from './client.js';

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

const server = new McpServer(
    {
        name: 'tembo-mcp',
        version: '0.1.0',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

server.registerTool(
    'create_task',
    {
        description:
            'Create a new task in Tembo. Tasks are work items that Tembo will process in the background.',
        inputSchema: {
            prompt: z.string().optional().describe('Brief description of the task to be performed'),
            description: z
                .string()
                .optional()
                .describe('Detailed description of the task (alternative to prompt)'),
            repositories: z
                .array(z.string())
                .optional()
                .describe('Array of code repository URLs that this task relates to'),
            branch: z.string().optional().describe('Specific git branch to target for this task'),
            agent: z
                .string()
                .optional()
                .describe('The agent to use for this task (e.g., "claudeCode:claude-4-5-sonnet")'),
            queueRightAway: z
                .boolean()
                .optional()
                .default(true)
                .describe('Whether to immediately queue the task for processing'),
        },
    },
    async (args) => {
        try {
            // Use prompt or description - SDK only accepts prompt
            const prompt = args.prompt || args.description;
            if (!prompt) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: 'Error: Either prompt or description is required',
                        },
                    ],
                    isError: true,
                };
            }

            const result = await temboClient.task.create({
                prompt,
                repositories: args.repositories,
                branch: args.branch,
                agent: args.agent,
                queueRightAway: args.queueRightAway,
            });

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'list_tasks',
    {
        description: 'Get a paginated list of tasks for the organization',
        inputSchema: {
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .default(10)
                .describe('Number of items to return per page (1-100, default 10)'),
            page: z
                .number()
                .int()
                .min(1)
                .optional()
                .default(1)
                .describe('Page number to retrieve (starts from 1, default 1)'),
        },
    },
    async (args) => {
        try {
            const result = await temboClient.task.list({
                limit: args.limit,
                page: args.page,
            });

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'search_tasks',
    {
        description: 'Search tasks by query string in title or description',
        inputSchema: {
            q: z.string().describe('Search query to find tasks'),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .default(10)
                .describe('Number of items to return per page (1-100, default 10)'),
            page: z
                .number()
                .int()
                .min(1)
                .optional()
                .default(1)
                .describe('Page number to retrieve (starts from 1, default 1)'),
        },
    },
    async (args) => {
        try {
            const result = await temboClient.task.search({
                q: args.q,
                limit: args.limit,
                page: args.page,
            });

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'list_repositories',
    {
        description: 'Get a list of enabled code repositories for the organization',
        inputSchema: {},
    },
    async () => {
        try {
            const result = await temboClient.repository.list();

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    }
);

server.registerTool(
    'get_current_user',
    {
        description: 'Get information about the current authenticated user',
        inputSchema: {},
    },
    async () => {
        try {
            const result = await temboClient.me.retrieve();

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Tembo MCP server running on stdio');
}

main().catch((error) => {
    console.error('Fatal error in main():', error);
    process.exit(1);
});
