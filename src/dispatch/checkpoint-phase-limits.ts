// Each phase permits at most 500 physical calls. Non-starts have an independent,
// finite allowance; refunding paid budget must not make the journal unbounded.
export const MAX_PHASE_NOT_DISPATCHED = 500;
export const MAX_ASYNC_PHASE_RECORDS = 2 * (500 + MAX_PHASE_NOT_DISPATCHED) + 1;
export const MAX_VERIFICATION_PHASE_RECORDS = MAX_ASYNC_PHASE_RECORDS + 1; // Plan record.

/** Reserve every outstanding outcome, the new intent/outcome pair and the seal. */
export function hasCheckpointIntentCapacity(records: number, unresolved: number, notDispatched: number, limit: number): boolean {
  // Any outstanding callback may still report a non-start under the same lock.
  return notDispatched + unresolved < MAX_PHASE_NOT_DISPATCHED && records + unresolved + 3 <= limit;
}
