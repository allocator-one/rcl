import { z } from 'zod';
import type { CapturedReviewerInputs } from './captured-inputs.js';
import type { AsyncContext } from './checkpoint-async.js';
import { asyncRefuse, freezeAsync } from './checkpoint-async.js';
import type { CheckpointProof } from './checkpoint.js';
import { sha256Hex, stableStringify } from '../report/run-header.js';
import { MAX_ARTIFACT_BYTES } from '../telemetry/envelope-validation.js';

const integer = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(512).refine(value => !!value.trim() && !/[\0\r\n]/.test(value));
const contextSchema = z.object({ runId: z.string().uuid(), target: text, planDigest: digest,
  capturedInputsSha256: digest, launchSha256: digest, startedAtMs: integer, expiresAtMs: integer,
  reviewerReservedCalls: integer.min(1).max(500) }).strict();
const wireSchema = z.object({ version: z.literal(1), kind: z.literal('async-outcome-unknown'),
  reason: z.literal('finalized_checkpoint_missing_async_phase'), checkpointSha256: digest,
  context: contextSchema, capturedAsyncSha256: digest, physicalCallUpperBound: integer.min(1).max(500) }).strict();

export interface AsyncOutcomeUnknown {
  version: 1;
  kind: 'async-outcome-unknown';
  reason: 'finalized_checkpoint_missing_async_phase';
  bytes: string;
  digest: string;
  checkpointSha256: string;
  context: AsyncContext;
  capturedAsyncSha256: string;
  physicalCallUpperBound: number;
}

/** Canonical fail-closed evidence. It asserts no result, status, cost or non-dispatch fact. */
export function encodeAsyncOutcomeUnknown(root: CheckpointProof, context: AsyncContext,
  captured: CapturedReviewerInputs): AsyncOutcomeUnknown {
  asyncRefuse(captured.async, 'unknown_without_capture');
  const bytes = stableStringify({ version: 1, kind: 'async-outcome-unknown',
    reason: 'finalized_checkpoint_missing_async_phase', checkpointSha256: root.digest, context,
    capturedAsyncSha256: sha256Hex(stableStringify(captured.async)),
    physicalCallUpperBound: captured.async.maxPhysicalCalls });
  return decodeAsyncOutcomeUnknown(bytes, root, context, captured);
}

/** Exact replay against the immutable primary proof and captured async matrix. */
export function decodeAsyncOutcomeUnknown(bytes: string, root: CheckpointProof, context: AsyncContext,
  captured: CapturedReviewerInputs): AsyncOutcomeUnknown {
  asyncRefuse(typeof bytes === 'string' && Buffer.byteLength(bytes, 'utf8') <= MAX_ARTIFACT_BYTES &&
    Buffer.from(bytes, 'utf8').toString('utf8') === bytes, 'invalid_unknown');
  let raw: unknown;
  try { raw = JSON.parse(bytes); } catch { throw new Error('checkpoint_async_invalid_unknown'); }
  const parsed = wireSchema.safeParse(raw);
  asyncRefuse(parsed.success && stableStringify(parsed.data) === bytes, 'invalid_unknown');
  asyncRefuse(captured.async && parsed.data.checkpointSha256 === root.digest &&
    stableStringify(parsed.data.context) === stableStringify(context) &&
    parsed.data.capturedAsyncSha256 === sha256Hex(stableStringify(captured.async)) &&
    parsed.data.physicalCallUpperBound === captured.async.maxPhysicalCalls, 'unknown_binding');
  return freezeAsync({ ...parsed.data, bytes, digest: sha256Hex(bytes) });
}

export function isAsyncOutcomeUnknown(value: unknown): value is AsyncOutcomeUnknown {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'async-outcome-unknown';
}
