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

/**
 * Generic OpenAI-compatible adapter for local models (Ollama, LM Studio, etc.),
 * hosted aggregators like OpenRouter, and other OpenAI-compatible APIs.
 */
export class OpenAICompatAdapter implements ReviewAdapter {
  name: string;
  provider: string;

  private client: OpenAI;
  private useJsonMode: boolean;

  private reasoningEffort: 'low' | 'medium' | 'high' | undefined;

  constructor(opts?: {
    apiKey?: string;
    baseUrl?: string;
    useJsonMode?: boolean;
    /** Provider label reported on reviews (e.g. "openrouter"); defaults to "openai-compat". */
    provider?: string;
    /**
     * OpenRouter's unified reasoning-effort control. Unbounded reasoning
     * makes reasoning models spend the whole completion budget (and many
     * minutes) thinking before they write any findings; effort maps to a
     * fraction of max_tokens (low ~20%, medium ~50%, high ~80%). Ignored
     * by endpoints that don't support it.
     */
    reasoningEffort?: 'low' | 'medium' | 'high';
  }) {
    this.name = opts?.provider ?? 'openai-compat';
    this.provider = opts?.provider ?? 'openai-compat';
    this.reasoningEffort = opts?.reasoningEffort;
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

          if (this.reasoningEffort) {
            // OpenRouter extension; not in the OpenAI SDK's param types.
            (createParams as unknown as Record<string, unknown>)['reasoning'] = {
              effort: this.reasoningEffort,
            };
          }

          const response = await this.client.chat.completions.create(
            createParams,
            // SDK timeout sits above ours (default 600s would tie or undercut
            // large configured timeouts); the buffer keeps our AbortController
            // as the sole owner of timeout classification.
            { signal: controller.signal, timeout: options.timeoutMs + 30_000 }
          ) as OpenAI.ChatCompletion;

          const choice = response.choices[0];
          if (choice?.finish_reason === 'length') {
            return failedReview({
              model,
              role,
              provider: this.provider,
              startedAt: start,
              error: 'Response truncated at token limit; findings would be incomplete',
            });
          }

          // OpenRouter reports an upstream Anthropic refusal as
          // `finish_reason: "content_filter"` with the explanation on
          // `message.refusal` — HTTP 200, no content.
          const refusal = (choice?.message as { refusal?: string } | undefined)?.refusal;
          if (choice?.finish_reason === 'content_filter' || refusal) {
            return failedReview({
              model,
              role,
              provider: this.provider,
              startedAt: start,
              error: `Model refused this review — the diff was not reviewed${refusal ? `: ${refusal}` : ''}`,
            });
          }

          const rawOutput = choice?.message?.content ?? '';
          if (isBlankOutput(rawOutput)) {
            return failedReview({
              model,
              role,
              provider: this.provider,
              startedAt: start,
              error: 'Model returned an empty response; the diff was not reviewed',
            });
          }

          const parsed = parseReviewOutput(rawOutput, model, role);
          for (const w of parsed.warnings) console.warn(w);

          return reviewFromParse({
            model,
            role,
            provider: this.provider,
            startedAt: start,
            parsed,
          });
        } catch (err) {
          lastErr = err;
          if (controller.signal.aborted) {
            return {
              model,
              role,
              provider: this.provider,
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
      provider: this.provider,
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
        const createParams: Parameters<typeof this.client.chat.completions.create>[0] = {
          model: modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 4096,
        };
        if (this.reasoningEffort) {
          // OpenRouter extension; not in the OpenAI SDK's param types.
          (createParams as unknown as Record<string, unknown>)['reasoning'] = {
            effort: this.reasoningEffort,
          };
        }
        const response = (await this.client.chat.completions.create(createParams, {
          signal,
          timeout: options.timeoutMs + 30_000,
        })) as OpenAI.ChatCompletion;
        return (response.choices[0]?.message?.content ?? '').trim();
      },
    });

    const durationMs = Date.now() - start;
    return outcome.ok
      ? { model, provider: this.provider, text: outcome.value, durationMs, status: 'success' }
      : {
          model,
          provider: this.provider,
          text: '',
          durationMs,
          status: outcome.timedOut ? 'timeout' : 'error',
          error: outcome.error,
        };
  }
}
