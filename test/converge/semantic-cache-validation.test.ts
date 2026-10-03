import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { compareClaims, describeClaim, type ClaimDescriptor } from '../../src/consensus/claim-identity.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';
import { correctionAnchor } from '../../src/converge/correction-anchors.js';
import { deriveNativeRecovery, validateNativeRecoveryState, verifyNativeRecoveryLineage } from '../../src/converge/recovery-state.js';
import { convergeRunStatePath, loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { validateRetainedNativeEvidence } from '../../src/evidence/claim-recovery/validation/native-state.js';
import { admittedActionableBeforeTriage } from '../../src/evidence/claim-recovery/validation/semantic-validation.js';
import { indexSemanticPriorByFileCategory } from '../../src/converge/semantic-state.js';
import { legacyFixture, recoveredFixture, semanticFixture, sha, uuid, target } from '../evidence/recovery-validation/fixtures.js';
import { sampleFinding } from '../telemetry/fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(version: 1 | 2 = 2) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-semantic-cache-')));
  roots.push(root);
  const path = convergeRunStatePath(root, target);
  const retained = version === 1 ? legacyFixture() : semanticFixture();
  if ('reportBinding' in retained.state.rounds[0]!) {
    retained.state.rounds[0]!.reportBinding.sourcePath = `${path}.evidence/${sha(retained.reportJson)}.json`;
  }
  const reports: string[] = [retained.reportJson];
  const admissionSourceJsons: string[] = [];
  const claim = sampleFinding({ file: 'cache.ts', startLine: 10, endLine: 12,
    title: 'Cache entries never expire', description: 'The positive cache returns expired entries without testing their TTL.',
    suggestedFix: 'Check the expiry timestamp before returning a cached result.' });
  async function round(number: number, findings: Array<ConsensusFinding & { claimDescriptor?: ClaimDescriptor }>, predecessor?: string) {
    const runId = uuid(number);
    const rows = findings.map((finding, index) => ({ ...finding,
      identity: `report:${runId}:${String(index + 1).padStart(16, '0')}`,
      claimDescriptor: finding.claimDescriptor ?? describeClaim(finding) }));
    const reportJson = JSON.stringify({ run: { id: runId, converge: { target, round: number,
      ...(predecessor ? { recovery_source: { version: 1, native_sha256: sha(predecessor) } } : {}) },
      target: { kind: 'pr', repo: 'synthetic/recovery', pr_number: 7, head_sha: 'a'.repeat(40) },
      gating: { bound_classification_protocol: 1 } }, findings: rows });
    const result = await processRoundReport({ gitCommonDir: root, target, round: number, runId, findings: rows, evidence: { reportJson } });
    if (predecessor) admissionSourceJsons.push(predecessor);
    reports.push(reportJson);
    return { result, rows, reportJson };
  }
  const key = retained.key;
  const sourceJson = JSON.stringify(retained.state);
  const old = recoveredFixture(version).selection;
  const selection = { ...old, nativeJson: sourceJson };
  const event = prepareClaimSplit(selection).event;
  const anchor = correctionAnchor(selection, { ...selection.scope, ...event,
    actor_user_id: uuid(7), converge_target: target, round: 1, attempt: null }, uuid(7), uuid(8));
  const plan = deriveNativeRecovery({ sourceJson, target, operationId: uuid(8), anchors: [anchor],
    reports: [retained.reportJson], sourceReceipts: selection.sourceReceipts });
  await mkdir(`${path}.evidence`, { recursive: true, mode: 0o700 });
  await writeFile(`${path}.evidence/${sha(retained.reportJson)}.json`, retained.reportJson, { mode: 0o600 });
  await mkdir(`${path}.recovery-sources`, { recursive: true, mode: 0o700 });
  await writeFile(`${path}.recovery-sources/${sha(sourceJson)}.json`, sourceJson, { mode: 0o600 });
  await writeFile(path, plan.resultJson, { mode: 0o600 });
  return { root, path, key, claim, reports, admissionSourceJsons, sourceJson, plan, selection: old, round };
}

const bridgeDescriptors = () => {
  const base = { version: 1 as const, operation: 'fresh-cache.ts :: cache.read',
    invariant: 'The cache returns expired entries without checking their expiry timestamp.' };
  return {
    a: { ...base, evidence: ['expiry timestamp validation stale record return cache path'] },
    b: { ...base, evidence: ['expiry timestamp validation stale record return cache path caller response'] },
    c: { ...base, evidence: ['expiry timestamp validation record return path caller response'] },
  };
};
function bridgeFinding(template: ConsensusFinding, claimDescriptor: ClaimDescriptor): ConsensusFinding & { claimDescriptor: ClaimDescriptor } {
  return { ...template, file: 'fresh-cache.ts', startLine: 10, endLine: 12, severity: 'important',
    gating: { reason: 'consensus' }, claimDescriptor };
}

it('indexes dense admission candidates once while preserving first-seen order', () => {
  const prior = Array.from({ length: 2_000 }, (_, index) => ({
    marker: true, file: 'cache.ts', category: 'correctness', index,
  }));
  const original = Array.prototype[Symbol.iterator];
  let traversed = 0;
  Array.prototype[Symbol.iterator] = function* () {
    if ((this as Array<{ marker?: boolean }>)[0]?.marker) traversed += this.length;
    yield* original.call(this);
  };
  try {
    const indexed = indexSemanticPriorByFileCategory(prior);
    expect(indexed.get(JSON.stringify(['cache.ts', 'correctness']))?.map(row => row.index))
      .toEqual(prior.map(row => row.index));
  } finally {
    Array.prototype[Symbol.iterator] = original;
  }
  expect(traversed).toBe(2_000);
});

it('refuses to expand one v3 claim through a non-clique paraphrase bridge', async () => {
  const f = await fixture();
  const { a, b, c } = bridgeDescriptors();
  expect(compareClaims(a, b)).toBe('supported_paraphrase');
  expect(compareClaims(b, c)).toBe('supported_paraphrase');
  expect(compareClaims(a, c)).toBeUndefined();
  const admitted = await f.round(2, [a, b, c].map(descriptor => bridgeFinding(f.claim, descriptor)), f.plan.resultJson);
  expect(new Set(admitted.result.findings.map(row => row.identity))).toHaveLength(3);
  expect(admitted.result.findings.map(row => row.status)).toEqual(['new', 'new', 'new']);
  expect(admitted.result.findings.map(row => row.sighting?.matchRationale)).toEqual(['ambiguous', 'ambiguous', 'ambiguous']);
  expect(admitted.result.findings.map(row => row.sighting?.pendingRound)).toEqual([2, 2, 2]);
  expect(admitted.result.actionableIdentities).toEqual(expect.arrayContaining(admitted.result.findings.map(row => row.identity)));
});

it('keeps disconnected v3 matches from sharing one prior identity and allocates them independent of report order', async () => {
  async function admit(order: Array<'a' | 'c'>) {
    const f = await fixture(); const descriptors = bridgeDescriptors();
    const prior = await f.round(2, [bridgeFinding(f.claim, descriptors.b)], f.plan.resultJson);
    const admitted = await f.round(3, order.map(key => bridgeFinding(f.claim, descriptors[key])), await readFile(f.path, 'utf8'));
    expect(admitted.result.findings.every(row => row.identity !== prior.result.findings[0]!.identity)).toBe(true);
    expect(new Set(admitted.result.findings.map(row => row.identity))).toHaveLength(2);
    expect(admitted.result.findings.map(row => row.status)).toEqual(['new', 'new']);
    expect(admitted.result.findings.map(row => row.sighting?.matchRationale)).toEqual(['ambiguous', 'ambiguous']);
    expect(admitted.result.findings.map(row => row.sighting?.pendingRound)).toEqual([3, 3]);
    expect(admitted.result.actionableIdentities).toEqual(expect.arrayContaining(admitted.result.findings.map(row => row.identity)));
    return Object.fromEntries(admitted.result.findings.map(row => [
      (row.finding.claimDescriptor as ClaimDescriptor).evidence[0],
      { identity: row.identity, status: row.status, rationale: row.sighting?.matchRationale, pending: row.sighting?.pendingRound },
    ]));
  }
  expect(await admit(['a', 'c'])).toEqual(await admit(['c', 'a']));
});


it.each(['repeat', 'suppressed', 'regating'] as const)('refuses a v2 producer first sighting relabeled %s', status => {
  const f = semanticFixture();
  const state = structuredClone(f.state);
  state.sightings[0]!.status = status;
  state.rounds[0]!.counts = { new: 0, repeat: status === 'repeat' ? 1 : 0,
    suppressed: status === 'suppressed' ? 1 : 0, regating: status === 'regating' ? 1 : 0 };
  state.lastAnnotations = { round: 1, identities: [{ identity: f.key, status, gating: 'consensus' }] };
  expect(() => validateRetainedNativeEvidence({ sourceJson: JSON.stringify(state), target, reports: [f.reportJson] }))
    .toThrow('native_recovery_content_invalid');
});

it.each(['title', 'severity', 'startLine', 'endLine'] as const)('refuses changed %s cache values through filesystem and pure recovered validation', async field => {
  const f = await fixture();
  const state = JSON.parse(f.plan.resultJson);
  await expect(validateNativeRecoveryState(state, f.root, Buffer.from(f.plan.resultJson))).resolves.toBeUndefined();
  const entry = state.findings[f.key];
  if (field === 'title') entry.title = 'Unrelated changed claim';
  if (field === 'severity') entry.severity = 'nitpick';
  if (field === 'startLine') entry.startLine = 11;
  if (field === 'endLine') entry.endLine = 13;
  const raw = JSON.stringify(state);
  await expect(validateNativeRecoveryState(state, f.root, Buffer.from(raw))).rejects.toThrow('native_recovery_state_invalid');
  expect(() => validateRetainedNativeEvidence({ sourceJson: raw, target, reports: f.reports,
    nativeSourceJsons: [f.sourceJson], admissionSourceJsons: f.admissionSourceJsons }))
    .toThrow('native_recovery_content_invalid');
  expect(await readFile(f.path, 'utf8')).toBe(f.plan.resultJson);
});

it('accepts later producer severity and bounds while preserving initial title, ordinary verdicts, and recovery proof', async () => {
  const f = await fixture();
  const claim = { ...f.claim, file: 'fresh-cache.ts', title: 'Cache result survives expiry' };
  const first = await f.round(2, [claim], f.plan.resultJson);
  const key = first.result.findings[0]!.identity;
  const later = await f.round(3, [
    { ...claim, title: 'Expired cache entries are returned', severity: 'critical', startLine: 12, endLine: 15 },
    { ...claim, title: 'Expired cache entries are returned', severity: 'important', startLine: 13, endLine: 16 },
  ], await readFile(f.path, 'utf8'));
  expect(later.result.findings.map(finding => finding.identity)).toEqual([key, key]);
  await recordVerdicts({ gitCommonDir: f.root, target, round: 3,
    verdicts: [{ key, verdict: 'dismissed', reason: 'Current source explicitly enforces cache expiry.' }] });
  const raw = await readFile(f.path, 'utf8');
  const state = (await loadConvergeRunState(f.root, target))!;
  expect(state.findings[key]).toMatchObject({ title: claim.title, severity: 'critical', startLine: 12, endLine: 16,
    verdict: 'dismissed', verdictRound: 3, verdictSeverity: 'critical', verdictReason: 'Current source explicitly enforces cache expiry.' });
  expect(state.recovery).toEqual(JSON.parse(f.plan.resultJson).recovery);
  await expect(validateNativeRecoveryState(state, f.root, Buffer.from(raw))).resolves.toBeUndefined();
  expect(validateRetainedNativeEvidence({ sourceJson: raw, target, reports: f.reports,
    nativeSourceJsons: [f.sourceJson], admissionSourceJsons: f.admissionSourceJsons }).state).toEqual(state);
  expect(await readFile(`${f.path}.recovery-sources/${sha(f.sourceJson)}.json`, 'utf8')).toBe(f.sourceJson);
});

it('retains an older admitted obligation after a later empty round and delayed verdict clear it', async () => {
  const f = await fixture();
  const first = await f.round(2, [f.claim], f.plan.resultJson);
  const key = first.result.findings[0]!.identity;
  await f.round(3, [], await readFile(f.path, 'utf8'));
  const beforeVerdict = (await loadConvergeRunState(f.root, target))!;
  const admitted = beforeVerdict.lastAnnotations!.actionableBeforeTriage!;
  const admission = structuredClone(beforeVerdict.rounds.find(row => row.round === 3)!.admission);
  expect(admitted).toContain(key);
  expect(admission?.actionableIdentities).toEqual(admitted);

  const omitted = structuredClone(beforeVerdict);
  omitted.rounds.find(row => row.round === 3)!.admission!.actionableIdentities = admitted.filter(identity => identity !== key);
  omitted.lastAnnotations!.actionableBeforeTriage = admitted.filter(identity => identity !== key);
  const omittedRaw = JSON.stringify(omitted);
  await expect(validateNativeRecoveryState(omitted, f.root, Buffer.from(omittedRaw)))
    .rejects.toThrow('native_recovery_state_invalid');

  await recordVerdicts({ gitCommonDir: f.root, target, round: 2,
    verdicts: [{ key, verdict: 'dismissed', reason: 'The retained source checks cache expiry.' }] });
  const raw = await readFile(f.path, 'utf8');
  const state = (await loadConvergeRunState(f.root, target))!;
  expect(state.findings[key]).not.toHaveProperty('pendingRound');
  expect(admittedActionableBeforeTriage(state)).toEqual(admitted);
  expect(state.rounds.find(row => row.round === 3)!.admission).toEqual(admission);
  await expect(validateNativeRecoveryState(state, f.root, Buffer.from(raw))).resolves.toBeUndefined();
  expect(validateRetainedNativeEvidence({ sourceJson: raw, target, reports: f.reports,
    nativeSourceJsons: [f.sourceJson], admissionSourceJsons: f.admissionSourceJsons }).state).toEqual(state);
});

it('refuses a discharged identity injected into a later admission snapshot', async () => {
  const f = await fixture();
  const first = await f.round(2, [f.claim], f.plan.resultJson);
  const key = first.result.findings[0]!.identity;
  await recordVerdicts({ gitCommonDir: f.root, target, round: 2,
    verdicts: [{ key, verdict: 'dismissed', reason: 'The retained source checks cache expiry.' }] });
  await f.round(3, [], await readFile(f.path, 'utf8'));
  const state = (await loadConvergeRunState(f.root, target))!;
  const admission = state.rounds.find(row => row.round === 3)!.admission!;
  expect(admission.actionableIdentities).not.toContain(key);

  admission.actionableIdentities.push(key);
  admission.actionableIdentities.sort();
  state.lastAnnotations!.actionableBeforeTriage = [...admission.actionableIdentities];
  const raw = JSON.stringify(state);
  await expect(validateNativeRecoveryState(state, f.root, Buffer.from(raw)))
    .rejects.toThrow('native_recovery_state_invalid');
  expect(() => validateRetainedNativeEvidence({ sourceJson: raw, target, reports: f.reports,
    nativeSourceJsons: [f.sourceJson], admissionSourceJsons: f.admissionSourceJsons }))
    .toThrow('native_recovery_content_invalid');
  expect(() => validateRetainedNativeEvidence({ sourceJson: raw, target, reports: f.reports,
    nativeSourceJsons: [f.sourceJson], admissionSourceJsons: [] }))
    .toThrow('native_recovery_content_invalid');
});

it.each(['missing', 'mismatched'] as const)(
  'fails closed when the authenticated pre-admission source is %s',
  async failure => {
    const f = await fixture();
    await f.round(2, [f.claim], f.plan.resultJson);
    const raw = await readFile(f.path, 'utf8');
    const state = (await loadConvergeRunState(f.root, target))!;
    const digest = state.rounds.find(row => row.round === 2)!.admission!.sourceStateSha256;
    expect(digest).toBe(sha(f.plan.resultJson));
    const sourcePath = `${f.path}.recovery-sources/${digest}.json`;
    expect(await readFile(sourcePath, 'utf8')).toBe(f.plan.resultJson);
    if (failure === 'missing') await rm(sourcePath);
    else await writeFile(sourcePath, `${f.plan.resultJson}\n`);

    await expect(validateNativeRecoveryState(state, f.root, Buffer.from(raw)))
      .rejects.toThrow('native_recovery_state_invalid');
  },
);

it('keeps a new operation pending despite identical evidence and an earlier dismissed operation', async () => {
  const f = await fixture();
  const claim = sampleFinding({ file: 'auth.ts', title: 'GET /accounts lacks authentication',
    description: 'The request handler accepts unauthenticated requests without checking the current session.',
    suggestedFix: 'Validate the current session before processing the request.' });
  const first = await f.round(2, [claim], f.plan.resultJson);
  const key = first.result.findings[0]!.identity;
  await recordVerdicts({ gitCommonDir: f.root, target, round: 2,
    verdicts: [{ key, verdict: 'dismissed', reason: 'The GET route checks the current session.' }] });
  const later = await f.round(3, [{ ...claim, title: 'POST /accounts lacks authentication' }],
    await readFile(f.path, 'utf8'));

  expect(later.result.findings[0]!.identity).not.toBe(key);
  expect(later.result.findings[0]!.status).toBe('new');
  const raw = await readFile(f.path, 'utf8');
  const state = (await loadConvergeRunState(f.root, target))!;
  expect(state.findings[key]).toMatchObject({ verdict: 'dismissed', verdictRound: 2 });
  expect(state.findings[later.result.findings[0]!.identity]).toMatchObject({ pendingRound: 3 });
  expect(state.recovery).toEqual(JSON.parse(f.plan.resultJson).recovery);
  expect(validateRetainedNativeEvidence({ sourceJson: raw, target, reports: f.reports,
    nativeSourceJsons: [f.sourceJson], admissionSourceJsons: f.admissionSourceJsons }).state).toEqual(state);
});

it.each(['repeat', 'suppressed', 'regating'] as const)(
  'refuses a post-recovery first sighting relabeled %s',
  async status => {
    const f = await fixture();
    await f.round(2, [f.claim], f.plan.resultJson);
    await f.round(3, [f.claim], await readFile(f.path, 'utf8'));
    const state = (await loadConvergeRunState(f.root, target))!;
    const sighting = state.sightings!.find(row => row.round === 2)!;
    sighting.status = status;
    sighting.pendingRound = sighting.round;
    state.rounds.find(row => row.round === 2)!.counts = {
      new: 0,
      repeat: status === 'repeat' ? 1 : 0,
      suppressed: status === 'suppressed' ? 1 : 0,
      regating: status === 'regating' ? 1 : 0,
    };
    // Keep the later ordinary round and its current pending annotation intact:
    // only the retained first sighting is forged.
    const raw = JSON.stringify(state);

    expect(() => verifyNativeRecoveryLineage(raw, target, [f.sourceJson])).not.toThrow();
    await expect(validateNativeRecoveryState(state, f.root, Buffer.from(raw))).rejects.toThrow('native_recovery_state_invalid');
    expect(() => validateRetainedNativeEvidence({ sourceJson: raw, target, reports: f.reports,
      nativeSourceJsons: [f.sourceJson], admissionSourceJsons: f.admissionSourceJsons }))
      .toThrow('native_recovery_content_invalid');
  },
);

it('accepts ordinary later repeat, suppression, and critical re-gating', async () => {
  const f = await fixture();
  const important = { ...f.claim, severity: 'important' as const };
  const first = await f.round(2, [important], f.plan.resultJson);
  const key = first.result.findings[0]!.identity;
  const repeated = await f.round(3, [important], await readFile(f.path, 'utf8'));
  expect(repeated.result.findings[0]!.status).toBe('repeat');
  await recordVerdicts({ gitCommonDir: f.root, target, round: 3,
    verdicts: [{ key, verdict: 'dismissed', reason: 'Current source explicitly enforces cache expiry.' }] });
  const suppressed = await f.round(4, [important], await readFile(f.path, 'utf8'));
  expect(suppressed.result.findings[0]!.status).toBe('suppressed');
  expect(suppressed.result.actionableIdentities).not.toContain(key);
  expect((await loadConvergeRunState(f.root, target))!.sightings!.at(-1)).toMatchObject({ status: 'suppressed', pendingRound: null });
  const regated = await f.round(5, [{ ...important, severity: 'critical' }], await readFile(f.path, 'utf8'));
  expect(regated.result.findings[0]!.status).toBe('regating');
  expect(regated.result.actionableIdentities).toContain(key);
  await recordVerdicts({ gitCommonDir: f.root, target, round: 5,
    verdicts: [{ key, verdict: 'dismissed', reason: 'Explicit critical re-triage.' }] });
  const afterRetriage = await f.round(6, [{ ...important, severity: 'critical' }], await readFile(f.path, 'utf8'));
  expect(afterRetriage.result.findings[0]!.status).toBe('suppressed');
  expect(afterRetriage.result.actionableIdentities).not.toContain(key);
  const raw = await readFile(f.path, 'utf8');
  const state = (await loadConvergeRunState(f.root, target))!;
  await expect(validateNativeRecoveryState(state, f.root, Buffer.from(raw))).resolves.toBeUndefined();
  expect(validateRetainedNativeEvidence({ sourceJson: raw, target, reports: f.reports,
    nativeSourceJsons: [f.sourceJson], admissionSourceJsons: f.admissionSourceJsons }).state).toEqual(state);
  const admitted = state.lastAnnotations?.actionableBeforeTriage ?? [];
  const inactive = Object.keys(state.findings).find(identity => !admitted.includes(identity));
  expect(inactive).toBeDefined();
  const forged = structuredClone(state);
  forged.lastAnnotations!.actionableBeforeTriage = [...admitted, inactive!].sort();
  const forgedRaw = JSON.stringify(forged);
  await expect(validateNativeRecoveryState(forged, f.root, Buffer.from(forgedRaw))).rejects.toThrow('native_recovery_state_invalid');
  expect(() => validateRetainedNativeEvidence({ sourceJson: forgedRaw, target, reports: f.reports,
    nativeSourceJsons: [f.sourceJson], admissionSourceJsons: f.admissionSourceJsons }))
    .toThrow('native_recovery_content_invalid');

  const forgedAdmission = structuredClone(state);
  forgedAdmission.rounds.find(row => row.round === forgedAdmission.lastAnnotations!.round)!
    .admission!.actionableIdentities = [...admitted, inactive!].sort();
  forgedAdmission.lastAnnotations!.actionableBeforeTriage = [...admitted, inactive!].sort();
  const forgedAdmissionRaw = JSON.stringify(forgedAdmission);
  await expect(validateNativeRecoveryState(forgedAdmission, f.root, Buffer.from(forgedAdmissionRaw)))
    .rejects.toThrow('native_recovery_state_invalid');

  const forgedOperationBoundary = structuredClone(state);
  forgedOperationBoundary.rounds.find(row => row.round === forgedOperationBoundary.lastAnnotations!.round)!
    .admission!.recoveryOperationCount += 1;
  const forgedOperationBoundaryRaw = JSON.stringify(forgedOperationBoundary);
  await expect(validateNativeRecoveryState(forgedOperationBoundary, f.root, Buffer.from(forgedOperationBoundaryRaw)))
    .rejects.toThrow('native_recovery_state_invalid');
});

it('retains a descriptor-less legacy obligation admitted before its delayed original-round verdict', async () => {
  const f = await fixture(1);
  await f.round(2, [], f.plan.resultJson);
  const before = (await loadConvergeRunState(f.root, target))!;
  const admitted = before.rounds.find(row => row.round === 2)!.admission!.actionableIdentities;
  expect(admitted).toContain(f.key);

  await recordVerdicts({ gitCommonDir: f.root, target, round: 1,
    verdicts: [{ key: f.key, verdict: 'dismissed', reason: 'The retained original claim was source-refuted.' }] });
  const raw = await readFile(f.path, 'utf8');
  const state = (await loadConvergeRunState(f.root, target))!;
  expect(state.findings[f.key]).not.toHaveProperty('pendingRound');
  expect(state.rounds.find(row => row.round === 2)!.admission!.actionableIdentities).toEqual(admitted);
  await expect(validateNativeRecoveryState(state, f.root, Buffer.from(raw))).resolves.toBeUndefined();
});

it('keeps a genuinely appended recovery operation outside an earlier admission snapshot', async () => {
  const f = await fixture();
  const admitted = await f.round(2, [f.claim], f.plan.resultJson);
  const predecessor = await readFile(f.path, 'utf8');
  const retained = admittedActionableBeforeTriage((await loadConvergeRunState(f.root, target))!);
  const laterIdentity = 'eeeeeeeeeeeeeeee';
  const classificationId = uuid(220);
  const scope = { ...f.selection.scope, run_id: uuid(2) };
  const sourceReceipts = [{ id: classificationId, org_id: scope.org_id,
    run_id: scope.run_id, repo: scope.repo, pr_number: scope.pr_number,
    actor_user_id: uuid(221), kind: 'round_processed' as const, converge_target: target, round: 2, attempt: 2,
    occurred_at: '2026-09-23T12:00:00.123456Z', payload: { identities: [{
      identity_key: admitted.rows[0]!.identity, matched_identity: admitted.result.findings[0]!.identity, status: 'new',
    }] } }];
  const selection = { ...f.selection, scope, eventId: uuid(222), occurredAt: '2026-09-23T12:00:01.123456Z',
    nativeJson: predecessor, nativeSourceJsons: [f.sourceJson], reportJson: admitted.reportJson, findingRef: 'f001',
    previousIdentity: admitted.result.findings[0]!.identity, identity: laterIdentity,
    descriptor: admitted.rows[0]!.claimDescriptor!, reason: 'Independent later retained claim.',
    expectedEventSequence: 8, classificationId, sourceReceipts };
  const event = prepareClaimSplit(selection).event;
  const operationId = uuid(223);
  const anchor = correctionAnchor(selection, { ...selection.scope, ...event, actor_user_id: uuid(224),
    converge_target: target, round: 2, attempt: null }, uuid(224), operationId);
  const later = deriveNativeRecovery({ sourceJson: predecessor, target, operationId, anchors: [anchor],
    reports: [admitted.reportJson], sourceReceipts, nativeSourceJsons: [f.sourceJson] });
  await writeFile(`${f.path}.recovery-sources/${sha(predecessor)}.json`, predecessor, { mode: 0o600 });
  await writeFile(f.path, later.resultJson, { mode: 0o600 });
  const state = (await loadConvergeRunState(f.root, target))!;
  expect(admittedActionableBeforeTriage(state)).toEqual(retained);
  expect(admittedActionableBeforeTriage(state)).not.toContain(laterIdentity);
  expect(later.actionableIdentities).toContain(laterIdentity);
  await expect(validateNativeRecoveryState(state, f.root, Buffer.from(later.resultJson))).resolves.toBeUndefined();
});

it('accepts recovered anchors before they have semantic sightings', async () => {
  const f = await fixture();
  const state = JSON.parse(f.plan.resultJson);
  await expect(validateNativeRecoveryState(state, f.root, Buffer.from(f.plan.resultJson))).resolves.toBeUndefined();
  expect(validateRetainedNativeEvidence({ sourceJson: f.plan.resultJson, target, reports: f.reports,
    nativeSourceJsons: [f.sourceJson], admissionSourceJsons: f.admissionSourceJsons }).state)
    .toEqual(state);
});

it('retains an exact stale report before refusing changed recovery state without admission', async () => {
  const f = await fixture();
  const predecessor = f.plan.resultJson;
  const changed = JSON.stringify({ ...JSON.parse(predecessor), updatedAt: '2026-09-24T12:00:00.000Z' });
  await writeFile(f.path, changed);
  const runId = uuid(2);
  const rows = [{ ...f.claim, identity: `report:${runId}:0000000000000001`, claimDescriptor: describeClaim(f.claim) }];
  const reportJson = JSON.stringify({ run: { id: runId, converge: { target, round: 2,
    recovery_source: { version: 1, native_sha256: sha(predecessor) } },
  target: { kind: 'pr', repo: 'synthetic/recovery', pr_number: 7, head_sha: 'a'.repeat(40) },
  gating: { bound_classification_protocol: 1 } }, findings: rows });
  await expect(processRoundReport({ gitCommonDir: f.root, target, round: 2, runId, findings: rows,
    evidence: { reportJson } })).rejects.toThrow('original report retained without native admission');
  expect(await readFile(`${f.path}.evidence/${sha(reportJson)}.json`, 'utf8')).toBe(reportJson);
  expect(await readFile(f.path, 'utf8')).toBe(changed);
});

it.each(['new', 'suppressed'] as const)('refuses a later status relabeled %s without a recorded verdict', async status => {
  const f = await fixture();
  await f.round(2, [f.claim], f.plan.resultJson);
  await f.round(3, [f.claim], await readFile(f.path, 'utf8'));
  const state = (await loadConvergeRunState(f.root, target))!;
  const sighting = state.sightings!.find(row => row.round === 3)!;
  sighting.status = status;
  if (status === 'suppressed') sighting.suppressReason = 'forged dismissal';
  state.rounds.find(row => row.round === 3)!.counts = {
    new: status === 'new' ? 1 : 0,
    repeat: 0,
    suppressed: status === 'suppressed' ? 1 : 0,
    regating: 0,
  };
  state.lastAnnotations = { round: 3, identities: [{ identity: sighting.canonicalIdentity, status, gating: sighting.gating }] };
  const raw = JSON.stringify(state);

  await expect(validateNativeRecoveryState(state, f.root, Buffer.from(raw))).rejects.toThrow('native_recovery_state_invalid');
  expect(() => validateRetainedNativeEvidence({ sourceJson: raw, target, reports: f.reports,
    nativeSourceJsons: [f.sourceJson], admissionSourceJsons: f.admissionSourceJsons }))
    .toThrow('native_recovery_content_invalid');
});

it.each([undefined, 'forged dismissal'])('refuses a later suppression with %s reason', async suppressReason => {
  const f = await fixture();
  const important = { ...f.claim, severity: 'important' as const };
  const first = await f.round(2, [important], f.plan.resultJson);
  const key = first.result.findings[0]!.identity;
  await f.round(3, [important], await readFile(f.path, 'utf8'));
  await recordVerdicts({ gitCommonDir: f.root, target, round: 3,
    verdicts: [{ key, verdict: 'dismissed', reason: 'Current source explicitly enforces cache expiry.' }] });
  await f.round(4, [important], await readFile(f.path, 'utf8'));
  const state = (await loadConvergeRunState(f.root, target))!;
  state.sightings!.find(row => row.round === 4)!.suppressReason = suppressReason;
  const raw = JSON.stringify(state);

  await expect(validateNativeRecoveryState(state, f.root, Buffer.from(raw))).rejects.toThrow('native_recovery_state_invalid');
  expect(() => validateRetainedNativeEvidence({ sourceJson: raw, target, reports: f.reports,
    nativeSourceJsons: [f.sourceJson], admissionSourceJsons: f.admissionSourceJsons }))
    .toThrow('native_recovery_content_invalid');
});
