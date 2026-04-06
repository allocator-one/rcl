import OpenAI from 'openai';
import { parseReviewOutput } from '../consensus/parser.js';
const RETRY_DELAYS = [1000, 2000, 4000];
/**
 * Generic OpenAI-compatible adapter for local models (Ollama, LM Studio, etc.)
 * and other OpenAI-compatible APIs.
 */
export class OpenAICompatAdapter {
    name = 'openai-compat';
    provider = 'openai-compat';
    client;
    useJsonMode;
    constructor(opts) {
        this.client = new OpenAI({
            apiKey: opts?.apiKey ?? process.env['OPENAI_COMPAT_API_KEY'] ?? 'local',
            baseURL: opts?.baseUrl ?? process.env['OPENAI_COMPAT_BASE_URL'] ?? 'http://localhost:11434/v1',
        });
        this.useJsonMode = opts?.useJsonMode ?? true;
    }
    async review(model, role, systemPrompt, userPrompt, options) {
        const start = Date.now();
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), options.timeoutMs);
        let lastErr;
        for (let attempt = 0; attempt <= (options.maxRetries ?? 3); attempt++) {
            try {
                const createParams = {
                    model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    max_tokens: 4096,
                };
                if (this.useJsonMode) {
                    createParams.response_format = { type: 'json_object' };
                }
                const response = await this.client.chat.completions.create(createParams, { signal: controller.signal });
                clearTimeout(timeoutHandle);
                const rawOutput = response.choices[0]?.message?.content ?? '';
                const { findings, warnings } = parseReviewOutput(rawOutput, model, role);
                for (const w of warnings)
                    console.warn(w);
                return {
                    model,
                    role,
                    provider: 'openai-compat',
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
                        provider: 'openai-compat',
                        findings: [],
                        durationMs: Date.now() - start,
                        status: 'timeout',
                        error: 'Request timed out',
                    };
                }
                if (err instanceof OpenAI.APIError &&
                    (err.status === 429 || err.status === 500 || err.status === 503) &&
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
            provider: 'openai-compat',
            findings: [],
            durationMs: Date.now() - start,
            status: 'error',
            error: String(lastErr),
        };
    }
}
//# sourceMappingURL=openai-compat.js.map