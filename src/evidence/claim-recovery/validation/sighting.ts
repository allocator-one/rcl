import { claimDescriptorSchema } from './claims.js';

/** Inspect retained bindings without normalizing or replacing their original values. */
export function validSightingBinding(entry: Record<string, unknown>): boolean {
  const key = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 64;
  return entry.version === 1 && key(entry.identity_key) && key(entry.matched_identity) &&
    ['new', 'repeat', 'suppressed', 'regating'].includes(entry.status as string) &&
    typeof entry.finding_ref === 'string' && Buffer.byteLength(entry.finding_ref, 'utf8') > 0 &&
    Buffer.byteLength(entry.finding_ref, 'utf8') <= 32 &&
    typeof entry.report_json_sha256 === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(entry.report_json_sha256) &&
    claimDescriptorSchema.safeParse(entry.claim_descriptor).success &&
    ['new_claim', 'exact_descriptor', 'supported_paraphrase', 'ambiguous', 'explicit_split'].includes(entry.match_rationale as string) &&
    (!Object.hasOwn(entry, 'pending_round') || entry.pending_round === null ||
      (typeof entry.pending_round === 'number' && Number.isSafeInteger(entry.pending_round) && entry.pending_round >= 1));
}

