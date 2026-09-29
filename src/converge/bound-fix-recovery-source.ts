import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Append-only authorization evidence on the spent attempt, retained beyond lastLaunch. */
export const boundFixRecoverySourceSchema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  target: z.string().min(1),
  repo: z.string().regex(/^[^/\s]{1,100}\/[^/\s]{1,100}$/),
  prNumber: z.number().int().positive().safe(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  inputSha256: digest,
  round: z.number().int().positive().safe(),
  attempt: z.number().int().positive().safe(),
  verifiedAt: z.string().datetime(),
  serverProof: z.object({
    status: z.literal('fixes_pending'),
    conclusive: z.literal(true),
    actionableCount: z.literal(0),
    classificationPending: z.literal(false).nullable(),
    legacyPendingCount: z.literal(0).nullable(),
    statusSha256: digest,
    runSha256: digest,
  }).strict(),
}).strict();

export type BoundFixRecoverySource = z.infer<typeof boundFixRecoverySourceSchema>;
