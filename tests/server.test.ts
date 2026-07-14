import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { createServer, type TemboApi } from '../src/server.js';

function makeMockTembo() {
    return {
        task: {
            create: vi.fn().mockResolvedValue({ id: 'task_1' }),
            list: vi.fn().mockResolvedValue({ tasks: [] }),
            search: vi.fn().mockResolvedValue({ tasks: [] }),
        },
        repository: {
            list: vi.fn().mockResolvedValue({ repositories: [{ url: 'https://github.com/a/b' }] }),
        },
        me: {
            retrieve: vi.fn().mockResolvedValue({ email: 'user@example.com' }),
        },
    } satisfies TemboApi;
}

async function connect(tembo: TemboApi) {
    const server = createServer(tembo);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

function resultJson(result: CallToolResult): unknown {
    const first = result.content[0];
    if (first?.type !== 'text') {
        throw new Error('Expected text content');
    }
    return JSON.parse(first.text);
}

function resultText(result: CallToolResult): string {
    const first = result.content[0];
    if (first?.type !== 'text') {
        throw new Error('Expected text content');
    }
    return first.text;
}

describe('tools/list', () => {
    it('exposes exactly the five tools', async () => {
        const client = await connect(makeMockTembo());
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
            'create_task',
            'get_current_user',
            'list_repositories',
            'list_tasks',
            'search_tasks',
        ]);
    });
});

describe('create_task', () => {
    it('creates a task from a prompt', async () => {
        const tembo = makeMockTembo();
        const client = await connect(tembo);
        const result = (await client.callTool({
            name: 'create_task',
            arguments: { prompt: 'fix the bug', repositories: ['https://github.com/a/b'] },
        })) as CallToolResult;
        expect(result.isError).toBeFalsy();
        expect(resultJson(result)).toEqual({ id: 'task_1' });
        expect(tembo.task.create).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: 'fix the bug',
                repositories: ['https://github.com/a/b'],
                queueRightAway: true,
            }),
        );
    });

    it('falls back to description when prompt is missing', async () => {
        const tembo = makeMockTembo();
        const client = await connect(tembo);
        await client.callTool({
            name: 'create_task',
            arguments: { description: 'do the thing' },
        });
        expect(tembo.task.create).toHaveBeenCalledWith(
            expect.objectContaining({ prompt: 'do the thing' }),
        );
    });

    it('errors without calling the SDK when both prompt and description are missing', async () => {
        const tembo = makeMockTembo();
        const client = await connect(tembo);
        const result = (await client.callTool({
            name: 'create_task',
            arguments: {},
        })) as CallToolResult;
        expect(result.isError).toBe(true);
        expect(resultText(result)).toMatch(/Either prompt or description is required/);
        expect(tembo.task.create).not.toHaveBeenCalled();
    });

    it('returns isError when the SDK rejects', async () => {
        const tembo = makeMockTembo();
        tembo.task.create.mockRejectedValue(new Error('boom'));
        const client = await connect(tembo);
        const result = (await client.callTool({
            name: 'create_task',
            arguments: { prompt: 'x' },
        })) as CallToolResult;
        expect(result.isError).toBe(true);
        expect(resultText(result)).toBe('Error: boom');
    });
});

describe('list_tasks', () => {
    it('applies default pagination', async () => {
        const tembo = makeMockTembo();
        const client = await connect(tembo);
        await client.callTool({ name: 'list_tasks', arguments: {} });
        expect(tembo.task.list).toHaveBeenCalledWith({ limit: 10, page: 1 });
    });

    it('passes explicit pagination through', async () => {
        const tembo = makeMockTembo();
        const client = await connect(tembo);
        await client.callTool({ name: 'list_tasks', arguments: { limit: 5, page: 3 } });
        expect(tembo.task.list).toHaveBeenCalledWith({ limit: 5, page: 3 });
    });
});

describe('search_tasks', () => {
    it('passes the query through', async () => {
        const tembo = makeMockTembo();
        const client = await connect(tembo);
        const result = (await client.callTool({
            name: 'search_tasks',
            arguments: { q: 'deploy' },
        })) as CallToolResult;
        expect(result.isError).toBeFalsy();
        expect(tembo.task.search).toHaveBeenCalledWith({ q: 'deploy', limit: 10, page: 1 });
    });
});

describe('list_repositories', () => {
    it('returns repository data as JSON text', async () => {
        const client = await connect(makeMockTembo());
        const result = (await client.callTool({
            name: 'list_repositories',
            arguments: {},
        })) as CallToolResult;
        expect(result.isError).toBeFalsy();
        expect(resultJson(result)).toEqual({ repositories: [{ url: 'https://github.com/a/b' }] });
    });
});

describe('get_current_user', () => {
    it('returns user data as JSON text', async () => {
        const client = await connect(makeMockTembo());
        const result = (await client.callTool({
            name: 'get_current_user',
            arguments: {},
        })) as CallToolResult;
        expect(result.isError).toBeFalsy();
        expect(resultJson(result)).toEqual({ email: 'user@example.com' });
    });

    it('returns isError when the SDK rejects', async () => {
        const tembo = makeMockTembo();
        tembo.me.retrieve.mockRejectedValue(new Error('unauthorized'));
        const client = await connect(tembo);
        const result = (await client.callTool({
            name: 'get_current_user',
            arguments: {},
        })) as CallToolResult;
        expect(result.isError).toBe(true);
        expect(resultText(result)).toBe('Error: unauthorized');
    });
});
