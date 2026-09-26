import { isDeepStrictEqual } from 'node:util';
import { abortSignalWithTimeout } from './abort-signal.js';
import type { ReviewerRecoveryPreflight } from '../evidence/reviewer-recovery.js';
import { sha256 } from './recovery/files.js';
import type { HarnessSink, RequestOptions } from './sink.js';

/** Exact local source references only; this does not establish ancestry or server authority. */
export function assertReviewerRecoveryReference(request: ReviewerRecoveryPreflight): void {
  if (!request.lineage.length || request.lineage.length > 32 ||
    !isDeepStrictEqual(request.lineage.at(-1), request.source)) throw new Error('reviewer_recovery_source_unavailable');
}

/** Check the exact parent report embedded in an already digest-checked private response. */
export function assertReviewerRecoverySource(request: ReviewerRecoveryPreflight, bytes: Uint8Array): void {
  assertReviewerRecoveryReference(request);
  const source = request.source;
  try {
    const wire = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (wire.report?.sha256 !== source.reportSha256 || typeof wire.report?.bytes !== 'string' || sha256(wire.report.bytes) !== source.reportSha256 ||
      wire.assembly?.run?.id !== source.runId || wire.assembly?.run?.target?.headSha !== request.headSha) throw new Error('mismatch');
  } catch { throw new Error('reviewer_recovery_source_unavailable'); }
}

/**
 * Server support and private immediate-parent availability under the CURRENT
 * credential, before the executor reserves a native/provider intent. This is
 * not source ancestry, native-attempt or protected-producer authority. Signed
 * exact-parent grants require a separate attested coordinator and fail closed.
 */
export function createReviewerRecoveryPreflight(sink: HarnessSink, options: RequestOptions = {}): (request: ReviewerRecoveryPreflight) => Promise<void> {
  const settings = { ...options };
  return async original => {
    const request = structuredClone(original);
    const timeoutMs = Math.min(settings.timeoutMs ?? 120_000, 120_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('reviewer_recovery_capability_unavailable');
    const cancellation = abortSignalWithTimeout(settings.signal, timeoutMs);
    const options = { ...settings, signal: cancellation.signal };
    try {
      if (sink.credentialSource === 'attest') throw new Error('reviewer_recovery_attested_preflight_unsupported');
      if ((await sink.checkReviewerRecovery(options)).kind !== 'ok') throw new Error('reviewer_recovery_capability_unavailable');
      const source = request.source;
      assertReviewerRecoveryReference(request);
      const read = await sink.getReviewerArtifact(source.runId, { sha256: source.reviewerArtifactSha256 }, options);
      if (read.kind !== 'ok') throw new Error('reviewer_recovery_source_unavailable');
      assertReviewerRecoverySource(request, read.value.bytes);
    } finally { cancellation.dispose(); }
  };
}
