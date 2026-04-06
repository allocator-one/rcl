import OpenAI from 'openai';
import { parseReviewOutput } from '../consensus/parser.js';
const RETRY_DELAYS = [1000, 2000, 4000];
function isRetryable(status) {
    return status === 429 || status === 500 || status === 503;
}
export class OpenAIAdapter {
    name = 'openai';
    provider = 'openai';
    client;
    constructor(apiKey, baseUrl) {
        this.client = new OpenAI({
            apiKey: apiKey ?? process.env['OPENAI_API_KEY'],
            baseURL: baseUrl,
        });
    }
    async review(model, role, systemPrompt, userPrompt, options) {
        const start = Date.now();
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), options.timeoutMs);
        let lastErr;
        const modelId = model.includes('/') ? model.split('/').slice(1).join('/') : model;
        for (let attempt = 0; attempt <= (options.maxRetries ?? 3); attempt++) {
            try {
                const response = await this.client.chat.completions.create({
                    model: modelId,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    response_format: { type: 'json_object' },
                    max_tokens: 4096,
                }, { signal: controller.signal });
                clearTimeout(timeoutHandle);
                const rawOutput = response.choices[0]?.message?.content ?? '';
                const { findings, warnings } = parseReviewOutput(rawOutput, model, role);
                for (const w of warnings)
                    console.warn(w);
                return {
                    model,
                    role,
                    provider: 'openai',
                    findings,
                    durationMs: Date.now() - start,
                    status: 'success',
                };
            }
            catch (err) {
                lastErr = err;
                if (err instanceof Error && err.name === 'AbortError') {
                    clearTimeout(timeoutHandle);
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
                if (err instanceof OpenAI.APIError &&
                    isRetryable(err.status ?? 0) &&
                    attempt < (options.maxRetries ?? 3)) {
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
            provider: 'openai',
            findings: [],
            durationMs: Date.now() - start,
            status: 'error',
            error: String(lastErr),
        };
    }
}
//# sourceMappingURL=openai.js.map