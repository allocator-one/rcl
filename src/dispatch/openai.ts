import OpenAI from 'openai';
import { parseReviewOutput } from '../consensus/parser.js';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter, AdapterOptions } from './adapter.js';
import { stripKnownProviderPrefix } from './utils.js';

const RETRY_DELAYS = [1000, 2000, 4000];

function isRetryable(status: number): boolean {
  return status === 429 || status === 500 || status === 503;
}

export class OpenAIAdapter implements ReviewAdapter {
  name = 'openai';
  provider = 'openai';

  private client: OpenAI;

  constructor(apiKey?: string, baseUrl?: string) {
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env['OPENAI_API_KEY'],
      baseURL: baseUrl,
    });
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
    // Use max_completion_tokens for gpt-5.x and o-series; max_tokens for everything else
    const usesCompletionTokens = modelId.startsWith('gpt-5') || /^o[134]/.test(modelId);

    for (let attempt = 0; attempt <= (options.maxRetries ?? 3); attempt++) {
      try {
        const response = await this.client.chat.completions.create(
          {
            model: modelId,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            response_format: { type: 'json_object' },
            ...(usesCompletionTokens
              ? { max_completion_tokens: 16384 }
              : { max_tokens: 16384 }),
          },
          { signal: controller.signal }
        );

        clearTimeout(timeoutHandle);

        const rawOutput = response.choices[0]?.message?.content ?? '';
        const { findings, warnings } = parseReviewOutput(rawOutput, model, role);
        for (const w of warnings) console.warn(w);

        return {
          model,
          role,
          provider: 'openai',
          findings,
          durationMs: Date.now() - start,
          status: 'success',
        };
      } catch (err) {
        lastErr = err;
        if (err instanceof Error && err.name === 'AbortError') {
          clearTimeout(timeoutHandle);
          return {
            model,
            role,
            provider: 'openai',
            findings: [],
            durationMs: Date.now() - start,
            status: 'timeout',
            error: 'Request timed out',
          };
        }
        if (
          err instanceof OpenAI.APIError &&
          isRetryable(err.status ?? 0) &&
          attempt < (options.maxRetries ?? 3)
        ) {
          const delay = RETRY_DELAYS[attempt] ?? 4000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break;
      }
    }

    clearTimeout(timeoutHandle);
    const errMsg = lastErr instanceof Error ? `${lastErr.name}: ${lastErr.message}` : String(lastErr);
    return {
      model,
      role,
      provider: 'openai',
      findings: [],
      durationMs: Date.now() - start,
      status: 'error',
      error: errMsg,
    };
  }
}
