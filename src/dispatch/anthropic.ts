import Anthropic from '@anthropic-ai/sdk';
import { parseReviewOutput } from '../consensus/parser.js';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter, AdapterOptions } from './adapter.js';

const RETRY_DELAYS = [1000, 2000, 4000];

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    return err.status === 429 || err.status === 500 || err.status === 503;
  }
  return false;
}

export class AnthropicAdapter implements ReviewAdapter {
  name = 'anthropic';
  provider = 'anthropic';

  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env['ANTHROPIC_API_KEY'],
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

    let lastErr: unknown;

    for (let attempt = 0; attempt <= (options.maxRetries ?? 3); attempt++) {
      try {
        // Use tool use for reliable JSON extraction
        const response = await this.client.messages.create(
          {
            model,
            max_tokens: 4096,
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
          { signal: controller.signal }
        );

        clearTimeout(timeoutHandle);

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

        // If tool wasn't used, parse text output
        const { findings, warnings } = parseReviewOutput(rawOutput, model, role);
        for (const w of warnings) console.warn(w);

        return {
          model,
          role,
          provider: 'anthropic',
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
            provider: 'anthropic',
            findings: [],
            durationMs: Date.now() - start,
            status: 'timeout',
            error: 'Request timed out',
          };
        }
        if (isRetryable(err) && attempt < (options.maxRetries ?? 3)) {
          const delay = RETRY_DELAYS[attempt] ?? 4000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break;
      }
    }

    clearTimeout(timeoutHandle);
    return {
      model,
      role,
      provider: 'anthropic',
      findings: [],
      durationMs: Date.now() - start,
      status: 'error',
      error: String(lastErr),
    };
  }
}
