import Anthropic from '@anthropic-ai/sdk';
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
  return err instanceof Anthropic.APIError && isRetryableStatus(err.status);
}

export class AnthropicAdapter implements ReviewAdapter {
  name = 'anthropic';
  provider = 'anthropic';

  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env['ANTHROPIC_API_KEY'],
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

    try {
      for (let attempt = 0; attempt <= (options.maxRetries ?? 3); attempt++) {
        try {
          // Use tool use for reliable JSON extraction
          const response = await this.client.messages.create(
            {
              model: modelId,
              max_tokens: 16384,
              system: systemPrompt,
              messages: [{ role: 'user', content: userPrompt }],
              tools: [
                {
                  name: 'report_findings',
                  description: 'Report code review findings as structured JSON',
                  input_schema: {
                    type: 'object' as const,
                    properties: {
                      findings: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            file: { type: 'string' },
                            startLine: { type: 'number' },
                            endLine: { type: 'number' },
                            severity: {
                              type: 'string',
                              enum: ['critical', 'important', 'minor', 'nitpick'],
                            },
                            category: {
                              type: 'string',
                              enum: ['security', 'correctness', 'best-practices', 'tests', 'api-design'],
                            },
                            title: { type: 'string' },
                            description: { type: 'string' },
                            suggestedFix: { type: 'string' },
                          },
                          required: ['id', 'file', 'startLine', 'endLine', 'severity', 'category', 'title', 'description'],
                        },
                      },
                    },
                    required: ['findings'],
                  },
                },
              ],
              tool_choice: { type: 'any' as const },
            },
            // Buffer above our own timeout so the SDK's request timeout
            // (600s default) never wins the race and misclassifies a
            // timeout as a generic error.
            { signal: controller.signal, timeout: options.timeoutMs + 30_000 }
          );

          if (response.stop_reason === 'max_tokens') {
            return failedReview({
              model,
              role,
              provider: 'anthropic',
              startedAt: start,
              error: 'Response truncated at max_tokens; findings would be incomplete',
            });
          }

          // Safety classifiers decline in-band: HTTP 200, no content. Left
          // unhandled this reads as a clean review of code nobody looked at.
          if (response.stop_reason === 'refusal') {
            const details = response.stop_details;
            const category =
              details !== null && details !== undefined && 'category' in details
                ? (details.category as string | null)
                : null;
            return failedReview({
              model,
              role,
              provider: 'anthropic',
              startedAt: start,
              error: `Model refused this review${category ? ` (${category})` : ''} — the diff was not reviewed`,
            });
          }

          // Extract from tool use
          let rawOutput = '';
          for (const block of response.content) {
            if (block.type === 'tool_use' && block.name === 'report_findings') {
              rawOutput = JSON.stringify(block.input);
              break;
            }
            if (block.type === 'text') {
              rawOutput += block.text;
            }
          }

          if (isBlankOutput(rawOutput)) {
            return failedReview({
              model,
              role,
              provider: 'anthropic',
              startedAt: start,
              error: 'Model returned an empty response; the diff was not reviewed',
            });
          }

          // If tool wasn't used, parse text output
          const parsed = parseReviewOutput(rawOutput, model, role);
          for (const w of parsed.warnings) console.warn(w);

          return reviewFromParse({
            model,
            role,
            provider: 'anthropic',
            startedAt: start,
            parsed,
          });
        } catch (err) {
          lastErr = err;
          if (controller.signal.aborted) {
            return {
              model,
              role,
              provider: 'anthropic',
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
      provider: 'anthropic',
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
        const response = await this.client.messages.create(
          {
            model: modelId,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          },
          { signal, timeout: options.timeoutMs + 30_000 }
        );
        return response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim();
      },
    });

    const durationMs = Date.now() - start;
    return outcome.ok
      ? { model, provider: 'anthropic', text: outcome.value, durationMs, status: 'success' }
      : {
          model,
          provider: 'anthropic',
          text: '',
          durationMs,
          status: outcome.timedOut ? 'timeout' : 'error',
          error: outcome.error,
        };
  }
}
