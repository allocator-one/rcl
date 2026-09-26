/** Successful blocking-reviewer policy shared by dispatch and admission. */
export interface QuorumPolicy {
  readonly version: 1;
  readonly fraction: number;
  readonly seatCount: number;
  readonly minimumSuccessful: number;
}

/**
 * Freeze the minimum for the original blocking roster. A stricter supported
 * fraction raises the required successes; 1 requires the entire roster.
 * Fewer than two seats can never produce conclusive reviewer health.
 */
export function resolveQuorumPolicy(seatCount: number, fraction = 2 / 3): QuorumPolicy {
  if (!Number.isSafeInteger(seatCount) || seatCount < 0) {
    throw new Error('Quorum seat count must be a nonnegative safe integer');
  }
  if (!Number.isFinite(fraction) || fraction < 2 / 3 || fraction > 1) {
    throw new Error('Quorum fraction must be between 2/3 and 1');
  }
  // Integer arithmetic preserves the authoritative floor without overflowing
  // 2 * seatCount.
  const floor = Math.floor(seatCount / 3) * 2 + Math.ceil((seatCount % 3) * 2 / 3);
  // Start with the usual product, then decide boundary cases against the
  // public ratio contract. This corrects multiplication noise such as
  // 0.8 * 35 without weakening the next representable value above 2/3.
  let rounded = Math.ceil(fraction * seatCount);
  while (rounded > 0 && (rounded - 1) / seatCount >= fraction) rounded--;
  while (rounded < seatCount && rounded / seatCount < fraction) rounded++;
  return { version: 1, fraction, seatCount, minimumSuccessful: Math.max(2, floor, rounded) };
}

/** Count only distinct, complete, durably accepted blocking seats. */
export function hasSuccessfulQuorum(policy: QuorumPolicy, successfulSeats: number): boolean {
  if (!Number.isSafeInteger(successfulSeats) || successfulSeats < 0 || successfulSeats > policy.seatCount) {
    throw new Error('Successful seat count must be an integer within the frozen roster');
  }
  return policy.seatCount >= 2 && successfulSeats >= policy.minimumSuccessful;
}
