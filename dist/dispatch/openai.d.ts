import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter, AdapterOptions } from './adapter.js';
export declare class OpenAIAdapter implements ReviewAdapter {
    name: string;
    provider: string;
    private client;
    constructor(apiKey?: string, baseUrl?: string);
    review(model: string, role: string, systemPrompt: string, userPrompt: string, options: AdapterOptions): Promise<ModelReview>;
}
