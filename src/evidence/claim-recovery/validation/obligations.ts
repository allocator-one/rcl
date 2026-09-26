import type { ConvergeRunState, FindingEntry } from './types.js';

export class ConvergeRunStateError extends Error {
  readonly code = 'RCL_CONVERGE_RUN_STATE';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConvergeRunStateError';
  }
}

export function findingGatingReason(f: { severity: string; gating?: { reason: string } }): string {
  if (f.gating) return f.gating.reason;
  return f.severity === 'critical' || f.severity === 'important' ? 'legacy-blocking' : 'none';
}
/** A nongating followup cannot lower the severity needed for a critical pending source. */
export function verdictClearsPending(state: ConvergeRunState, key: string, pendingRound: number,
  verdictRound: number, verdictSeverity: string | undefined): boolean {
  // v1 rounds predate the per-round severity ledger. Their retained entry
  // severity is the only evidence available, and must remain conservative.
  const severity = state.rounds.find(round => round.round === pendingRound)?.severities?.[key] ?? state.findings[key]?.severity;
  return verdictRound >= pendingRound && (severity !== 'critical' || verdictSeverity === 'critical');
}
/** Derive only the explicit migration obligation from the unchanged v1 snapshot. */
export function migratedLegacyPendingRound(entry: FindingEntry, state: ConvergeRunState): number | undefined {
  let pendingRound = entry.pendingRound;
  if (!entry.verdict) {
    const annotations = state.lastAnnotations?.identities.filter(a => a.identity === entry.key) ?? [];
    const provenNonGating = entry.firstRound === entry.lastRound && entry.lastRound === state.lastAnnotations?.round &&
      annotations.length > 0 && annotations.every(a => a.gating === 'none');
    if (!provenNonGating) pendingRound ??= entry.firstRound;
  }
  const criticalAfterDismissal = entry.verdict === 'dismissed' && entry.verdictSeverity !== 'critical'
    ? state.rounds.filter(r => r.round > (entry.verdictRound ?? 0) && r.severities?.[entry.key] === 'critical').map(r => r.round) : [];
  if (criticalAfterDismissal.length > 0) pendingRound ??= Math.min(...criticalAfterDismissal);
  const regating = state.lastAnnotations?.identities.some(a => a.identity === entry.key && a.status === 'regating' && a.gating !== 'none');
  if (regating && entry.verdictRound !== state.lastAnnotations!.round) pendingRound ??= state.lastAnnotations!.round;
  return pendingRound;
}
