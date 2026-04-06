import { z } from 'zod';
export declare const SeveritySchema: z.ZodEnum<{
    critical: "critical";
    important: "important";
    minor: "minor";
    nitpick: "nitpick";
}>;
export declare const CategorySchema: z.ZodEnum<{
    security: "security";
    correctness: "correctness";
    "best-practices": "best-practices";
    tests: "tests";
    "api-design": "api-design";
}>;
export declare const ReviewerPairSchema: z.ZodObject<{
    model: z.ZodString;
    role: z.ZodString;
}, z.core.$strip>;
export declare const RoleConfigSchema: z.ZodObject<{
    name: z.ZodString;
    systemPrompt: z.ZodOptional<z.ZodString>;
    focus: z.ZodOptional<z.ZodArray<z.ZodString>>;
    severityBias: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
}, z.core.$strip>;
export declare const ThresholdsSchema: z.ZodObject<{
    minConsensusScore: z.ZodOptional<z.ZodNumber>;
    minConfidence: z.ZodOptional<z.ZodNumber>;
    dedupeLineWindow: z.ZodOptional<z.ZodNumber>;
    jaccardThreshold: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const OutputSchema: z.ZodObject<{
    terminal: z.ZodOptional<z.ZodBoolean>;
    json: z.ZodOptional<z.ZodBoolean>;
    markdown: z.ZodOptional<z.ZodBoolean>;
    github: z.ZodOptional<z.ZodBoolean>;
    jsonPath: z.ZodOptional<z.ZodString>;
    markdownPath: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ConfigSchema: z.ZodObject<{
    models: z.ZodOptional<z.ZodArray<z.ZodString>>;
    roles: z.ZodOptional<z.ZodArray<z.ZodString>>;
    reviewers: z.ZodOptional<z.ZodArray<z.ZodObject<{
        model: z.ZodString;
        role: z.ZodString;
    }, z.core.$strip>>>;
    customRoles: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        systemPrompt: z.ZodOptional<z.ZodString>;
        focus: z.ZodOptional<z.ZodArray<z.ZodString>>;
        severityBias: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    }, z.core.$strip>>>;
    thresholds: z.ZodOptional<z.ZodObject<{
        minConsensusScore: z.ZodOptional<z.ZodNumber>;
        minConfidence: z.ZodOptional<z.ZodNumber>;
        dedupeLineWindow: z.ZodOptional<z.ZodNumber>;
        jaccardThreshold: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    output: z.ZodOptional<z.ZodObject<{
        terminal: z.ZodOptional<z.ZodBoolean>;
        json: z.ZodOptional<z.ZodBoolean>;
        markdown: z.ZodOptional<z.ZodBoolean>;
        github: z.ZodOptional<z.ZodBoolean>;
        jsonPath: z.ZodOptional<z.ZodString>;
        markdownPath: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    timeout: z.ZodOptional<z.ZodNumber>;
    maxRetries: z.ZodOptional<z.ZodNumber>;
    concurrency: z.ZodOptional<z.ZodNumber>;
    githubToken: z.ZodOptional<z.ZodString>;
    context: z.ZodOptional<z.ZodArray<z.ZodString>>;
    spec: z.ZodOptional<z.ZodString>;
    focus: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type Config = z.infer<typeof ConfigSchema>;
export type ReviewerPair = z.infer<typeof ReviewerPairSchema>;
export type RoleConfig = z.infer<typeof RoleConfigSchema>;
export type Thresholds = z.infer<typeof ThresholdsSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type Category = z.infer<typeof CategorySchema>;
