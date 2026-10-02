import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { resolveQuorumPolicy } from '../dispatch/quorum.js';
import { processIdentitySchema } from './process-identity.js';

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

/** Exact retained ordinary launch packet bound before its native claim was dispatched. */
export const ordinaryLaunchInputsBindingSchema = z.object({
  version: z.literal(1),
  packetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
}).strict();

export type OrdinaryLaunchInputsBinding = z.infer<typeof ordinaryLaunchInputsBindingSchema>;

export const completionSchema = z.object({
  runId: z.string().uuid(),
  reportJsonSha256: z.string().regex(/^[a-f0-9]{64}$/),
  successfulReviews: z.number().int().nonnegative().safe(),
  totalReviews: z.number().int().positive().safe(),
  deliveryPending: z.boolean(),
  deliveryFailure: z.literal('local-invalid').optional(),
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
  processIdentity: processIdentitySchema.optional(),
  retryReason: z.string().min(1).max(500).optional(),
  runId: z.string().uuid().optional(),
  reportJsonSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  successfulReviews: z.number().int().nonnegative().safe().optional(),
  totalReviews: z.number().int().positive().safe().optional(),
  deliveryPending: z.boolean().optional(),
  deliveryFailure: z.literal('local-invalid').optional(),
  hardFailure: z.boolean().optional(),
  exitCode: z.number().int().nonnegative().optional(),
  reportPath: z.string().min(1).optional(),
  reviewerHealth: reviewerHealthSchema.optional(),
  ordinaryInputs: ordinaryLaunchInputsBindingSchema.optional(),
  retainedOriginal: z.object({ version: z.literal(1), runId: z.string().uuid(),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/), capturedInputsSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  pendingResume: z.object({ version: z.literal(1), runId: z.string().uuid(),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/), capturedInputsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    originalPid: z.number().int().positive().safe(), pid: z.number().int().positive().safe(),
    phase: z.enum(['running', 'finished']), startedAtMs: z.number().int().nonnegative().safe(),
    expiresAtMs: z.number().int().nonnegative().safe(), maxPhysicalCalls: z.number().int().positive().safe(),
    maxAttemptsPerCell: z.number().int().positive().safe() }).strict().optional(),
  pendingRecovery: z.object({
    version: z.literal(1),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    pendingAttempt: z.number().int().positive().safe(),
    round: z.number().int().positive().safe(),
    originalPid: z.number().int().positive().safe(),
    originalStartedAt: z.string().datetime(),
    blockingOutcome: z.literal('unknown'),
    reason: z.literal('coordinator_exited_without_durable_blocking_receipts'),
    nativeStateSha256: z.string().regex(/^[a-f0-9]{64}$/),
    attemptStateSha256: z.string().regex(/^[a-f0-9]{64}$/),
    retainedAsyncSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
    migrationPackageSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict().optional(),
  recovery: z.object({ operationId: z.string().uuid().optional(), sourceRunId: z.string().uuid(), originalNativeClaim: z.object({ attempt: z.number().int().positive().safe(), round: z.number().int().positive().safe() }).strict(), sourceNativeClaim: z.object({ attempt: z.number().int().positive().safe(), round: z.number().int().positive().safe() }).strict(), resume: z.object({ pid: z.number().int().positive().safe(), processIdentity: processIdentitySchema.optional(), phase: z.enum(['running', 'finished']) }).strict().optional() }).strict().optional(),
}).strict()
  .refine(value => value.processIdentity === undefined || value.processIdentity.pid === value.pid,
    'Launch process identity must match its PID')
  .refine(value => value.recovery?.resume?.processIdentity === undefined ||
    value.recovery.resume.processIdentity.pid === value.recovery.resume.pid,
  'Resume process identity must match its PID')
  .refine(value => value.status === 'completed' ? completionSchema.safeParse(value).success : value.reviewerHealth === undefined);

export type GuardedLaunchState = z.infer<typeof launchSchema>;
export type GuardedLaunchCompletion = z.infer<typeof completionSchema>;

export type GuardedReviewerHealth = z.infer<typeof reviewerHealthSchema>;
