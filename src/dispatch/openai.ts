import OpenAI from 'openai';
import { parseReviewOutput } from '../consensus/parser.js';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter, AdapterOptions, ModelAnswer } from './adapter.js';
import {
  stripKnownProviderPrefix,
  isRetryableStatus,
  retryDelay,
  sleep,
  attemptWithRetries,
  failedReview,
  isBlankOutput,
  reviewFromParse,
} from './utils.js';

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
            // Buffer above our own timeout so the SDK's request timeout
            // (600s default) never wins the race and misclassifies a
            // timeout as a generic error.
            { signal: controller.signal, timeout: options.timeoutMs + 30_000 }
          );

          const choice = response.choices[0];
          if (choice?.finish_reason === 'length') {
            return failedReview({
              model,
              role,
              provider: 'openai',
              startedAt: start,
              error: 'Response truncated at token limit; findings would be incomplete',
            });
          }

          // A content filter declines in-band with HTTP 200 and no content.
          if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) {
            return failedReview({
              model,
              role,
              provider: 'openai',
              startedAt: start,
              error: `Model refused this review — the diff was not reviewed${
                choice.message?.refusal ? `: ${choice.message.refusal}` : ''
              }`,
            });
          }

          const rawOutput = choice?.message?.content ?? '';
          if (isBlankOutput(rawOutput)) {
            return failedReview({
              model,
              role,
              provider: 'openai',
              startedAt: start,
              error: 'Model returned an empty response; the diff was not reviewed',
            });
          }

          const parsed = parseReviewOutput(rawOutput, model, role);
          for (const w of parsed.warnings) console.warn(w);

          return reviewFromParse({
            model,
            role,
            provider: 'openai',
            startedAt: start,
            parsed,
          });
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

  async ask(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    options: AdapterOptions
  ): Promise<ModelAnswer> {
    const start = Date.now();
    const modelId = stripKnownProviderPrefix(model);
    const usesCompletionTokens = modelId.startsWith('gpt-5') || /^o[134]/.test(modelId);

    const outcome = await attemptWithRetries({
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries ?? 3,
      isRetryable,
      attempt: async (signal) => {
        const response = await this.client.chat.completions.create(
          {
            model: modelId,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            ...(usesCompletionTokens ? { max_completion_tokens: 4096 } : { max_tokens: 4096 }),
          },
          { signal, timeout: options.timeoutMs + 30_000 }
        );
        return (response.choices[0]?.message?.content ?? '').trim();
      },
    });

    const durationMs = Date.now() - start;
    return outcome.ok
      ? { model, provider: 'openai', text: outcome.value, durationMs, status: 'success' }
      : {
          model,
          provider: 'openai',
          text: '',
          durationMs,
          status: outcome.timedOut ? 'timeout' : 'error',
          error: outcome.error,
        };
  }
}
