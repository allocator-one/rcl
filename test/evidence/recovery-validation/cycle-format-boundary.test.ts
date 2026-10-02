import { expect, it } from 'vitest';
import { validateRetainedNativeEvidence, verifyNativeRecoveryLineage } from '../../../src/evidence/claim-recovery/validation/native-state.js';
import { deriveCurrentClaimProjection } from '../../../src/evidence/claim-recovery/validation/current-projection.js';
import { semanticFixture, sha, uuid } from './fixtures.js';
import { recoveredCycle, retained } from './cycle-format-fixture.js';

function direct() {
  const state = JSON.parse(retained.sourceJson);
  return { state, input: () => ({ sourceJson: JSON.stringify(state), target: retained.target, reports: [] as string[] }) };
}

it.each(['descriptor', 'pending', 'binding', 'sightings', 'migration', 'recovery'])
('refuses cycle2 hybrid semantic authority: %s', field => {
  const f = direct(), semantic = semanticFixture(), key = Object.keys(f.state.findings)[0]!;
  if (field === 'descriptor') f.state.findings[key].claimDescriptor = semantic.state.findings[semantic.key]!.claimDescriptor;
  if (field === 'pending') f.state.findings[key].pendingRound = 1;
  if (field === 'binding') f.state.rounds[0].reportBinding = semantic.state.rounds[0]!.reportBinding;
  if (field === 'sightings') f.state.sightings = [];
  if (field === 'migration') f.state.migration = { sourceSha256: sha(retained.sourceJson), snapshotPath: '/synthetic/snapshot' };
  if (field === 'recovery') f.state.recovery = { version: 1, operations: [] };
  // Shape refusal precedes content dispatch; a cycle must never grant semantic authority.
  expect(() => verifyNativeRecoveryLineage(f.input().sourceJson, retained.target)).toThrow();
  expect(() => validateRetainedNativeEvidence(f.input())).toThrow();
});

it.each(['unknown-version', 'cycle-null', 'cycle-extra', 'fractional-history', 'negative-history', 'unsafe-history', 'duplicate-round', 'negative-count', 'missing-first-round'])
('refuses malformed released cycle2 content: %s', field => {
  const f = direct(), key = Object.keys(f.state.findings)[0]!;
  if (field === 'unknown-version') f.state.version = 4;
  if (field === 'cycle-null') f.state.cycle = null;
  if (field === 'cycle-extra') f.state.cycle.unrecognized = true;
  if (field === 'fractional-history') f.state.cycle.history.rounds = 1.5;
  if (field === 'negative-history') f.state.cycle.history.attempts = -1;
  if (field === 'unsafe-history') f.state.cycle.history.attempts = Number.MAX_SAFE_INTEGER + 1;
  if (field === 'duplicate-round') f.state.rounds.push(structuredClone(f.state.rounds[0]));
  if (field === 'negative-count') f.state.rounds[0].counts.new = -1;
  if (field === 'missing-first-round') f.state.findings[key].firstRound = 2;
  expect(() => validateRetainedNativeEvidence(f.input())).toThrow();
});

it('preserves direct cycle2 original bytes, accounting and separately derived legacy obligations', () => {
  const input = { sourceJson: retained.sourceJson, target: retained.target, reports: [] as string[] };
  const before = JSON.stringify(input), original = JSON.parse(input.sourceJson);
  const result = validateRetainedNativeEvidence(input);
  expect(result.qualification).toBe('content-only');
  expect(result.sourceSha256).toBe(sha(retained.sourceJson));
  expect(result.state).toEqual(original);
  expect(result.state.cycle!.history).toEqual({ attempts: 3, rounds: 1 });
  expect(JSON.parse(retained.attemptsJson).attemptsUsed).toBe(1);
  expect(result.legacyClaims).toEqual(Object.keys(original.findings).map(identity => ({ kind: 'legacy-identity', identity, migrationPendingRound: 1 })));
  for (const entry of Object.values(result.state.findings)) {
    expect(entry).not.toHaveProperty('pendingRound');
    expect(entry).not.toHaveProperty('claimDescriptor');
  }
  // Cycle archive authentication is not asserted by this pure, content-only API.
  expect(result.filesystemRequirements).toEqual([]);
  expect(JSON.stringify(input)).toBe(before);
});

it('retains recovered cycle legacy and corrected obligations with explicit unavailable-history residuals', () => {
  const f = recoveredCycle(), before = JSON.stringify(f.input), result = validateRetainedNativeEvidence(f.input);
  const anchor = f.state.recovery.operations[0]!.anchors[0]!;
  expect(result.actionableIdentities).toEqual([...Object.keys(f.original.findings), anchor.identity].sort());
  expect(result.legacyClaims).toEqual(Object.keys(f.original.findings).map(identity => ({ kind: 'legacy-identity', identity, migrationPendingRound: 1 })));
  expect(result.filesystemRequirements).toContainEqual({ kind: 'native-predecessor', sha256: sha(retained.sourceJson), nativePathSuffix: `.recovery-sources/${sha(retained.sourceJson)}.json` });
  const projected = deriveCurrentClaimProjection(result.state, [anchor], [], {
    actorUserId: uuid(7), readWindow: { startedAt: '2026-09-27T00:00:00Z', completedAt: '2026-09-27T00:00:01Z' },
    sources: [{ selector: { scope: f.selection.scope, target: retained.target, round: 1, headSha: 'a'.repeat(40), reportSha256: sha(retained.reportJson) } }],
    histories: [{ runId: f.selection.scope.run_id, eventSequence: anchor.receipt.sequence, receipts: [anchor.receipt] }],
  }, f.input.nativeSourceJsons, f.input.sourceJson);
  expect(projected.residuals).toContainEqual({ reason: 'source_evidence_unavailable', runId: f.selection.scope.run_id, round: 1 });
  expect(projected.actionableIdentities).toEqual(result.actionableIdentities);
  expect(JSON.stringify(f.input)).toBe(before);
});

it.each(['cycle-id', 'cycle-history', 'cap', 'round-counts', 'round-run', 'round-removal', 'finding-removal'])
('refuses recovered cycle mutation against immutable predecessor: %s', field => {
  const f = recoveredCycle(), state = structuredClone(f.state);
  if (field === 'cycle-id') state.cycle.id = uuid(998);
  if (field === 'cycle-history') state.cycle.history.rounds++;
  if (field === 'cap') state.roundCap++;
  if (field === 'round-counts') state.rounds[0].counts.new++;
  if (field === 'round-run') state.rounds[0].runId = uuid(999);
  if (field === 'round-removal') state.rounds = [];
  if (field === 'finding-removal') delete state.findings[Object.keys(state.findings)[0]!];
  expect(() => validateRetainedNativeEvidence({ ...f.input, sourceJson: JSON.stringify(state) })).toThrow();
  expect(f.input.nativeSourceJsons).toEqual([retained.sourceJson]);
});

function extendedCycle(change?: string) {
  const f = recoveredCycle(), semantic = semanticFixture(), state = structuredClone(f.state);
  const report: any = structuredClone(semantic.report);
  report.run.cycle_id = state.cycle.id;
  report.run.target.repo = state.cycle.repo;
  report.run.target.pr_number = state.cycle.prNumber;
  if (change === 'missing-cycle') delete report.run.cycle_id;
  if (change === 'wrong-cycle') report.run.cycle_id = uuid(997);
  if (change === 'wrong-repo') report.run.target.repo = 'other/repository';
  if (change === 'wrong-pr') report.run.target.pr_number++;
  if (change === 'repo-case') report.run.target.repo = state.cycle.repo.toUpperCase();
  report.run.converge = { target: retained.target, round: 2 };
  const reportJson = JSON.stringify(report), digest = sha(reportJson);
  const round = structuredClone(semantic.state.rounds[0]!);
  round.round = 2;
  Object.assign(round.reportBinding, { target: retained.target, round: 2, reportSha256: digest, sourcePath: `/synthetic/native.evidence/${digest}.json` });
  state.rounds.push(round);
  state.findings[semantic.key] = { ...semantic.state.findings[semantic.key], firstRound: 2, lastRound: 2, pendingRound: 2 };
  state.sightings = [{ ...semantic.state.sightings[0], target: retained.target, round: 2, reportSha256: digest, pendingRound: 2 }];
  state.lastAnnotations = { round: 2, identities: semantic.state.lastAnnotations.identities };
  return { f, state, semantic, input: () => ({ ...f.input, sourceJson: JSON.stringify(state), reports: [...f.input.reports, reportJson] }) };
}

it('validates a synthetic semantic second round while preserving only original cycle rounds as legacy', () => {
  const f = extendedCycle(), input = f.input(), before = JSON.stringify(input);
  const result = validateRetainedNativeEvidence(input);
  expect(result.state.rounds[0]).toEqual(f.f.original.rounds[0]);
  expect(result.state.rounds[1]).toEqual(f.state.rounds[1]);
  expect(result.state.sightings).toEqual(f.state.sightings);
  expect(result.actionableIdentities).toContain(f.semantic.key);
  expect(result.actionableIdentities).toContain(Object.keys(f.f.original.findings)[0]);
  expect(result.state.findings[f.semantic.key]).toMatchObject({ pendingRound: 2, claimDescriptor: f.semantic.state.findings[f.semantic.key]!.claimDescriptor });
  expect(JSON.stringify(input)).toBe(before);
});

it.each(['missing-member', 'duplicate-member', 'invented-original-member', 'counts', 'descriptor', 'report-ref', 'pending', 'missing-report'])
('still validates added semantic membership in recovered cycle3: %s', field => {
  const f = extendedCycle();
  if (field === 'missing-member') f.state.sightings = [];
  if (field === 'duplicate-member') f.state.sightings.push(structuredClone(f.state.sightings[0]));
  if (field === 'invented-original-member') f.state.sightings.push({ ...f.state.sightings[0], round: 1 });
  if (field === 'counts') f.state.rounds[1].counts.new++;
  if (field === 'descriptor') f.state.findings[f.semantic.key].claimDescriptor = { ...f.state.findings[f.semantic.key].claimDescriptor, invariant: 'Unrelated semantic assertion.' };
  if (field === 'report-ref') f.state.sightings[0].findingRef = 'f999';
  if (field === 'pending') delete f.state.findings[f.semantic.key].pendingRound;
  const input = f.input();
  if (field === 'missing-report') input.reports.pop();
  expect(() => validateRetainedNativeEvidence(input)).toThrow();
});


it.each(['missing-cycle', 'wrong-cycle', 'wrong-repo', 'wrong-pr'])
('refuses later semantic cycle membership mismatch with recomputed exact bindings: %s', change => {
  const f = extendedCycle(change), input = f.input();
  const raw = input.reports.at(-1)!;
  expect(sha(raw)).toBe(f.state.rounds[1].reportBinding.reportSha256);
  expect(sha(raw)).toBe(f.state.sightings[0].reportSha256);
  expect(f.state.rounds[1].reportBinding.target).toBe(retained.target);
  expect(f.state.rounds[1].reportBinding.round).toBe(2);
  expect(JSON.parse(raw).run.id).toBe(f.state.rounds[1].runId);
  expect(() => validateRetainedNativeEvidence(input)).toThrow();
});

it('accepts case-insensitive repository spelling with exact cycle membership', () => {
  const f = extendedCycle('repo-case');
  expect(validateRetainedNativeEvidence(f.input()).state.sightings).toEqual(f.state.sightings);
});

it('refuses an unexpected-cycle report in a non-cycle semantic state with recomputed exact bindings', () => {
  const f = semanticFixture();
  expect(validateRetainedNativeEvidence(f.input()).qualification).toBe('content-only');
  const report = { ...f.report, run: { ...f.report.run, cycle_id: uuid(996) } };
  const reportJson = JSON.stringify(report), digest = sha(reportJson), state = structuredClone(f.state);
  Object.assign(state.rounds[0]!.reportBinding, { reportSha256: digest, sourcePath: `/synthetic/native.evidence/${digest}.json` });
  state.sightings[0]!.reportSha256 = digest;
  expect(sha(reportJson)).toBe(state.rounds[0]!.reportBinding.reportSha256);
  expect(state).not.toHaveProperty('cycle');
  expect(() => validateRetainedNativeEvidence({ sourceJson: JSON.stringify(state), target: state.target, reports: [reportJson] })).toThrow();
});
