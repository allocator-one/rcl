import { expect, it } from 'vitest';
import { effectivePendingIdentities, recoveredDismissalsByRound, validateAnchorIdentityBatch,
  validateRetainedNativeEvidence, validateSightinglessLegacyEvolution } from '../../../src/evidence/claim-recovery/validation/native-state.js';
import { packNativeMaterial } from '../../../src/evidence/claim-recovery/validation/native-material.js';
import { deriveNativeOccurrenceEvidence } from '../../../src/evidence/claim-recovery/validation/native-occurrences.js';
import { createRecoveredDismissalLookup, recoveredDismissalsBefore } from '../../../src/evidence/claim-recovery/validation/semantic-validation.js';
import { legacyFixture, recoveredFixture, semanticFixture, sha, target, uuid } from './fixtures.js';
import { setup } from '../parent-r9-projection-fixture.js';
import { laterSource } from './occurrence-fixtures.js';
import { retainedRecoveredDismissalsByRound } from '../../../src/converge/semantic-state.js';

it('retains recovered dismissals from every preceding source round', () => {
  const dismissals = new Map([
    [2, new Map([['second-identity', 'important'], ['shared-identity', 'critical']])],
    [1, new Map([['first-identity', 'minor'], ['shared-identity', 'important']])],
  ]);

  expect(recoveredDismissalsBefore(dismissals, 3)).toEqual(new Map([
    ['first-identity', 'minor'],
    ['second-identity', 'important'],
    ['shared-identity', 'critical'],
  ]));
  expect(recoveredDismissalsBefore(dismissals, 2)).toEqual(new Map([
    ['first-identity', 'minor'],
    ['shared-identity', 'important'],
  ]));
});

it('reuses recovered dismissal projections for repeated reverse-ordered rounds', () => {
  class CountingMap extends Map<number, ReadonlyMap<string, string>> {
    iterations = 0;

    override [Symbol.iterator](): MapIterator<[number, ReadonlyMap<string, string>]> {
      this.iterations += 1;
      return super[Symbol.iterator]();
    }
  }
  const dismissals = new CountingMap([
    [2, new Map([['second-identity', 'critical']])],
    [1, new Map([['first-identity', 'important']])],
  ]);
  const lookup = createRecoveredDismissalLookup(dismissals);

  expect(lookup(3, 'first-identity')).toBe('important');
  expect(lookup(3, 'second-identity')).toBe('critical');
  expect(lookup(2, 'first-identity')).toBe('important');
  expect(lookup(2, 'second-identity')).toBeUndefined();
  expect(lookup(1, 'first-identity')).toBeUndefined();
  expect(lookup(99, 'missing-identity')).toBeUndefined();
  expect(dismissals.iterations).toBe(1);
});

it('validates a new anchor batch without rescanning prior identities', () => {
  let reads = 0;
  const prior = Array.from({ length: 2_000 }, (_, index) => ({
    get identity() { reads += 1; return index.toString(16).padStart(16, '0'); },
  }));
  const anchors = Array.from({ length: 2_000 }, (_, index) => ({
    identity: (index + 2_000).toString(16).padStart(16, '0'),
  }));

  expect(validateAnchorIdentityBatch(prior, anchors, {})).toBe(true);

  expect(reads).toBe(2_000);
  expect(validateAnchorIdentityBatch(prior, [anchors[0]!, anchors[0]!], {})).toBe(false);
  expect(validateAnchorIdentityBatch(prior, [{ identity: prior[0]!.identity }], {})).toBe(false);
  expect(validateAnchorIdentityBatch(prior, [{ identity: 'ffffffffffffffff' }], { ffffffffffffffff: {} })).toBe(false);
});

it('validates v1 content without assigning a descriptor, sighting or migration', () => {
  const f = legacyFixture(); const input = f.input(); const before = structuredClone(input);
  const result = validateRetainedNativeEvidence(input);
  expect(result).toMatchObject({ qualification: 'content-only', state: f.state });
  expect(result.state.findings[f.key]).not.toHaveProperty('claimDescriptor');
  expect(result.state).not.toHaveProperty('sightings');
  expect(result.state).not.toHaveProperty('migration');
  expect(input).toEqual(before);
});

it('accepts exact retained v2 report membership without running a producer', () => {
  const f = semanticFixture(); const input = f.input(); const before = structuredClone(input);
  const result = validateRetainedNativeEvidence(input);
  expect(result).toMatchObject({ qualification: 'content-only', state: f.state });
  expect(input).toEqual(before);
});

it('accepts legacy-to-v2 lineage only with exact retained original bytes', () => {
  const f = legacyFixture(); const original = JSON.stringify(f.state);
  const current = { ...f.state, version: 2, sightings: [],
    findings: { [f.key]: { ...f.state.findings[f.key], pendingRound: 1 } },
    migration: { sourceSha256: sha(original), snapshotPath: `/synthetic/native.v1-${sha(original)}.snapshot`, migratedAt: '2026-09-22T01:00:00Z' } };
  expect(validateRetainedNativeEvidence({ sourceJson: JSON.stringify(current), target, reports: [], nativeSourceJsons: [original] }).state).toEqual(current);
});

it('retains a legacy critical obligation when its original round has no severity ledger', () => {
  const f = legacyFixture();
  f.state.findings[f.key].severity = 'critical';
  delete f.state.rounds[0].severities;
  const original = JSON.stringify(f.state);
  const current = {
    ...f.state,
    version: 2,
    sightings: [],
    findings: {
      [f.key]: {
        ...f.state.findings[f.key],
        verdict: 'dismissed',
        verdictRound: 1,
        verdictSeverity: 'important',
      },
    },
    migration: {
      sourceSha256: sha(original),
      snapshotPath: `/synthetic/native.v1-${sha(original)}.snapshot`,
      migratedAt: '2026-09-22T01:00:00Z',
    },
  };
  const input = { sourceJson: JSON.stringify(current), target, reports: [], nativeSourceJsons: [original] };
  expect(() => validateRetainedNativeEvidence(input)).toThrow();
  current.findings[f.key].pendingRound = 1;
  input.sourceJson = JSON.stringify(current);
  const result = validateRetainedNativeEvidence(input);
  expect(result.actionableIdentities).toEqual([f.key]);
});

it.each(['report-bytes', 'digest', 'run', 'target', 'round', 'ref', 'key', 'descriptor', 'category', 'location', 'counts', 'severity', 'pending', 'annotation', 'missing-member'])
('refuses retained v2 %s tampering', change => {
  const f = semanticFixture(); const input = f.input(); const state = JSON.parse(input.sourceJson);
  if (change === 'report-bytes') input.reports[0] += ' ';
  if (change === 'digest') state.rounds[0].reportBinding.reportSha256 = 'b'.repeat(64);
  if (change === 'run') state.rounds[0].runId = '00000000-0000-7000-8000-000000000099';
  if (change === 'target') state.rounds[0].reportBinding.target = 'other-target';
  if (change === 'round') state.rounds[0].reportBinding.round = 2;
  if (change === 'ref') state.sightings[0].findingRef = 'f002';
  if (change === 'key') state.sightings[0].reportKey = 'another-original';
  if (change === 'descriptor') state.sightings[0].claimDescriptor.invariant = 'A separate different assertion';
  if (change === 'category') state.sightings[0].category = 'security';
  if (change === 'location') state.sightings[0].startLine = 9;
  if (change === 'counts') state.rounds[0].counts.new = 2;
  if (change === 'severity') state.rounds[0].severities[f.key] = 'minor';
  if (change === 'pending') delete state.findings[f.key].pendingRound;
  if (change === 'annotation') state.lastAnnotations.identities[0].status = 'repeat';
  if (change === 'missing-member') state.sightings = [];
  input.sourceJson = JSON.stringify(state);
  expect(() => validateRetainedNativeEvidence(input)).toThrow();
});

it.each(['duplicate-key', 'rounded-counter', 'wrong-target', 'extra-recovery', 'unsupported-version'])
('refuses ambiguous or unsupported source %s', change => {
  const f = legacyFixture(); const input = f.input();
  if (change === 'duplicate-key') input.sourceJson = input.sourceJson.replace('"version":1', '"version":2,"version":1');
  if (change === 'rounded-counter') input.sourceJson = input.sourceJson.replace('"roundCap":15', '"roundCap":15.0000000000000001');
  if (change === 'wrong-target') input.target = 'other-target';
  if (change === 'extra-recovery') input.sourceJson = JSON.stringify({ ...f.state, recovery: { version: 1, operations: [] } });
  if (change === 'unsupported-version') input.sourceJson = JSON.stringify({ ...f.state, version: 4 });
  expect(() => validateRetainedNativeEvidence(input)).toThrow();
});

it.each(['round', 'finding', 'annotation'] as const)('refuses a sighting-less legacy descendant that invents a semantic %s', change => {
  const f = recoveredFixture();
  const state = structuredClone(f.state) as any;
  delete state.sightings;
  const input = { sourceJson: JSON.stringify(state), target, reports: [f.reportJson], nativeSourceJsons: [f.sourceJson] };
  expect(validateRetainedNativeEvidence(input).state.rounds).toEqual(state.rounds);
  if (change === 'round') state.rounds.push({ round: 2, runId: uuid(900), counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } });
  else if (change === 'finding') state.findings.invented = { ...structuredClone(state.findings[f.key]), key: 'invented' };
  else state.lastAnnotations.identities[0].status = 'repeat';
  input.sourceJson = JSON.stringify(state);
  expect(() => validateRetainedNativeEvidence(input)).toThrow('native_recovery_content_invalid');
});

it('permits ordinary verdict evolution on an unchanged sighting-less legacy descendant', () => {
  const f = recoveredFixture();
  const state = structuredClone(f.state) as any;
  delete state.sightings;
  Object.assign(state.findings[f.key], { verdict: 'fixed', verdictRound: 1, verdictSeverity: 'important' });
  const result = validateRetainedNativeEvidence({ sourceJson: JSON.stringify(state), target,
    reports: [f.reportJson], nativeSourceJsons: [f.sourceJson] });
  expect(result.state.findings[f.key]).toMatchObject({ verdict: 'fixed', verdictRound: 1 });
});

it.each(['pending-addition', 'verdict-severity', 'verdict-reason'] as const)
('refuses invalid %s on a sighting-less legacy descendant', change => {
  const f = recoveredFixture();
  const state = structuredClone(f.state) as any;
  delete state.sightings;
  const entry = state.findings[f.key];
  if (change === 'pending-addition') entry.pendingRound = 1;
  if (change === 'verdict-severity') Object.assign(entry, { verdict: 'fixed', verdictRound: 1, verdictSeverity: 'minor' });
  if (change === 'verdict-reason') Object.assign(entry, { verdict: 'fixed', verdictRound: 1,
    verdictSeverity: 'important', verdictReason: 42 });
  const input = { sourceJson: JSON.stringify(state), target, reports: [f.reportJson], nativeSourceJsons: [f.sourceJson] };
  expect(() => validateRetainedNativeEvidence(input)).toThrow('native_recovery_content_invalid');
});

it('accepts only reachable pending and verdict evolution without a semantic sighting ledger', () => {
  const f = legacyFixture();
  const original = structuredClone(f.state) as any;
  original.findings[f.key].pendingRound = 1;
  const retainedPending = structuredClone(original);
  expect(() => validateSightinglessLegacyEvolution(retainedPending, original)).not.toThrow();

  const cleared = structuredClone(original);
  Object.assign(cleared.findings[f.key], { verdict: 'fixed', verdictRound: 1, verdictSeverity: 'important' });
  delete cleared.findings[f.key].pendingRound;
  expect(() => validateSightinglessLegacyEvolution(cleared, original)).not.toThrow();

  const stalePending = structuredClone(cleared);
  stalePending.findings[f.key].pendingRound = 1;
  expect(() => validateSightinglessLegacyEvolution(stalePending, original)).toThrow('native_recovery_source_conflict');

  const reasonWithoutVerdict = structuredClone(original);
  reasonWithoutVerdict.findings[f.key].verdictReason = 'unreachable reason';
  expect(() => validateSightinglessLegacyEvolution(reasonWithoutVerdict, original)).toThrow('native_recovery_source_conflict');

  const historical = structuredClone(original);
  Object.assign(historical.findings[f.key], { verdict: 'dismissed', verdictRound: 1,
    verdictSeverity: 'important', verdictReason: 'retained historical reason' });
  delete historical.findings[f.key].pendingRound;
  expect(() => validateSightinglessLegacyEvolution(structuredClone(historical), historical)).not.toThrow();
});

it('retains a critical pending source despite an earlier important verdict', () => {
  const f = semanticFixture(); const state = JSON.parse(JSON.stringify(f.state));
  const report = structuredClone(f.report); report.run.id = uuid(2); report.run.converge.round = 2;
  report.findings[0]!.identity = `report:${uuid(2)}:critical-repeat`;
  report.findings[0]!.severity = 'critical'; report.findings[0]!.gating.reason = 'critical';
  const reportJson = JSON.stringify(report); const digest = sha(reportJson);
  const binding = { runId: uuid(2), target, round: 2, reportSha256: digest, sourcePath: `/synthetic/native.evidence/${digest}.json` };
  state.rounds.push({ round: 2, runId: uuid(2), reportBinding: binding,
    counts: { new: 0, repeat: 1, suppressed: 0, regating: 0 }, severities: { [f.key]: 'critical' } });
  state.sightings.push({ ...state.sightings[0], runId: uuid(2), round: 2, reportSha256: digest,
    reportKey: report.findings[0]!.identity, severity: 'critical', gating: 'critical', status: 'repeat', pendingRound: 2 });
  Object.assign(state.findings[f.key], { lastRound: 2, severity: 'critical', pendingRound: 2,
    verdict: 'dismissed', verdictRound: 1, verdictSeverity: 'important' });
  state.lastAnnotations = { round: 2, identities: [{ identity: f.key, status: 'repeat', gating: 'critical' }] };
  const input = { sourceJson: JSON.stringify(state), target, reports: [f.reportJson, reportJson] };
  expect(validateRetainedNativeEvidence(input).actionableIdentities).toEqual([f.key]);
  delete state.findings[f.key].pendingRound; input.sourceJson = JSON.stringify(state);
  expect(() => validateRetainedNativeEvidence(input)).toThrow();
  state.findings[f.key].pendingRound = 2; input.sourceJson = JSON.stringify(state);
  expect(validateRetainedNativeEvidence(input).actionableIdentities).toEqual([f.key]);

  const later = structuredClone(report); later.run.id = uuid(3); later.run.converge.round = 3;
  later.findings[0]!.identity = `report:${uuid(3)}:ungated-repeat`;
  later.findings[0]!.gating.reason = 'none';
  const laterJson = JSON.stringify(later); const laterDigest = sha(laterJson);
  const laterBinding = { runId: uuid(3), target, round: 3, reportSha256: laterDigest,
    sourcePath: `/synthetic/native.evidence/${laterDigest}.json` };
  state.rounds.push({ round: 3, runId: uuid(3), reportBinding: laterBinding,
    counts: { new: 0, repeat: 1, suppressed: 0, regating: 0 }, severities: { [f.key]: 'critical' } });
  state.sightings.push({ ...state.sightings[0], runId: uuid(3), round: 3, reportSha256: laterDigest,
    reportKey: later.findings[0]!.identity, severity: 'critical', gating: 'none', status: 'repeat', pendingRound: 2 });
  state.findings[f.key].lastRound = 3;
  state.lastAnnotations = { round: 3, identities: [{ identity: f.key, status: 'repeat', gating: 'none' }] };
  input.reports = [f.reportJson, reportJson, laterJson]; input.sourceJson = JSON.stringify(state);
  expect(validateRetainedNativeEvidence(input).actionableIdentities).toEqual([f.key]);
  delete state.findings[f.key].pendingRound; input.sourceJson = JSON.stringify(state);
  expect(() => validateRetainedNativeEvidence(input)).toThrow('native_recovery_content_invalid');
});

it('accepts a later nongating sighting after a verdict clears the earlier obligation', () => {
  const f = semanticFixture(); const state = structuredClone(f.state) as any;
  Object.assign(state.findings[f.key], {
    verdict: 'fixed', verdictRound: 1, verdictSeverity: 'important', verdictReason: 'Fixed on the reviewed head.',
  });
  delete state.findings[f.key].pendingRound;
  const report = structuredClone(f.report); report.run.id = uuid(4); report.run.converge.round = 2;
  report.findings[0]!.identity = `report:${uuid(4)}:nongating-repeat`;
  report.findings[0]!.gating.reason = 'none';
  const reportJson = JSON.stringify(report); const digest = sha(reportJson);
  const binding = { runId: uuid(4), target, round: 2, reportSha256: digest,
    sourcePath: `/synthetic/native.evidence/${digest}.json` };
  state.rounds.push({ round: 2, runId: uuid(4), reportBinding: binding,
    counts: { new: 0, repeat: 1, suppressed: 0, regating: 0 }, severities: { [f.key]: 'important' } });
  state.sightings.push({ ...state.sightings[0], runId: uuid(4), round: 2, reportSha256: digest,
    reportKey: report.findings[0]!.identity, gating: 'none', status: 'repeat', pendingRound: null });
  state.findings[f.key].lastRound = 2;
  state.lastAnnotations = { round: 2, identities: [{ identity: f.key, status: 'repeat', gating: 'none' }] };
  expect(validateRetainedNativeEvidence({ sourceJson: JSON.stringify(state), target,
    reports: [f.reportJson, reportJson] }).actionableIdentities).toEqual([]);
});

it('validates a long per-identity round history with exact grouped pending captures', () => {
  const f = semanticFixture();
  const state = structuredClone(f.state) as any;
  const reports = [f.reportJson];
  state.roundCap = 99;
  for (let round = 2; round <= 99; round++) {
    const report = structuredClone(f.report);
    report.run.id = uuid(1_000 + round);
    report.run.converge.round = round;
    report.findings[0]!.identity = `report:${report.run.id}:repeat`;
    const reportJson = JSON.stringify(report);
    const digest = sha(reportJson);
    const binding = { runId: report.run.id, target, round, reportSha256: digest,
      sourcePath: `/synthetic/native.evidence/${digest}.json` };
    state.rounds.push({ round, runId: report.run.id, reportBinding: binding,
      counts: { new: 0, repeat: 1, suppressed: 0, regating: 0 }, severities: { [f.key]: 'important' } });
    const { sourcePath: _sourcePath, ...sightingBinding } = binding;
    state.sightings.push({ ...state.sightings[0], ...sightingBinding, reportKey: report.findings[0]!.identity,
      status: 'repeat', pendingRound: round });
    reports.push(reportJson);
  }
  state.findings[f.key].lastRound = 99;
  state.findings[f.key].pendingRound = 99;
  state.lastAnnotations = { round: 99, identities: [{ identity: f.key, status: 'repeat', gating: 'consensus' }] };

  const input = { sourceJson: JSON.stringify(state), target, reports };
  expect(validateRetainedNativeEvidence(input).actionableIdentities).toEqual([f.key]);
  state.sightings[49].pendingRound = 1;
  input.sourceJson = JSON.stringify(state);
  expect(() => validateRetainedNativeEvidence(input)).toThrow('native_recovery_content_invalid');
});

it('keeps same-round recovered dismissals when a later operation has no current projection', () => {
  const f = setup('dismissed');
  const projection = f.run();
  const sourceJson = JSON.stringify(f.state);
  const occurrences = deriveNativeOccurrenceEvidence({ dispositions: [f.disposition] }, {
    target: f.state.target, sourceJson, anchors: [f.anchor], previous: [],
  });
  expect(occurrences).toBeDefined();
  const packed = packNativeMaterial({
    currentProjection: projection,
    occurrences,
  });
  const state = {
    ...structuredClone(f.state),
    version: 3,
    recovery: {
      version: 2,
      operations: [
        { operationId: uuid(970), sourceVersion: 1, sourceSha256: sha(sourceJson), anchors: [], sourceReceipts: [], material: packed.reference },
        { operationId: uuid(971), sourceVersion: 1, sourceSha256: sha(sourceJson), anchors: [], sourceReceipts: [] },
      ],
    },
  } as any;

  expect(recoveredDismissalsByRound(state, packed.materials, new Map([[sha(sourceJson), sourceJson]])))
    .toEqual(new Map([[1, new Map([[f.anchor.identity, 'important']])]]));
});

it('reads physical recovery artifacts through the shared same-round dismissal projection', async () => {
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { convergeRunStatePath } = await import('../../../src/converge/run-state.js');
  const f = setup('dismissed'); const sourceJson = JSON.stringify(f.state);
  const occurrences = deriveNativeOccurrenceEvidence({ dispositions: [f.disposition] }, {
    target: f.state.target, sourceJson, anchors: [f.anchor], previous: [],
  });
  const packed = packNativeMaterial({ currentProjection: f.run(), occurrences });
  const state = { ...structuredClone(f.state), version: 3, recovery: { version: 2, operations: [
    { operationId: uuid(973), sourceVersion: 1, sourceSha256: sha(sourceJson), anchors: [], sourceReceipts: [], material: packed.reference },
    { operationId: uuid(974), sourceVersion: 1, sourceSha256: sha(sourceJson), anchors: [], sourceReceipts: [] },
  ] } } as any;
  const dir = await mkdtemp(join(tmpdir(), 'dismissal-adapter-'));
  try {
    const path = convergeRunStatePath(dir, state.target);
    await mkdir(`${path}.recovery-sources`, { recursive: true });
    await mkdir(`${path}.recovery-materials`, { recursive: true });
    await writeFile(`${path}.recovery-sources/${sha(sourceJson)}.json`, sourceJson);
    for (const material of packed.materials) await writeFile(`${path}.recovery-materials/${material.sha256}`, material.text);
    expect(await retainedRecoveredDismissalsByRound(state, dir))
      .toEqual(new Map([[1, new Map([[f.anchor.identity, 'important']])]]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not recover a dismissed receipt after the current projection reopens the claim', () => {
  const f = setup('dismissed');
  f.add(laterSource(f.f.disposition, 2, true, 'critical'));
  const projection = f.run();
  expect(projection.claims[0]).toMatchObject({ identity: f.anchor.identity, standing: 'pending' });
  const sourceJson = JSON.stringify(f.state);
  const occurrences = deriveNativeOccurrenceEvidence({ dispositions: [f.disposition] }, {
    target: f.state.target, sourceJson, anchors: [f.anchor], previous: [],
  });
  expect(occurrences).toBeDefined();
  const packed = packNativeMaterial({
    currentProjection: projection,
    occurrences,
  });
  const state = {
    ...structuredClone(f.state),
    version: 3,
    recovery: { version: 2, operations: [
      { operationId: uuid(972), sourceVersion: 1, sourceSha256: sha(sourceJson), anchors: [], sourceReceipts: [], material: packed.reference },
    ] },
  } as any;

  expect(recoveredDismissalsByRound(state, packed.materials, new Map([[sha(sourceJson), sourceJson]])))
    .toEqual(new Map([[1, new Map()]]));
});

it('retains pending identities from every recovery operation when no current projection applies', () => {
  const f = recoveredFixture(); const state = structuredClone(f.state) as any;
  state.recovery.operations[0].material = {
    version: 1, rootSha256: 'a'.repeat(64), sha256s: ['a'.repeat(64)],
    pendingIdentities: ['1111111111111111'],
  };
  state.recovery.operations.push({
    operationId: uuid(99), sourceVersion: 3, sourceSha256: sha(JSON.stringify(state)), anchors: [], sourceReceipts: [],
    material: { version: 1, rootSha256: 'b'.repeat(64), sha256s: ['b'.repeat(64)], pendingIdentities: [] },
  });
  expect(effectivePendingIdentities(state)).toContain('1111111111111111');
});

it('keeps unresolved legacy claims typed separately from producer descriptors and recorded pending rounds', () => {
  const f = legacyFixture(); const result = validateRetainedNativeEvidence(f.input());
  expect(result.legacyClaims).toEqual([{ kind: 'legacy-identity', identity: f.key, migrationPendingRound: 1 }]);
  expect(result.state.findings[f.key]).not.toHaveProperty('pendingRound');
  expect(result.state.findings[f.key]).not.toHaveProperty('claimDescriptor');
});
