import { scrubText } from '../telemetry/scrub.js';

/** One canonical bounded form for reviewed stale-recovery intent. */
export function canonicalStaleRetryReason(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || [...trimmed].length > 500) throw new Error('invalid_stale_retry_reason');
  return scrubText(trimmed,500);
}

export function isCanonicalStaleRetryReason(value: string): boolean {
  try { return canonicalStaleRetryReason(value) === value; }
  catch { return false; }
}
