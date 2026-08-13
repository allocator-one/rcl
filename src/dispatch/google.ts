import { GoogleGenAI } from '@google/genai';
import { parseReviewOutput } from '../consensus/parser.js';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter, AdapterOptions, ModelAnswer } from './adapter.js';
import {
  stripKnownProviderPrefix,
  retryDelay,
  sleep,
  attemptWithRetries,
  failedReview,
  isBlankOutput,
  reviewFromParse,
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
  const errStr = String(err);
  return (
    errStr.includes('429') ||
    errStr.includes('500') ||
    errStr.includes('502') ||
    errStr.includes('503') ||
    errStr.includes('504') ||
    errStr.includes('RESOURCE_EXHAUSTED')
  );
}

export class GoogleAdapter implements ReviewAdapter {
  name = 'google';
  provider = 'google';

  private client: GoogleGenAI;

  constructor(apiKey?: string) {
    this.client = new GoogleGenAI({
      apiKey: apiKey ?? process.env['GOOGLE_API_KEY'] ?? process.env['GEMINI_API_KEY'],
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

    try {
      for (let attempt = 0; attempt <= (options.maxRetries ?? 3); attempt++) {
        try {
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
              abortSignal: controller.signal,
              // Same buffer as the other adapters: keep the SDK's own
              // request timeout above ours so the AbortController stays
              // the sole owner of timeout classification.
              httpOptions: { timeout: options.timeoutMs + 30_000 },
            },
          });

          const finishReason = response.candidates?.[0]?.finishReason;
          if (finishReason === 'MAX_TOKENS') {
            return failedReview({
              model,
              role,
              provider: 'google',
              startedAt: start,
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
          });
        } catch (err) {
          lastErr = err;
          if (controller.signal.aborted) {
            return {
              model,
              role,
              provider: 'google',
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
      provider: 'google',
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

    const outcome = await attemptWithRetries({
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries ?? 3,
      isRetryable,
      attempt: async (signal) => {
        const response = await this.client.models.generateContent({
          model: modelId,
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          config: {
            systemInstruction: systemPrompt,
            maxOutputTokens: 8192,
            abortSignal: signal,
            httpOptions: { timeout: options.timeoutMs + 30_000 },
          },
        });
        return (response.text ?? '').trim();
      },
    });

    const durationMs = Date.now() - start;
    return outcome.ok
      ? { model, provider: 'google', text: outcome.value, durationMs, status: 'success' }
      : {
          model,
          provider: 'google',
          text: '',
          durationMs,
          status: outcome.timedOut ? 'timeout' : 'error',
          error: outcome.error,
        };
  }
}
