import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { resolveQuorumPolicy } from '../dispatch/quorum.js';

const quorumPolicySchema = z.object({
  version: z.literal(1), fraction: z.number().finite(),
  seatCount: z.number().int().nonnegative().safe(), minimumSuccessful: z.number().int().nonnegative().safe(),
}).strict().refine(policy => {
  try { return isDeepStrictEqual(resolveQuorumPolicy(policy.seatCount, policy.fraction), policy); } catch { return false; }
}, 'Invalid blocking reviewer quorum policy');

/** Blocking-seat health of the completed report; guard metadata, never admission. */
export const reviewerHealthSchema = z.object({
  version: z.literal(1), policy: quorumPolicySchema, successfulSeats: z.number().int().nonnegative().safe(),
}).strict().refine(health => health.successfulSeats <= health.policy.seatCount);

export const completionSchema = z.object({
  runId: z.string().uuid(),
  reportJsonSha256: z.string().regex(/^[a-f0-9]{64}$/),
  successfulReviews: z.number().int().nonnegative().safe(),
  totalReviews: z.number().int().positive().safe(),
  deliveryPending: z.boolean(),
  hardFailure: z.boolean().optional(),
  exitCode: z.number().int().nonnegative().optional(),
  reportPath: z.string().min(1).optional(),
  reviewerHealth: reviewerHealthSchema.optional(),
}).refine(value => value.successfulReviews <= value.totalReviews)
  .refine(value => value.reviewerHealth === undefined ||
    (value.reviewerHealth.policy.seatCount <= value.totalReviews &&
      value.reviewerHealth.successfulSeats <= value.successfulReviews &&
      value.reviewerHealth.policy.seatCount - value.reviewerHealth.successfulSeats <=
        value.totalReviews - value.successfulReviews),
  'Blocking reviewer health must be a subset of aggregate review counts');

export const launchSchema = z.object({
  status: z.enum(['pending', 'completed', 'failed']),
  attempt: z.number().int().positive().safe(),
  round: z.number().int().positive().safe(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.string().datetime(),
  pid: z.number().int().positive().safe(),
  retryReason: z.string().min(1).max(500).optional(),
  runId: z.string().uuid().optional(),
  reportJsonSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  successfulReviews: z.number().int().nonnegative().safe().optional(),
  totalReviews: z.number().int().positive().safe().optional(),
  deliveryPending: z.boolean().optional(),
  hardFailure: z.boolean().optional(),
  exitCode: z.number().int().nonnegative().optional(),
  reportPath: z.string().min(1).optional(),
  reviewerHealth: reviewerHealthSchema.optional(),
  retainedOriginal: z.object({ version: z.literal(1), runId: z.string().uuid(),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/), capturedInputsSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  recovery: z.object({ operationId: z.string().uuid().optional(), sourceRunId: z.string().uuid(), originalNativeClaim: z.object({ attempt: z.number().int().positive().safe(), round: z.number().int().positive().safe() }).strict(), sourceNativeClaim: z.object({ attempt: z.number().int().positive().safe(), round: z.number().int().positive().safe() }).strict(), resume: z.object({ pid: z.number().int().positive().safe(), phase: z.enum(['running', 'finished']) }).strict().optional() }).strict().optional(),
}).strict().refine(value => value.status === 'completed' ? completionSchema.safeParse(value).success : value.reviewerHealth === undefined);

export type GuardedLaunchState = z.infer<typeof launchSchema>;
export type GuardedLaunchCompletion = z.infer<typeof completionSchema>;

export type GuardedReviewerHealth = z.infer<typeof reviewerHealthSchema>;
