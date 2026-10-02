import { describe, expect, it } from 'vitest';
import { migratedLegacyPendingRound as pure } from '../../../src/evidence/claim-recovery/validation/obligations.js';
import { migratedLegacyPendingRound as effectful } from '../../../src/converge/semantic-state.js';
import type { ConvergeRunState, FindingEntry } from '../../../src/evidence/claim-recovery/validation/types.js';

const finding = (overrides: Partial<FindingEntry> = {}): FindingEntry => ({
  key: '1111111111111111', file: 'test.ts', category: 'correctness', title: 'test', severity: 'critical', models: [],
  startLine: 1, endLine: 1, firstRound: 1, lastRound: 1, verdict: 'dismissed', verdictRound: 1, ...overrides,
});
const state = (entry: FindingEntry): ConvergeRunState => ({
  version: 2, target: 'target', roundCap: 15, rounds: [{ round: 1, counts: { new: 1, repeat: 0, suppressed: 0, regating: 0 }, severities: { [entry.key]: 'critical' } }],
  findings: { [entry.key]: entry }, updatedAt: '2026-09-26T00:00:00.000Z',
});

describe.each([['pure', pure], ['effectful', effectful]] as const)('%s legacy pending obligations', (_name, migratedLegacyPendingRound) => {
  it('retains a later critical sighting after an earlier implicit-severity dismissal', () => {
    const entry = finding({ lastRound: 2 }); const value = state(entry);
    value.rounds.push({ round: 2, counts: { new: 0, repeat: 0, suppressed: 1, regating: 0 }, severities: { [entry.key]: 'critical' } });
    expect(migratedLegacyPendingRound(entry, value)).toBe(2);
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
});
