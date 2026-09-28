import { z } from 'zod';
import { hasSuccessfulQuorum } from '../dispatch/quorum.js';
import { reviewerHealthSchema } from './launch-record.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Source authorization on a new claim; the original aggregate event is retained. */
export const retrySourceSchema = z.object({
  version: z.literal(1), runId: z.string().uuid(), reportJsonSha256: digest,
  configSha256: digest, nativeStateSha256: digest, attemptStateSha256: digest,
  headSha: z.string().regex(/^[a-f0-9]{40}$/), inputSha256: digest,
  attempt: z.number().int().positive().safe(), round: z.number().int().positive().safe(),
  reviewerHealth: reviewerHealthSchema,
}).strict().refine(source => !hasSuccessfulQuorum(source.reviewerHealth.policy, source.reviewerHealth.successfulSeats),
  'A legacy retry source must be inconclusive');
export type RetrySource = z.infer<typeof retrySourceSchema>;
