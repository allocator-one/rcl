import { AnthropicAdapter } from './anthropic.js';
import { OpenAIAdapter } from './openai.js';
import { GoogleAdapter } from './google.js';
import { OpenAICompatAdapter } from './openai-compat.js';
function getAdapter(provider) {
    switch (provider) {
        case 'anthropic':
            return new AnthropicAdapter();
        case 'openai':
            return new OpenAIAdapter();
        case 'google':
            return new GoogleAdapter();
        default:
            return new OpenAICompatAdapter();
    }
}
async function runBatch(calls, options) {
    const adapterOpts = {
        timeoutMs: options.timeoutMs,
        maxRetries: options.maxRetries,
    };
    const results = await Promise.allSettled(calls.map(async (call) => {
        const adapter = getAdapter(call.provider);
        const review = await adapter.review(call.model, call.role, call.systemPrompt, call.userPrompt, adapterOpts);
        if (review.status === 'error') {
            console.error(`[DEBUG] ${call.model}/${call.role}: ${review.error}`);
        }
        options.onReviewComplete?.(review);
        return review;
    }));
    return results.map((r, i) => {
        if (r.status === 'fulfilled')
            return r.value;
        const call = calls[i];
        return {
            model: call.model,
            role: call.role,
            provider: call.provider,
            findings: [],
            durationMs: 0,
            status: 'error',
            error: String(r.reason),
        };
    });
}
export async function runReviews(assignments, prompts, options) {
    if (assignments.length !== prompts.length) {
        throw new Error('assignments and prompts arrays must have same length');
    }
    const calls = assignments.map((a, i) => ({
        model: a.model,
        role: a.role.name,
        provider: a.provider,
        systemPrompt: prompts[i].systemPrompt,
        userPrompt: prompts[i].userPrompt,
    }));
    // Process in batches of concurrency size
    const { concurrency } = options;
    const allResults = [];
    for (let i = 0; i < calls.length; i += concurrency) {
        const batch = calls.slice(i, i + concurrency);
        const batchResults = await runBatch(batch, options);
        allResults.push(...batchResults);
    }
    return allResults;
}
//# sourceMappingURL=runner.js.map