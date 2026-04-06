import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter, AdapterOptions } from './adapter.js';
/**
 * Generic OpenAI-compatible adapter for local models (Ollama, LM Studio, etc.)
 * and other OpenAI-compatible APIs.
 */
export declare class OpenAICompatAdapter implements ReviewAdapter {
    name: string;
    provider: string;
    private client;
    private useJsonMode;
    constructor(opts?: {
        apiKey?: string;
        baseUrl?: string;
        useJsonMode?: boolean;
    });
    review(model: string, role: string, systemPrompt: string, userPrompt: string, options: AdapterOptions): Promise<ModelReview>;
}
