export function detectProvider(model) {
    // Handle explicit provider prefix (e.g. "anthropic/claude-sonnet-4-5")
    if (model.startsWith('anthropic/'))
        return 'anthropic';
    if (model.startsWith('openai/'))
        return 'openai';
    if (model.startsWith('google/'))
        return 'google';
    // Detect by model name prefix
    if (model.startsWith('claude'))
        return 'anthropic';
    if (model.startsWith('gpt') ||
        model.startsWith('o1') ||
        model.startsWith('o3') ||
        model.startsWith('o4'))
        return 'openai';
    if (model.startsWith('gemini'))
        return 'google';
    // OpenAI-compatible for anything else (local models, etc.)
    return 'openai-compat';
}
function shuffle(arr) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
/**
 * Build assignments from explicit reviewer pairs (--reviewer model:role)
 */
export function buildExplicitAssignments(reviewerPairs, roleMap) {
    return reviewerPairs.flatMap(({ model, role: roleName }) => {
        const role = roleMap.get(roleName);
        if (!role) {
            console.warn(`Warning: unknown role "${roleName}" in reviewer pair, skipping`);
            return [];
        }
        return [{ model, role, provider: detectProvider(model) }];
    });
}
/**
 * Build assignments using the dispatch algorithm:
 * - general role: runs on ALL models
 * - specialized roles: spread across models via shuffled round-robin
 */
export function buildRoleAssignments(models, roles) {
    const assignments = [];
    const generalRoles = roles.filter((r) => !r.isSpecialized);
    const specializedRoles = roles.filter((r) => r.isSpecialized);
    // General roles: every model runs every general role
    for (const model of models) {
        for (const role of generalRoles) {
            assignments.push({
                model,
                role,
                provider: detectProvider(model),
            });
        }
    }
    // Specialized roles: shuffled round-robin across models
    if (specializedRoles.length > 0 && models.length > 0) {
        const shuffledModels = shuffle(models);
        specializedRoles.forEach((role, index) => {
            const model = shuffledModels[index % shuffledModels.length];
            assignments.push({
                model,
                role,
                provider: detectProvider(model),
            });
        });
    }
    return assignments;
}
/**
 * Main dispatch builder — handles explicit pairs or role-based assignment
 */
export function buildAssignments(opts) {
    if (opts.explicitReviewers && opts.explicitReviewers.length > 0) {
        return buildExplicitAssignments(opts.explicitReviewers, opts.roleMap);
    }
    return buildRoleAssignments(opts.models, opts.roles);
}
//# sourceMappingURL=dispatcher.js.map