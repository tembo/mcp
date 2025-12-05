import { z } from 'zod';

export interface TemboClientConfig {
    apiKey: string;
    baseUrl?: string;
}

export const issueResponseSchema = z.object({
    id: z.string().uuid(),
    title: z.string(),
    description: z.string(),
    status: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    organizationId: z.string().uuid(),
});

export const paginationMetaSchema = z.object({
    totalCount: z.number().int(),
    totalPages: z.number().int(),
    currentPage: z.number().int(),
    pageSize: z.number().int(),
    hasNext: z.boolean(),
    hasPrevious: z.boolean(),
});

export const issueListResponseSchema = z.object({
    issues: z.array(issueResponseSchema),
    meta: paginationMetaSchema,
});

export const issueSearchResponseSchema = z.object({
    issues: z.array(issueResponseSchema),
    meta: paginationMetaSchema,
    query: z.string(),
});

export const codeRepositorySchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    url: z.string().url().optional(),
    branch: z.string().optional(),
    description: z.string().optional(),
    enabledAt: z.string().datetime(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    organizationId: z.string().uuid(),
    integration: z
        .object({
            id: z.string().uuid(),
            type: z.string(),
            name: z.string().optional(),
        })
        .optional(),
});

export const repositoryListResponseSchema = z.object({
    codeRepositories: z.array(codeRepositorySchema),
});

export const currentUserResponseSchema = z.object({
    orgId: z.string().uuid().nullable(),
    userId: z.string().uuid().nullable(),
});

export type Issue = z.infer<typeof issueResponseSchema>;
export type IssueListResponse = z.infer<typeof issueListResponseSchema>;
export type IssueSearchResponse = z.infer<typeof issueSearchResponseSchema>;
export type CodeRepository = z.infer<typeof codeRepositorySchema>;
export type RepositoryListResponse = z.infer<typeof repositoryListResponseSchema>;
export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;

export class TemboAPIError extends Error {
    constructor(
        message: string,
        public statusCode?: number,
        public responseBody?: unknown
    ) {
        super(message);
        this.name = 'TemboAPIError';
    }
}

export class TemboClient {
    private apiKey: string;
    private baseUrl: string;

    constructor(config: TemboClientConfig) {
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl || 'https://api.tembo.io';
    }

    private async request<T>(
        method: string,
        path: string,
        body?: unknown,
        queryParams?: Record<string, string | number>
    ): Promise<T> {
        const url = new URL(path, this.baseUrl);

        if (queryParams) {
            Object.entries(queryParams).forEach(([key, value]) => {
                url.searchParams.append(key, String(value));
            });
        }

        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
        };

        const options: RequestInit = {
            method,
            headers,
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        try {
            const response = await fetch(url.toString(), options);

            if (!response.ok) {
                const errorBody = await response.text();
                let errorMessage = `HTTP ${response.status}: ${response.statusText}`;

                try {
                    const errorJson = JSON.parse(errorBody);
                    if (errorJson.error) {
                        errorMessage = errorJson.error;
                    }
                } catch {
                    if (errorBody) {
                        errorMessage = errorBody;
                    }
                }

                throw new TemboAPIError(errorMessage, response.status, errorBody);
            }

            const data = await response.json();
            return data as T;
        } catch (error) {
            if (error instanceof TemboAPIError) {
                throw error;
            }
            throw new TemboAPIError(
                `Failed to make request to Tembo API: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    async createTask(params: {
        prompt?: string;
        description?: string;
        repositories?: string[];
        branch?: string | null;
        agent?: string;
        queueRightAway?: boolean;
    }): Promise<Issue> {
        if (!params.prompt && !params.description) {
            throw new TemboAPIError('Either prompt or description is required');
        }

        const response = await this.request<Issue>(
            'POST',
            '/public-api/task/create',
            params
        );

        return issueResponseSchema.parse(response);
    }

    async listTasks(params?: {
        limit?: number;
        page?: number;
    }): Promise<IssueListResponse> {
        const queryParams: Record<string, number> = {};

        if (params?.limit !== undefined) {
            queryParams.limit = params.limit;
        }
        if (params?.page !== undefined) {
            queryParams.page = params.page;
        }

        const response = await this.request<IssueListResponse>(
            'GET',
            '/public-api/task/list',
            undefined,
            queryParams
        );

        return issueListResponseSchema.parse(response);
    }

    async searchTasks(params: {
        q: string;
        limit?: number;
        page?: number;
    }): Promise<IssueSearchResponse> {
        const queryParams: Record<string, string | number> = {
            q: params.q,
        };

        if (params.limit !== undefined) {
            queryParams.limit = params.limit;
        }
        if (params.page !== undefined) {
            queryParams.page = params.page;
        }

        const response = await this.request<IssueSearchResponse>(
            'GET',
            '/public-api/task/search',
            undefined,
            queryParams
        );

        return issueSearchResponseSchema.parse(response);
    }

    async listRepositories(): Promise<RepositoryListResponse> {
        const response = await this.request<RepositoryListResponse>(
            'GET',
            '/public-api/repository/list'
        );

        return repositoryListResponseSchema.parse(response);
    }

    async getCurrentUser(): Promise<CurrentUserResponse> {
        const response = await this.request<CurrentUserResponse>(
            'GET',
            '/public-api/me'
        );

        return currentUserResponseSchema.parse(response);
    }
}

