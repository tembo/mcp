import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// Minimal structural view of the Tembo SDK client — only the methods the tools
// use. The real `Tembo` client satisfies it, and tests can pass plain mocks.
export interface TemboApi {
    task: {
        create(params: {
            prompt?: string;
            repositories?: string[];
            branch?: string | null;
            agent?: string;
            queueRightAway?: boolean | null;
        }): Promise<unknown>;
        list(params: { limit?: number; page?: number }): Promise<unknown>;
        search(params: { q: string; limit?: number; page?: number }): Promise<unknown>;
    };
    repository: {
        list(): Promise<unknown>;
    };
    me: {
        retrieve(): Promise<unknown>;
    };
}

const { version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

function jsonResult(data: unknown): CallToolResult {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(data, null, 2),
            },
        ],
    };
}

function errorResult(message: string): CallToolResult {
    return {
        content: [
            {
                type: 'text',
                text: message,
            },
        ],
        isError: true,
    };
}

async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
    try {
        return jsonResult(await fn());
    } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function createServer(tembo: TemboApi): McpServer {
    const server = new McpServer({
        name: 'tembo-mcp',
        version,
    });

    server.registerTool(
        'create_task',
        {
            description:
                'Create a new task in Tembo. Tasks are work items that Tembo will process in the background.',
            inputSchema: {
                prompt: z.string().optional().describe('Description of the task to be performed'),
                description: z
                    .string()
                    .optional()
                    .describe('Deprecated alias for prompt; prefer prompt'),
                repositories: z
                    .array(z.string())
                    .optional()
                    .describe('Array of code repository URLs that this task relates to'),
                branch: z
                    .string()
                    .optional()
                    .describe('Specific git branch to target for this task'),
                agent: z
                    .string()
                    .optional()
                    .describe(
                        'The agent to use for this task (e.g., "claudeCode:claude-4-5-sonnet")',
                    ),
                queueRightAway: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe('Whether to immediately queue the task for processing'),
            },
        },
        async (args) => {
            // Use prompt or description - SDK only accepts prompt
            const prompt = args.prompt || args.description;
            if (!prompt) {
                return errorResult('Error: Either prompt or description is required');
            }

            return runTool(() =>
                tembo.task.create({
                    prompt,
                    repositories: args.repositories,
                    branch: args.branch,
                    agent: args.agent,
                    queueRightAway: args.queueRightAway,
                }),
            );
        },
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
        async (args) => runTool(() => tembo.task.list({ limit: args.limit, page: args.page })),
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
        async (args) =>
            runTool(() => tembo.task.search({ q: args.q, limit: args.limit, page: args.page })),
    );

    server.registerTool(
        'list_repositories',
        {
            description: 'Get a list of enabled code repositories for the organization',
            inputSchema: {},
        },
        async () => runTool(() => tembo.repository.list()),
    );

    server.registerTool(
        'get_current_user',
        {
            description: 'Get information about the current authenticated user',
            inputSchema: {},
        },
        async () => runTool(() => tembo.me.retrieve()),
    );

    return server;
}
