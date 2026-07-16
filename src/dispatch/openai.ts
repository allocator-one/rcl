import OpenAI from 'openai';
import { parseReviewOutput } from '../consensus/parser.js';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter, AdapterOptions } from './adapter.js';
import { stripKnownProviderPrefix, isRetryableStatus, retryDelay, sleep } from './utils.js';

function isRetryable(err: unknown): boolean {
  return err instanceof OpenAI.APIError && isRetryableStatus(err.status);
}

export class OpenAIAdapter implements ReviewAdapter {
  name = 'openai';
  provider = 'openai';

  private client: OpenAI;

  constructor(apiKey?: string, baseUrl?: string) {
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env['OPENAI_API_KEY'],
      baseURL: baseUrl,
      // The adapter's retry loop owns all retries; SDK-internal retries
      // would multiply wire attempts inside one timeout budget.
      maxRetries: 0,
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

    try {
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

          const choice = response.choices[0];
          if (choice?.finish_reason === 'length') {
            return {
              model,
              role,
              provider: 'openai',
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
            provider: 'openai',
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
              provider: 'openai',
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
      provider: 'openai',
      findings: [],
      durationMs: Date.now() - start,
      status: 'error',
      error: errMsg,
    };
  }
}
