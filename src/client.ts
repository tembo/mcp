import Tembo from '@tembo-io/sdk';

export interface TemboClientConfig {
    apiKey: string;
    baseUrl?: string;
}

export function createTemboClient(config: TemboClientConfig) {
    return new Tembo({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
    });
}

export type TemboClient = ReturnType<typeof createTemboClient>;
