import { GoogleGenAI } from '@google/genai';
import { parseReviewOutput } from '../consensus/parser.js';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter, AdapterOptions } from './adapter.js';

const RETRY_DELAYS = [1000, 2000, 4000];

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
    let lastErr: unknown;

    const modelId = model.includes('/') ? model.split('/').slice(1).join('/') : model;

    for (let attempt = 0; attempt <= (options.maxRetries ?? 3); attempt++) {
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT')), options.timeoutMs)
        );

        const callPromise = this.client.models.generateContent({
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
            maxOutputTokens: 4096,
          },
        });

        const response = await Promise.race([callPromise, timeoutPromise]);

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
        if (err instanceof Error && err.message === 'TIMEOUT') {
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

        const errStr = String(err);
        const isRetryable =
          errStr.includes('429') ||
          errStr.includes('500') ||
          errStr.includes('503') ||
          errStr.includes('RESOURCE_EXHAUSTED');

        if (isRetryable && attempt < (options.maxRetries ?? 3)) {
          const delay = RETRY_DELAYS[attempt] ?? 4000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break;
      }
    }

    return {
      model,
      role,
      provider: 'google',
      findings: [],
      durationMs: Date.now() - start,
      status: 'error',
      error: String(lastErr),
    };
  }
}
