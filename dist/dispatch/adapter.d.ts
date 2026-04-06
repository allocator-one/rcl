import type { ModelReview } from '../consensus/types.js';
export interface AdapterOptions {
    timeoutMs: number;
    maxRetries: number;
    apiKey?: string;
    baseUrl?: string;
}
export interface ReviewAdapter {
    name: string;
    provider: string;
    review(model: string, role: string, systemPrompt: string, userPrompt: string, options: AdapterOptions): Promise<ModelReview>;
}
export declare function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>;
export declare function parseProviderFromModel(model: string): string;
export declare function stripProviderPrefix(model: string): string;
