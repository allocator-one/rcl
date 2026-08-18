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
  /**
   * Carry below-threshold findings into the report's demoted "worth
   * checking" appendix (and the JSON `belowThresholdFindings` field).
   * Default true; set false to drop them outright as before 1.6.0.
   */
  belowThresholdAppendix: z.boolean().optional(),
});

export const ReasoningEffortSchema = z.enum(['low', 'medium', 'high']);

export const ConfigSchema = z.object({
  models: z.array(z.string()).optional(),
  secondaryModels: z.array(z.string()).optional(),
  /**
   * Async bonus reviewers — fired with each round, never awaited. Results
   * that have arrived by the next round's dedup are merged then and marked
   * async in the report. Never on the blocking path.
   */
  asyncModels: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  reviewers: z.array(ReviewerPairSchema).optional(),
  customRoles: z.array(RoleConfigSchema).optional(),
  thresholds: ThresholdsSchema.optional(),
  output: OutputSchema.optional(),
  timeout: z.number().positive().optional(),
  /** Per-call timeout (ms) for the async lane; defaults higher than `timeout`. */
  asyncTimeout: z.number().positive().optional(),
  /**
   * Fraction of planned calls whose completion closes a review round;
   * outstanding non-core calls are canceled. 1 disables early closure.
   * Floored at ⅔ so a closed round can still pass the converge
   * reviewer-health check (successful ≥ ⅔ of total).
   */
  quorumFraction: z.number().min(2 / 3).max(1).optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  concurrency: z.number().int().positive().optional(),
  /** Reasoning budget for providers that support it (currently OpenRouter). */
  reasoningEffort: ReasoningEffortSchema.optional(),
  githubToken: z.string().optional(),
  context: z.array(z.string()).optional(),
  spec: z.string().optional(),
  focus: z.array(z.string()).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ReviewerPair = z.infer<typeof ReviewerPairSchema>;
export type RoleConfig = z.infer<typeof RoleConfigSchema>;
export type Thresholds = z.infer<typeof ThresholdsSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type Category = z.infer<typeof CategorySchema>;
