import { createHash } from 'node:crypto';
import { z } from 'zod';
import { retrySourceSchema } from './retry-source.js';
import { stableStringify } from '../report/run-header.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);

const bodySchema = z.object({
  version: z.literal(1),
  target: z.string().min(1),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  inputSha256: digest,
  pendingAttempt: z.number().int().positive().safe(),
  round: z.number().int().positive().safe(),
  originalPid: z.number().int().positive().safe(),
  startedAt: z.string().datetime(),
  blockingOutcome: z.literal('unknown'),
  reason: z.literal('coordinator_exited_without_durable_blocking_receipts'),
  nativeStateSha256: digest,
  attemptStateSha256: digest,
  retainedAsyncSha256: z.array(digest).min(1),
  retrySource: retrySourceSchema.optional(),
  ordinaryPackageSha256: digest.optional(),
}).strict().superRefine((source, context) => {
  if ((source.retrySource === undefined) === (source.ordinaryPackageSha256 === undefined)) {
    context.addIssue({ code: 'custom', message: 'Pending recovery must bind exactly one source kind' });
  }
  if (source.retrySource && (source.retrySource.attempt !== source.pendingAttempt - 1 ||
      source.retrySource.round !== source.round ||
      source.retrySource.headSha !== source.headSha)) {
    context.addIssue({ code: 'custom', message: 'Pending recovery lineage is inconsistent' });
  }
  if (new Set(source.retainedAsyncSha256).size !== source.retainedAsyncSha256.length) {
    context.addIssue({ code: 'custom', message: 'Pending recovery async bindings must be unique' });
  }
});

export const pendingRecoverySourceSchema = bodySchema.extend({ digest }).strict().superRefine((source, context) => {
  const { digest: claimed, ...body } = source;
  const actual = createHash('sha256').update(stableStringify(body)).digest('hex');
  if (claimed !== actual) context.addIssue({ code: 'custom', message: 'Pending recovery digest is invalid' });
});

export type PendingRecoverySource = z.infer<typeof pendingRecoverySourceSchema>;

export function createPendingRecoverySource(input: z.input<typeof bodySchema>): PendingRecoverySource {
  const body = bodySchema.parse(input);
  return pendingRecoverySourceSchema.parse({
    ...body,
    digest: createHash('sha256').update(stableStringify(body)).digest('hex'),
  });
}
