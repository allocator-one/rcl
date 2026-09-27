import { describe, expect, it } from 'vitest';
import { migratedLegacyPendingRound } from '../../../src/evidence/claim-recovery/validation/obligations.js';
import type { ConvergeRunState, FindingEntry } from '../../../src/evidence/claim-recovery/validation/types.js';

const finding = (overrides: Partial<FindingEntry> = {}): FindingEntry => ({
  key: '1111111111111111', file: 'test.ts', category: 'correctness', title: 'test', severity: 'critical', models: [],
  startLine: 1, endLine: 1, firstRound: 1, lastRound: 1, verdict: 'dismissed', verdictRound: 1, ...overrides,
});
const state = (entry: FindingEntry): ConvergeRunState => ({
  version: 2, target: 'target', roundCap: 15, rounds: [{ round: 1, counts: { new: 1, repeat: 0, suppressed: 0, regating: 0 }, severities: { [entry.key]: 'critical' } }],
  findings: { [entry.key]: entry }, updatedAt: '2026-09-26T00:00:00.000Z',
});

describe('legacy pending obligations', () => {
  it('derives an open legacy finding obligation from its first round', () => {
    const entry = finding({ verdict: undefined, verdictRound: undefined, verdictSeverity: undefined, firstRound: 1, lastRound: 2 });
    const value = state(entry);
    value.rounds.push({ round: 2, counts: { new: 0, repeat: 1, suppressed: 0, regating: 0 } });
    expect(migratedLegacyPendingRound(entry, value)).toBe(1);
  });

  it('preserves an explicit pending obligation across later nongating evidence', () => {
    const entry = finding({ pendingRound: 1, lastRound: 2 }); const value = state(entry);
    value.rounds.push({ round: 2, counts: { new: 0, repeat: 0, suppressed: 1, regating: 0 } });
    value.lastAnnotations = { round: 2, identities: [{ identity: entry.key, status: 'suppressed', gating: 'none' }] };
    expect(migratedLegacyPendingRound(entry, value)).toBe(1);
  });

  it('retains an explicit pending obligation after a fixed verdict but invents none without one', () => {
    const explicit = finding({ verdict: 'fixed', verdictRound: 1, pendingRound: 1 });
    expect(migratedLegacyPendingRound(explicit, state(explicit))).toBe(1);
    const settled = finding({ verdict: 'fixed', verdictRound: 1, pendingRound: undefined });
    expect(migratedLegacyPendingRound(settled, state(settled))).toBeUndefined();
  });

  it('uses the retained entry severity when a legacy dismissal has no verdict severity', () => {
    const entry = finding({ lastRound: 2 }); const value = state(entry);
    value.rounds.push({ round: 2, counts: { new: 0, repeat: 0, suppressed: 1, regating: 0 }, severities: { [entry.key]: 'critical' } });
    expect(migratedLegacyPendingRound(entry, value)).toBeUndefined();
  });

  it('retains a same-round critical regating obligation until its verdict is critical', () => {
    const entry = finding({ severity: 'important', verdictSeverity: 'important' }); const value = state(entry);
    value.lastAnnotations = { round: 1, identities: [{ identity: entry.key, status: 'regating', gating: 'critical' }] };
    expect(migratedLegacyPendingRound(entry, value)).toBe(1);
  });

  it('retains a same-round critical obligation even after later annotations replace it', () => {
    const entry = finding({ severity: 'important', verdictSeverity: 'important' }); const value = state(entry);
    value.rounds.push({ round: 2, counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } });
    value.lastAnnotations = { round: 2, identities: [] };
    expect(migratedLegacyPendingRound(entry, value)).toBe(1);
  });

  it('uses the explicit historical verdict severity when a later sighting becomes critical', () => {
    const entry = finding({ verdictSeverity: 'important', lastRound: 2 }); const value = state(entry);
    value.rounds[0]!.severities![entry.key] = 'important';
    value.rounds.push({ round: 2, counts: { new: 0, repeat: 0, suppressed: 0, regating: 1 }, severities: { [entry.key]: 'critical' } });
    expect(migratedLegacyPendingRound(entry, value)).toBe(2);
  });

  it('moves a cleared pending obligation to the first later critical sighting', () => {
    const entry = finding({ severity: 'important', pendingRound: 1, verdictRound: 2, verdictSeverity: 'important', lastRound: 3 });
    const value = state(entry);
    value.rounds[0]!.severities![entry.key] = 'important';
    value.rounds.push({ round: 2, counts: { new: 0, repeat: 0, suppressed: 1, regating: 0 }, severities: { [entry.key]: 'important' } });
    value.rounds.push({ round: 3, counts: { new: 0, repeat: 0, suppressed: 0, regating: 1 }, severities: { [entry.key]: 'critical' } });
    expect(migratedLegacyPendingRound(entry, value)).toBe(3);
  });

  it('keeps an older critical pending obligation when a later sighting is also critical', () => {
    const entry = finding({ pendingRound: 1, verdictRound: 2, verdictSeverity: 'important', lastRound: 3 });
    const value = state(entry);
    value.rounds.push({ round: 2, counts: { new: 0, repeat: 0, suppressed: 1, regating: 0 }, severities: { [entry.key]: 'important' } });
    value.rounds.push({ round: 3, counts: { new: 0, repeat: 0, suppressed: 0, regating: 1 }, severities: { [entry.key]: 'critical' } });
    expect(migratedLegacyPendingRound(entry, value)).toBe(1);
  });

  it('moves a cleared legacy pending obligation to a later open regating round', () => {
    const entry = finding({ severity: 'important', pendingRound: 1, verdictRound: 2, verdictSeverity: 'important', lastRound: 3 });
    const value = state(entry);
    value.rounds[0]!.severities![entry.key] = 'important';
    value.rounds.push({ round: 2, counts: { new: 0, repeat: 0, suppressed: 1, regating: 0 }, severities: { [entry.key]: 'important' } });
    value.rounds.push({ round: 3, counts: { new: 0, repeat: 0, suppressed: 0, regating: 1 } });
    value.lastAnnotations = { round: 3, identities: [{ identity: entry.key, status: 'regating', gating: 'consensus' }] };
    expect(migratedLegacyPendingRound(entry, value)).toBe(3);
  });
});
