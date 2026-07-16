import OpenAI from 'openai';
import { parseReviewOutput } from '../consensus/parser.js';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter, AdapterOptions } from './adapter.js';
import { stripKnownProviderPrefix, isRetryableStatus, retryDelay, sleep } from './utils.js';

function isRetryable(err: unknown): boolean {
  return err instanceof OpenAI.APIError && isRetryableStatus(err.status);
}

/**
 * Generic OpenAI-compatible adapter for local models (Ollama, LM Studio, etc.)
 * and other OpenAI-compatible APIs.
 */
export class OpenAICompatAdapter implements ReviewAdapter {
  name = 'openai-compat';
  provider = 'openai-compat';

  private client: OpenAI;
  private useJsonMode: boolean;

  constructor(opts?: {
    apiKey?: string;
    baseUrl?: string;
    useJsonMode?: boolean;
  }) {
    this.client = new OpenAI({
      apiKey: opts?.apiKey ?? process.env['OPENAI_COMPAT_API_KEY'] ?? 'local',
      baseURL: opts?.baseUrl ?? process.env['OPENAI_COMPAT_BASE_URL'] ?? 'http://localhost:11434/v1',
      // The adapter's retry loop owns all retries; SDK-internal retries
      // would multiply wire attempts inside one timeout budget.
      maxRetries: 0,
    });
    this.useJsonMode = opts?.useJsonMode ?? true;
  }

  async review(
    model: string,
    role: string,
    systemPrompt: string,
    userPrompt: string,
    options: AdapterOptions
  ): Promise<ModelReview> {
    const start = Date.now();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), options.timeoutMs);

    let lastErr: unknown = new Error('no attempts made');
    const modelId = stripKnownProviderPrefix(model);

    try {
      for (let attempt = 0; attempt <= (options.maxRetries ?? 3); attempt++) {
        try {
          const createParams: Parameters<typeof this.client.chat.completions.create>[0] = {
            model: modelId,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            max_tokens: 16384,
          };

          if (this.useJsonMode) {
            createParams.response_format = { type: 'json_object' };
          }

          const response = await this.client.chat.completions.create(
            createParams,
            { signal: controller.signal }
          ) as OpenAI.ChatCompletion;

          const choice = response.choices[0];
          if (choice?.finish_reason === 'length') {
            return {
              model,
              role,
              provider: 'openai-compat',
              findings: [],
              durationMs: Date.now() - start,
              status: 'error',
              error: 'Response truncated at token limit; findings would be incomplete',
            };
          }

          const rawOutput = choice?.message?.content ?? '';
          const { findings, warnings } = parseReviewOutput(rawOutput, model, role);
          for (const w of warnings) console.warn(w);

          return {
            model,
            role,
            provider: 'openai-compat',
            findings,
            durationMs: Date.now() - start,
            status: 'success',
          };
        } catch (err) {
          lastErr = err;
          if (controller.signal.aborted) {
            return {
              model,
              role,
              provider: 'openai-compat',
              findings: [],
              durationMs: Date.now() - start,
              status: 'timeout',
              error: 'Request timed out',
            };
          }
          if (isRetryable(err) && attempt < (options.maxRetries ?? 3)) {
            await sleep(retryDelay(attempt));
            continue;
          }
          break;
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
    }

    const errMsg = lastErr instanceof Error ? `${lastErr.name}: ${lastErr.message}` : String(lastErr);
    return {
      model,
      role,
      provider: 'openai-compat',
      findings: [],
      durationMs: Date.now() - start,
      status: 'error',
      error: errMsg,
    };
  }
}
