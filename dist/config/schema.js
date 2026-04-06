import { z } from 'zod';
export const SeveritySchema = z.enum(['critical', 'important', 'minor', 'nitpick']);
export const CategorySchema = z.enum([
    'security',
    'correctness',
    'best-practices',
    'tests',
    'api-design',
]);
export const ReviewerPairSchema = z.object({
    model: z.string(),
    role: z.string(),
});
export const RoleConfigSchema = z.object({
    name: z.string(),
    systemPrompt: z.string().optional(),
    focus: z.array(z.string()).optional(),
    severityBias: z.record(z.string(), z.number()).optional(),
});
export const ThresholdsSchema = z.object({
    minConsensusScore: z.number().min(0).max(1).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    dedupeLineWindow: z.number().int().positive().optional(),
    jaccardThreshold: z.number().min(0).max(1).optional(),
});
export const OutputSchema = z.object({
    terminal: z.boolean().optional(),
    json: z.boolean().optional(),
    markdown: z.boolean().optional(),
    github: z.boolean().optional(),
    jsonPath: z.string().optional(),
    markdownPath: z.string().optional(),
});
export const ConfigSchema = z.object({
    models: z.array(z.string()).optional(),
    roles: z.array(z.string()).optional(),
    reviewers: z.array(ReviewerPairSchema).optional(),
    customRoles: z.array(RoleConfigSchema).optional(),
    thresholds: ThresholdsSchema.optional(),
    output: OutputSchema.optional(),
    timeout: z.number().positive().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
    concurrency: z.number().int().positive().optional(),
    githubToken: z.string().optional(),
    context: z.array(z.string()).optional(),
    spec: z.string().optional(),
    focus: z.array(z.string()).optional(),
});
//# sourceMappingURL=schema.js.map