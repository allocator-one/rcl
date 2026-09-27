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
  const verdictSeverity = entry.verdictSeverity ?? entry.severity;
  if (pendingRound !== undefined && entry.verdict && entry.verdictRound !== undefined &&
      verdictClearsPending(state, entry.key, pendingRound, entry.verdictRound, verdictSeverity)) {
    pendingRound = undefined;
  }
  const verdictCanClear = entry.verdict && entry.verdictRound !== undefined && entry.verdictRound >= entry.firstRound &&
    verdictClearsPending(state, entry.key, entry.firstRound, entry.verdictRound, verdictSeverity);
  const annotations = state.lastAnnotations?.identities.filter(a => a.identity === entry.key) ?? [];
  const provenNonGating = entry.firstRound === entry.lastRound && entry.lastRound === state.lastAnnotations?.round &&
    annotations.length > 0 && annotations.every(a => a.gating === 'none');
  if (!verdictCanClear) {
    if (!provenNonGating) pendingRound ??= entry.firstRound;
  }
  let criticalSighting: number | undefined;
  for (const round of state.rounds) {
    // Severity alone cannot create an obligation for this proven nongating
    // sighting. Other retained rounds still carry conservative critical vetoes.
    if (provenNonGating && round.round === entry.firstRound) continue;
    // The round is critical. Its stored verdict can discharge it only when it
    // is itself critical and is no earlier than this sighting; keep the scan
    // linear for parser-accepted retained history.
    if (round.severities?.[entry.key] === 'critical' &&
        !(verdictSeverity === 'critical' && (entry.verdictRound ?? 0) >= round.round)) {
      criticalSighting = criticalSighting === undefined ? round.round : Math.min(criticalSighting, round.round);
    }
  }
  // A later pending round cannot hide an earlier critical sighting that the
  // stored verdict does not clear. Preserve the earliest unresolved obligation.
  if (criticalSighting !== undefined && (pendingRound === undefined || criticalSighting < pendingRound ||
      verdictClearsPending(state, entry.key, pendingRound, entry.verdictRound ?? 0, verdictSeverity))) {
    pendingRound = criticalSighting;
  }
  const regating = state.lastAnnotations?.identities.some(a => a.identity === entry.key && a.status === 'regating' && a.gating !== 'none');
  if (regating && !verdictClearsPending(state, entry.key, state.lastAnnotations!.round, entry.verdictRound ?? 0, verdictSeverity)) {
    if (pendingRound === undefined || verdictClearsPending(state, entry.key, pendingRound, entry.verdictRound ?? 0, verdictSeverity)) {
      pendingRound = state.lastAnnotations!.round;
    }
  }
  return pendingRound;
}
