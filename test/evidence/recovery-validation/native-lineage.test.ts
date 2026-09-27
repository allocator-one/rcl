import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyNativeRecoveryLineage } from '../../../src/evidence/claim-recovery/validation/native-state.js';
import { correctionAnchor } from '../../../src/evidence/claim-recovery/validation/anchors.js';
import { prepareClaimSplit } from '../../../src/evidence/claim-recovery/validation/claim-split.js';
import { legacyFixture, recoveredFixture, sha, target, uuid } from './fixtures.js';

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

// Two receipt-backed occurrences with exact predecessor snapshots. This builds
// the recovery writer's additive shape without executing a native writer.
function twoStepLineage() {
  const fixture = recoveredFixture();
  const report = JSON.parse(fixture.selection.reportJson);
  const second = { ...structuredClone(report.findings[0]), identity: 'second-retained-claim',
    title: 'Expired cache writes', claimDescriptor: { version: 1 as const, operation: 'cache.ts :: cache.write',
      invariant: 'The cache stores expired entries without validating their expiry timestamp.',
      evidence: ['Validate expiry before storing the cache entry.'] } };
  second.description = second.claimDescriptor.invariant;
  report.findings.push(second);
  const source = JSON.parse(fixture.sourceJson);
  source.rounds[0].counts.new = 2;
  const original = JSON.stringify(source);
  const firstSelection = { ...fixture.selection, nativeJson: original, reportJson: JSON.stringify(report),
    sourceReceipts: structuredClone(fixture.selection.sourceReceipts) };
  (firstSelection.sourceReceipts[0]!.payload.identities as Array<Record<string, unknown>>).push({
    identity_key: second.identity, matched_identity: firstSelection.previousIdentity, status: 'new',
  });
  const append = (selection: typeof fixture.selection, operationId: string) => {
    const predecessor = JSON.parse(selection.nativeJson);
    const event = prepareClaimSplit(selection).event;
    const receipt = { ...selection.scope, ...event, actor_user_id: uuid(7), converge_target: target, round: 1, attempt: null };
    const anchor = correctionAnchor(selection, receipt, uuid(7), operationId);
    return JSON.stringify({ ...predecessor, version: 3, sightings: predecessor.sightings ?? [],
      recovery: { version: 1, operations: [...(predecessor.recovery?.operations ?? []), {
        operationId, sourceVersion: predecessor.version, sourceSha256: sha(selection.nativeJson),
        anchors: [anchor], sourceReceipts: selection.sourceReceipts,
      }] } });
  };
  const intermediate = append(firstSelection, uuid(8));
  const next = { ...firstSelection, nativeJson: intermediate, nativeSourceJsons: [original],
    eventId: uuid(10), identity: '3333333333333333', findingRef: 'f002', descriptor: second.claimDescriptor };
  return { original, intermediate, current: append(next, uuid(9)), snapshots: [original, intermediate] };
}

describe('retained snapshot lineage', () => {
  it.each(['scalar-anchors', 'missing-anchors', 'null-anchor', 'invalid-anchor-identity',
    'scalar-receipts', 'missing-receipts', 'null-operation', 'invalid-operation-id',
    'invalid-source-version', 'invalid-source-digest'])('refuses %s in an otherwise valid recovery lineage', change => {
    const f = recoveredFixture();
    expect(verifyNativeRecoveryLineage(JSON.stringify(f.state), target, [f.sourceJson]).original)
      .toEqual(JSON.parse(f.sourceJson));
    const state = JSON.parse(JSON.stringify(f.state));
    const operation = state.recovery.operations[0];
    if (change === 'scalar-anchors') operation.anchors = operation.anchors[0];
    if (change === 'missing-anchors') delete operation.anchors;
    if (change === 'null-anchor') operation.anchors = [null];
    if (change === 'invalid-anchor-identity') operation.anchors[0].identity = 'not-an-identity';
    if (change === 'scalar-receipts') operation.sourceReceipts = operation.sourceReceipts[0];
    if (change === 'missing-receipts') delete operation.sourceReceipts;
    if (change === 'null-operation') state.recovery.operations[0] = null;
    if (change === 'invalid-operation-id') operation.operationId = '';
    if (change === 'invalid-source-version') operation.sourceVersion = 4;
    if (change === 'invalid-source-digest') operation.sourceSha256 = 123;
    expect(() => verifyNativeRecoveryLineage(JSON.stringify(state), target, [f.sourceJson]))
      .toThrow('native_recovery_lineage_conflict');
  });

  it.each(['null-container', 'array-container', 'invalid-digest', 'missing-path', 'invalid-path',
    'missing-timestamp', 'invalid-timestamp'])('refuses migration %s without accepting malformed retained metadata', change => {
    const f = migrated();
    expect(verifyNativeRecoveryLineage(JSON.stringify(f.current), target, [f.original]).legacy).toEqual(f.state);
    const current = JSON.parse(JSON.stringify(f.current));
    if (change === 'null-container') current.migration = null;
    if (change === 'array-container') current.migration = [];
    if (change === 'invalid-digest') current.migration.sourceSha256 = 123;
    if (change === 'missing-path') delete current.migration.snapshotPath;
    if (change === 'invalid-path') current.migration.snapshotPath = 123;
    if (change === 'missing-timestamp') delete current.migration.migratedAt;
    if (change === 'invalid-timestamp') current.migration.migratedAt = 123;
    expect(() => verifyNativeRecoveryLineage(JSON.stringify(current), target, [f.original]))
      .toThrow('native_recovery_lineage_conflict');
  });

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

  it('refuses a recovery that changes the retained round cap', () => {
    const f = recoveredFixture();
    f.state.roundCap++;
    expect(() => verifyNativeRecoveryLineage(JSON.stringify(f.state), target, [f.sourceJson]))
      .toThrow('native_recovery_lineage_conflict');
  });

  it('refuses a legacy migration that changes the retained round cap', () => {
    const f = migrated();
    f.current.roundCap++;
    expect(() => verifyNativeRecoveryLineage(JSON.stringify(f.current), target, [f.original]))
      .toThrow('native_recovery_lineage_conflict');
  });

  it('refuses a snapshot with a round beyond its declared cap', () => {
    const f = legacyFixture();
    f.state.roundCap = 2;
    f.state.rounds.push({ round: 3, counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } });
    f.state.findings[f.key].lastRound = 3;
    expect(() => verifyNativeRecoveryLineage(JSON.stringify(f.state), target)).toThrow('native_recovery_lineage_conflict');
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

  it('preserves a valid two-step lineage below the aggregate predecessor budget', () => {
    const f = twoStepLineage();
    const result = verifyNativeRecoveryLineage(f.current, target, f.snapshots);
    expect(result.original).toEqual(JSON.parse(f.original));
    expect(result.state.recovery!.operations).toHaveLength(2);
    expect(result.reservedIdentities).toEqual(['2222222222222222', '3333333333333333']);
    expect(result.state.recovery!.operations.map(operation => operation.sourceSha256))
      .toEqual([sha(f.original), sha(f.intermediate)]);
  });

  it('refuses a sighting-less descendant whose exact semantic-v2 root carried sightings', () => {
    const f = recoveredFixture(2);
    const descendant = structuredClone(f.state);
    delete descendant.sightings;
    expect(() => verifyNativeRecoveryLineage(JSON.stringify(descendant), target, [f.sourceJson]))
      .toThrow('native_recovery_lineage_conflict');
  });

  it('refuses a sighting-less intermediate v3 link even when the newest v3 has sightings', () => {
    const f = recoveredFixture(2);
    const intermediate = structuredClone(f.state);
    delete intermediate.sightings;
    const intermediateJson = JSON.stringify(intermediate);
    const newest = structuredClone(intermediate);
    newest.sightings = [];
    newest.recovery.operations.push({ operationId: uuid(990), sourceVersion: 3, sourceSha256: sha(intermediateJson),
      anchors: [{ identity: '3333333333333333' }], sourceReceipts: [] });
    expect(() => verifyNativeRecoveryLineage(JSON.stringify(newest), target, [f.sourceJson, intermediateJson]))
      .toThrow('native_recovery_lineage_conflict');
  });

  it.each(['missing', 'tampered', 'interchanged'])('refuses a %s intermediate predecessor snapshot', change => {
    const f = twoStepLineage();
    const snapshots = change === 'missing' ? [f.original] :
      change === 'tampered' ? [f.original, `${f.intermediate} `] : [f.original, f.intermediate];
    const source = JSON.parse(f.current);
    if (change === 'interchanged') {
      const operations = source.recovery.operations;
      [operations[0].sourceSha256, operations[1].sourceSha256] = [operations[1].sourceSha256, operations[0].sourceSha256];
    }
    expect(() => verifyNativeRecoveryLineage(JSON.stringify(source), target, snapshots)).toThrow('native_recovery_lineage_conflict');
  });

  it('refuses individually allowed snapshots over the aggregate budget before hashing any predecessor', () => {
    const f = twoStepLineage();
    // These are size-preflight inputs, not claimed as parseable source evidence.
    // Distinct strings avoid the duplicate-snapshot check masking the budget.
    const snapshots = ['x'.repeat(33 * 1024 * 1024), 'y'.repeat(33 * 1024 * 1024)];
    expect(snapshots.map(raw => Buffer.byteLength(raw))).toEqual([33 * 1024 * 1024, 33 * 1024 * 1024]);
    expect(snapshots.every(raw => Buffer.byteLength(raw) <= 64 * 1024 * 1024)).toBe(true);
    expect(JSON.parse(f.current).recovery.operations).toHaveLength(snapshots.length);
    vi.mocked(createHash).mockClear();
    expect(() => verifyNativeRecoveryLineage(f.current, target, [])).toThrow('native_recovery_lineage_conflict');
    const sourceHashes = vi.mocked(createHash).mock.calls.length;
    expect(sourceHashes).toBeGreaterThan(0);
    vi.mocked(createHash).mockClear();
    expect(() => verifyNativeRecoveryLineage(f.current, target, snapshots)).toThrow('native_recovery_lineage_conflict');
    expect(createHash).toHaveBeenCalledTimes(sourceHashes);
  });

  it('bounds round lookup work for the largest permitted retained history without changing its contents', () => {
    const f = recoveredFixture();
    const original = JSON.parse(f.sourceJson);
    original.roundCap = 99;
    original.rounds = Array.from({ length: 99 }, (_, index) => ({ ...original.rounds[0], round: index + 1 }));
    const sourceJson = JSON.stringify(original);
    f.state.roundCap = 99;
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
    // Repeated linear lookups visit 4,950 entries for this 99-round history.
    expect(visited).toBeLessThan(4 * original.rounds.length);
  });
});
