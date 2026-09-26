import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyNativeRecoveryLineage } from '../../../src/evidence/claim-recovery/validation/native-state.js';
import { legacyFixture, recoveredFixture, sha, target } from './fixtures.js';

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

function migrated() {
  const fixture = legacyFixture();
  const original = JSON.stringify(fixture.state);
  const current = { ...fixture.state, version: 2, sightings: [],
    findings: { [fixture.key]: { ...fixture.state.findings[fixture.key], pendingRound: 1 } },
    migration: { sourceSha256: sha(original), snapshotPath: `/synthetic/native.v1-${sha(original)}.snapshot`,
      migratedAt: '2026-09-22T01:00:00Z' } };
  return { ...fixture, original, current };
}

describe('retained snapshot lineage', () => {
  it('preserves legacy migration with a later ordinary verdict and pending cache', () => {
    const f = migrated();
    Object.assign(f.current.findings[f.key], { verdict: 'fixed', verdictRound: 1,
      verdictSeverity: 'important', verdictReason: 'Verified against the original finding.' });
    expect(verifyNativeRecoveryLineage(JSON.stringify(f.current), target, [f.original]).legacy).toEqual(f.state);
  });

  it('refuses a migration that rewrites an original finding identity', () => {
    const f = migrated();
    f.current.findings[f.key].title = 'An unrelated allegation';
    expect(() => verifyNativeRecoveryLineage(JSON.stringify(f.current), target, [f.original])).toThrow(/native_recovery/);
  });

  it('refuses oversized retained snapshots before hashing their bytes', () => {
    const f = recoveredFixture();
    const oversized = 'x'.repeat(64 * 1024 * 1024 + 1);
    vi.mocked(createHash).mockClear();
    expect(() => verifyNativeRecoveryLineage(JSON.stringify(f.state), target, [])).toThrow(/native_recovery/);
    const sourceHashes = vi.mocked(createHash).mock.calls.length;
    expect(sourceHashes).toBeGreaterThan(0);
    vi.mocked(createHash).mockClear();
    expect(() => verifyNativeRecoveryLineage(JSON.stringify(f.state), target, [oversized])).toThrow(/native_recovery/);
    expect(createHash).toHaveBeenCalledTimes(sourceHashes);
  });

  it('refuses more snapshots than the retained lineage can reference before hashing any', () => {
    const f = recoveredFixture();
    vi.mocked(createHash).mockClear();
    expect(() => verifyNativeRecoveryLineage(JSON.stringify(f.state), target, [])).toThrow(/native_recovery/);
    const sourceHashes = vi.mocked(createHash).mock.calls.length;
    expect(sourceHashes).toBeGreaterThan(0);
    vi.mocked(createHash).mockClear();
    expect(() => verifyNativeRecoveryLineage(JSON.stringify(f.state), target,
      [f.sourceJson, f.sourceJson + ' '])).toThrow(/native_recovery/);
    expect(createHash).toHaveBeenCalledTimes(sourceHashes);
  });

  it('bounds round lookup work for large retained histories without changing their contents', () => {
    const f = recoveredFixture();
    const original = JSON.parse(f.sourceJson);
    original.rounds = Array.from({ length: 1000 }, (_, index) => ({ ...original.rounds[0], round: index + 1 }));
    const sourceJson = JSON.stringify(original);
    f.state.rounds = structuredClone(original.rounds);
    f.state.recovery.operations[0]!.sourceSha256 = sha(sourceJson);
    const source = JSON.stringify(f.state);
    const originalFind = Array.prototype.find;
    let visited = 0;
    const find = vi.spyOn(Array.prototype, 'find').mockImplementation(function (this: unknown[], predicate, thisArg) {
      return originalFind.call(this, (value, index, array) => {
        visited++;
        return predicate.call(thisArg, value, index, array);
      });
    });
    try {
      expect(verifyNativeRecoveryLineage(source, target, [sourceJson]).original.rounds).toEqual(original.rounds);
    } finally { find.mockRestore(); }
    expect(visited).toBeLessThan(100 * original.rounds.length);
  });
});
