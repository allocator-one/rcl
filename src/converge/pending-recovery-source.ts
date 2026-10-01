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
  retrySource: retrySourceSchema,
}).strict().superRefine((source, context) => {
  if (source.retrySource.attempt !== source.pendingAttempt - 1 ||
      source.retrySource.round !== source.round ||
      source.retrySource.headSha !== source.headSha) {
    context.addIssue({ code: 'custom', message: 'Pending recovery lineage is inconsistent' });
  }
  if (new Set(source.retainedAsyncSha256).size !== source.retainedAsyncSha256.length) {
    context.addIssue({ code: 'custom', message: 'Pending recovery async bindings must be unique' });
  }
});

/** Immutable operator package authenticated against the pending launch's production input digest. */
const ordinaryBodySchema = z.object({
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
  migrationPackageSha256: digest,
}).strict();

export const ordinaryMigrationSourceSchema = ordinaryBodySchema.extend({ digest }).strict().superRefine((source, context) => {
  const { digest: claimed, ...body } = source;
  if (claimed !== createHash('sha256').update(stableStringify(body)).digest('hex')) context.addIssue({ code: 'custom', message: 'Pending recovery digest is invalid' });
});

export type OrdinaryMigrationSource = z.infer<typeof ordinaryMigrationSourceSchema>;

export function createOrdinaryMigrationSource(input: z.input<typeof ordinaryBodySchema>): OrdinaryMigrationSource {
  const body = ordinaryBodySchema.parse(input);
  return ordinaryMigrationSourceSchema.parse({ ...body, digest: createHash('sha256').update(stableStringify(body)).digest('hex') });
}

const legacySourceSchema = bodySchema.extend({ digest }).strict().superRefine((source, context) => {
  const { digest: claimed, ...body } = source;
  const actual = createHash('sha256').update(stableStringify(body)).digest('hex');
  if (claimed !== actual) context.addIssue({ code: 'custom', message: 'Pending recovery digest is invalid' });
});
export const pendingRecoverySourceSchema = z.union([legacySourceSchema, ordinaryMigrationSourceSchema]);

export type PendingRecoverySource = z.infer<typeof pendingRecoverySourceSchema>;

export function createPendingRecoverySource(input: z.input<typeof bodySchema>): PendingRecoverySource {
  const body = bodySchema.parse(input);
  return pendingRecoverySourceSchema.parse({
    ...body,
    digest: createHash('sha256').update(stableStringify(body)).digest('hex'),
  });
}
