import { GoogleGenAI } from '@google/genai';
import { parseReviewOutput } from '../consensus/parser.js';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter, AdapterOptions } from './adapter.js';
import { stripKnownProviderPrefix, retryDelay, sleep } from './utils.js';

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
            },
          });

          if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
            return {
              model,
              role,
              provider: 'google',
              findings: [],
              durationMs: Date.now() - start,
              status: 'error',
              error: 'Response truncated at maxOutputTokens; findings would be incomplete',
            };
          }

          const rawOutput = response.text ?? '';
          const { findings, warnings } = parseReviewOutput(rawOutput, model, role);
          for (const w of warnings) console.warn(w);

          return {
            model,
            role,
            provider: 'google',
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
}
