export function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
        promise.then((val) => { clearTimeout(timer); resolve(val); }, (err) => { clearTimeout(timer); reject(err); });
    });
}
export function parseProviderFromModel(model) {
    if (model.startsWith('claude'))
        return 'anthropic';
    if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4'))
        return 'openai';
    if (model.startsWith('gemini'))
        return 'google';
    // format: provider/model
    if (model.includes('/'))
        return model.split('/')[0];
    return 'openai'; // default for unknown
}
export function stripProviderPrefix(model) {
    if (model.includes('/'))
        return model.split('/').slice(1).join('/');
    return model;
}
//# sourceMappingURL=adapter.js.map