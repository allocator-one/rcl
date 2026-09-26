import { ApiError, GoogleGenAI } from '@google/genai';
import { parseReviewOutput } from '../consensus/parser.js';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter, AdapterOptions, ModelAnswer } from './adapter.js';
import {
  stripKnownProviderPrefix,
  attemptWithRetries,
  isRetryableConnectionError,
  isRetryableStatus,
  failedReview,
  isBlankOutput,
  reviewFromParse,
  usageFromGoogle,
  ASK_MAX_OUTPUT_TOKENS,
  TruncatedAnswerError,
} from './utils.js';

/**
 * Gemini finish reasons that mean "this was not reviewed". Distinct from
 * MAX_TOKENS (truncation, handled separately) — these produce a candidate
 * with no usable text.
 */
const BLOCKED_FINISH_REASONS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
  'RECITATION',
]);

function isRetryable(err: unknown): boolean {
  return err instanceof ApiError ? isRetryableStatus(err.status) : isRetryableConnectionError(err);
}

export class GoogleAdapter implements ReviewAdapter {
  name = 'google';
  provider = 'google';

  private client: GoogleGenAI;

  constructor(apiKey?: string) {
    this.client = new GoogleGenAI({
      apiKey: apiKey?.trim() || process.env['GOOGLE_API_KEY']?.trim() || process.env['GEMINI_API_KEY']?.trim() || undefined,
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

    const outcome = await attemptWithRetries<ModelReview>({
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries ?? 3,
      signal: options.signal,
      isRetryable,
      attempt: async (signal) => {
        adapterAttempts++;
        const response = await this.client.models.generateContent({
          model: modelId,
          contents: [
            {
              role: 'user',
              parts: [{ text: userPrompt }],
            },
          ],
          config: {
            systemInstruction: systemPrompt,
            responseMimeType: 'application/json',
            maxOutputTokens: 65536,
            abortSignal: signal,
            // Same buffer as the other adapters: keep the SDK's own
            // request timeout above ours so the AbortController stays
            // the sole owner of timeout classification.
            httpOptions: { timeout: options.timeoutMs + 30_000 },
          },
        });
        const usage = usageFromGoogle(response.usageMetadata);

        const finishReason = response.candidates?.[0]?.finishReason;
        if (finishReason === 'MAX_TOKENS') {
          return failedReview({
            model,
            role,
            provider: 'google',
            startedAt: start,
            usage,
            error: 'Response truncated at maxOutputTokens; findings would be incomplete',
          });
        }

        // Gemini blocks in-band too: a safety stop yields a candidate with
        // no usable text rather than an API error.
        if (finishReason !== undefined && BLOCKED_FINISH_REASONS.has(finishReason)) {
          return failedReview({
            model,
            role,
            provider: 'google',
            startedAt: start,
            usage,
            error: `Model refused this review (${finishReason}) — the diff was not reviewed`,
          });
        }

        const rawOutput = response.text ?? '';
        if (isBlankOutput(rawOutput)) {
          return failedReview({
            model,
            role,
            provider: 'google',
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
          provider: 'google',
          startedAt: start,
          parsed,
          usage,
        });
      },
    });
    return outcome.ok
      ? { ...outcome.value, adapterAttempts }
      : { ...failedReview({ model, role, provider: 'google', startedAt: start,
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

    let adapterAttempts = 0;
    const outcome = await attemptWithRetries({
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries ?? 3,
      signal: options.signal,
      isRetryable,
      attempt: async (signal) => {
        adapterAttempts++;
        const response = await this.client.models.generateContent({
          model: modelId,
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          config: {
            systemInstruction: systemPrompt,
            maxOutputTokens: ASK_MAX_OUTPUT_TOKENS,
            abortSignal: signal,
            httpOptions: { timeout: options.timeoutMs + 30_000 },
          },
        });
        // A thinking model spends this budget on reasoning before it emits a
        // token of answer, so a truncated response arrives as empty or partial
        // text with a success status. Silently returning it makes a verifier
        // answer that covers no findings look like a model that had nothing to
        // say — every finding then gates unrefuted.
        if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
          throw new TruncatedAnswerError('google');
        }
        return (response.text ?? '').trim();
      },
    });

    const durationMs = Date.now() - start;
    return outcome.ok
      ? { model, provider: 'google', text: outcome.value, durationMs, adapterAttempts, status: 'success' }
      : {
          model,
          provider: 'google',
          text: '',
          durationMs,
          adapterAttempts,
          status: outcome.timedOut ? 'timeout' : 'error',
          error: outcome.error,
        };
  }
}
