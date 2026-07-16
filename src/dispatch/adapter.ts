import type { ModelReview } from '../consensus/types.js';

export interface AdapterOptions {
  timeoutMs: number;
  maxRetries: number;
}

export interface ReviewAdapter {
  name: string;
  provider: string;
  review(
    model: string,
    role: string,
    systemPrompt: string,
    userPrompt: string,
    options: AdapterOptions
  ): Promise<ModelReview>;
}
