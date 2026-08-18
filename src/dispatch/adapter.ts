import type { ModelReview } from '../consensus/types.js';

export interface AdapterOptions {
  timeoutMs: number;
  maxRetries: number;
  /**
   * External cancellation (quorum round closure). Adapters must abort the
   * in-flight request when it fires so canceled calls stop consuming
   * provider time and the process can exit.
   */
  signal?: AbortSignal;
}

/** A free-text answer from one model (discuss path — no findings schema). */
export interface ModelAnswer {
  model: string;
  provider: string;
  text: string;
  durationMs: number;
  status: 'success' | 'timeout' | 'error';
  error?: string;
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
  /** One-shot free-text question — used by `rcl discuss`. */
  ask(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    options: AdapterOptions
  ): Promise<ModelAnswer>;
}
