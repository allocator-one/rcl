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
  // 2 * seatCount. Snap only floating-point multiplication noise at integers.
  const floor = Math.floor(seatCount / 3) * 2 + Math.ceil((seatCount % 3) * 2 / 3);
  const product = fraction * seatCount;
  const nearest = Math.round(product);
  // Snap only when the configured fraction is exactly the rational boundary
  // represented by this roster. A fraction even slightly above it is stricter
  // and must round up, while values such as 0.8 * 35 still resolve to 28.
  const rounded = product === nearest || fraction === nearest / seatCount
    ? nearest : Math.ceil(product);
  return { version: 1, fraction, seatCount, minimumSuccessful: Math.max(2, floor, rounded) };
}

/** Count only distinct, complete, durably accepted blocking seats. */
export function hasSuccessfulQuorum(policy: QuorumPolicy, successfulSeats: number): boolean {
  if (!Number.isSafeInteger(successfulSeats) || successfulSeats < 0 || successfulSeats > policy.seatCount) {
    throw new Error('Successful seat count must be an integer within the frozen roster');
  }
  return policy.seatCount >= 2 && successfulSeats >= policy.minimumSuccessful;
}
