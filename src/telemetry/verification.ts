import { scrubIdentifier, scrubText } from './scrub.js';

/** Optional recorded verifier evidence, shared by report and wire projections. */
export function normalizeVerificationEvidence(verification: { verdict?: unknown; model?: unknown; note?: unknown } | undefined): { model?: string; note?: string } {
  if (typeof verification?.verdict !== 'string' || verification.verdict.trim() === '') return {};
  const { model, note } = verification;
  return {
    ...(typeof model === 'string' && model.trim() !== '' ? { model: scrubIdentifier(model, 500) } : {}),
    ...(typeof note === 'string' && note.trim() !== '' ? { note: scrubText(note, 2_000) } : {}),
  };
}
