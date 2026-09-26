import OpenAI from 'openai';
import { parseReviewOutput } from '../consensus/parser.js';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter, AdapterOptions, ModelAnswer } from './adapter.js';
import {
  stripKnownProviderPrefix,
  isRetryableStatus,
  attemptWithRetries,
  isRetryableConnectionError,
  failedReview,
  isBlankOutput,
  reviewFromParse,
  usageFromOpenAI,
  ASK_MAX_OUTPUT_TOKENS,
  TruncatedAnswerError,
} from './utils.js';

function isRetryable(err: unknown): boolean {
  if (err instanceof OpenAI.APIConnectionError) return isRetryableConnectionError(err, true);
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
    let adapterAttempts = 0;
    const modelId = stripKnownProviderPrefix(model);
    const usesCompletionTokens = usesMaxCompletionTokens(modelId);

    const outcome = await attemptWithRetries<ModelReview>({
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries ?? 3,
      signal: options.signal,
      isRetryable,
      attempt: async (signal) => {
        adapterAttempts++;
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
          { signal: signal, timeout: options.timeoutMs + 30_000 }
        );
        const usage = usageFromOpenAI(response.usage);

        const choice = response.choices[0];
        if (choice?.finish_reason === 'length') {
          return failedReview({
            model,
            role,
            provider: 'openai',
            startedAt: start,
            usage,
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
            usage,
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
            usage,
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
          usage,
        });
      },
    });
    return outcome.ok
      ? { ...outcome.value, adapterAttempts }
      : { ...failedReview({ model, role, provider: 'openai', startedAt: start,
          status: outcome.timedOut ? 'timeout' : 'error', error: outcome.error }), adapterAttempts };
  }

  async ask(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    options: AdapterOptions
  ): Promise<ModelAnswer> {
    const start = Date.now();
    const modelId = stripKnownProviderPrefix(model);
    const usesCompletionTokens = usesMaxCompletionTokens(modelId);

    let adapterAttempts = 0;
    const outcome = await attemptWithRetries({
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries ?? 3,
      signal: options.signal,
      isRetryable,
      attempt: async (signal) => {
        adapterAttempts++;
        const response = await this.client.chat.completions.create(
          {
            model: modelId,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            ...(usesCompletionTokens
              ? { max_completion_tokens: ASK_MAX_OUTPUT_TOKENS }
              : { max_tokens: ASK_MAX_OUTPUT_TOKENS }),
          },
          { signal, timeout: options.timeoutMs + 30_000 }
        );
        // A reasoning model can spend the whole budget before the answer
        // starts. Returning the stub silently costs the verification lane
        // every candidate the answer never reached (RCL-60).
        if (response.choices[0]?.finish_reason === 'length') {
          throw new TruncatedAnswerError('openai');
        }
        return (response.choices[0]?.message?.content ?? '').trim();
      },
    });

    const durationMs = Date.now() - start;
    return outcome.ok
      ? { model, provider: 'openai', text: outcome.value, durationMs, adapterAttempts, status: 'success' }
      : {
          model,
          provider: 'openai',
          text: '',
          durationMs,
          adapterAttempts,
          status: outcome.timedOut ? 'timeout' : 'error',
          error: outcome.error,
        };
  }
}

/**
 * gpt-5+ and every o-series model reject `max_tokens` with HTTP 400. Match by
 * version family so the next generation does not silently fall back to the
 * legacy parameter.
 */
function usesMaxCompletionTokens(modelId: string): boolean {
  const gptMajor = /^gpt-(\d+)/.exec(modelId);
  if (gptMajor) return Number(gptMajor[1]) >= 5;
  return /^o\d/.test(modelId);
}
