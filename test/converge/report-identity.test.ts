import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableFindingKey } from '../../src/consensus/finding-identity.js';
import { computeConsensus, applyReportThresholds } from '../../src/consensus/voter.js';
import { processRoundReport, recordVerdicts, loadConvergeRunState } from '../../src/converge/run-state.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { buildEvent, roundIdentities } from '../../src/telemetry/events.js';
import { sampleFinding, sampleResult, sampleReview } from '../telemetry/fixtures.js';

const RUN_ID = sampleResult().run!.id;
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'rcl-report-identity-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function consensus(starts: number[], runId = RUN_ID) {
  const inputs = starts.map((startLine) => sampleFinding({
    startLine, endLine: startLine,
    severity: startLine === 12 ? 'nitpick' : 'important',
  }));
  const model = 'test-model';
  const role = 'general';
  return computeConsensus(
    runId,
    inputs.map((finding) => ({ representative: finding, members: [{ finding, model, role }] })),
    [sampleReview({ model, role, findings: inputs }), sampleReview({ model: 'other-model', role })],
    new Map()
  );
}

describe('report identity through native classification and telemetry', () => {
  it('refuses a malformed report-scoped key before it can use legacy matching', async () => {
    const [finding] = consensus([42]);
    const target = 'malformed-report-key';
    const prior = await processRoundReport({
      gitCommonDir: dir, target, round: 1, findings: [{ ...finding!, identity: undefined }],
    });
    await recordVerdicts({ gitCommonDir: dir, target, round: 1, verdicts: [
      { key: prior.findings[0]!.identity, verdict: 'dismissed', reason: 'Legacy claim reviewed' },
    ] });
    const state = await loadConvergeRunState(dir, target);
    await expect(processRoundReport({
      gitCommonDir: dir,
      target,
      round: 2,
      findings: [{ ...finding!, identity: finding!.identity!.toUpperCase() }],
    })).rejects.toThrow(/invalid report identity/i);
    expect(await loadConvergeRunState(dir, target)).toEqual(state);
  });

  it('rejects report-like identity variants before state writes', async () => {
    const [finding] = consensus([42]);
    const identity = finding!.identity!;
    const variants = [identity.toUpperCase(), ` ${identity}`, `${identity} `, identity.slice(0, -1)];
    variants.push(`re\u200bport:${identity.slice('report:'.length)}`);

    for (const [index, malformedIdentity] of variants.entries()) {
      const target = `malformed-variant-${index}`;
      await expect(processRoundReport({
        gitCommonDir: dir,
        target,
        round: 1,
        findings: [{ ...finding!, identity: malformedIdentity }],
      })).rejects.toThrow(/invalid report identity/i);
      expect(await loadConvergeRunState(dir, target)).toBeUndefined();
    }
  });

  it('rejects duplicate canonical report identities before state writes', async () => {
    const [finding] = consensus([42]);
    await expect(processRoundReport({
      gitCommonDir: dir,
      target: 'duplicate-report-identity',
      round: 1,
      findings: [finding!, { ...finding! }],
    })).rejects.toThrow(/duplicate report identity/i);
    expect(await loadConvergeRunState(dir, 'duplicate-report-identity')).toBeUndefined();
  });

  it('keeps mixed modern and legacy claims one-to-one', async () => {
    const [modern, legacy] = consensus([42, 42]).map((finding, index) => ({
      ...finding,
      title: index === 0 ? 'Modern claim' : 'Legacy claim',
      description: index === 0 ? 'Modern report identity owns this entry.' : 'Legacy input must receive its own entry.',
    }));

    const result = await processRoundReport({
      gitCommonDir: dir,
      target: 'mixed-identity-claims',
      round: 1,
      findings: [modern!, { ...legacy!, identity: undefined }],
    });
    expect(new Set(result.findings.map((finding) => finding.identity)).size).toBe(2);
  });

  it('keeps identical mixed claims one-to-one in either input order', async () => {
    const [modern] = consensus([42]);
    const legacy = { ...modern!, identity: undefined };

    for (const [target, findings] of [
      ['legacy-first', [legacy, modern!]],
      ['modern-first', [modern!, legacy]],
    ] as const) {
      const result = await processRoundReport({ gitCommonDir: dir, target, round: 1, findings });
      expect(new Set(result.findings.map((finding) => finding.identity)).size).toBe(2);
    }
  });

  it('continues to accept all-legacy reports for compatibility', async () => {
    const [finding] = consensus([42]);
    const result = await processRoundReport({
      gitCommonDir: dir,
      target: 'legacy-only-report',
      round: 1,
      findings: [{ ...finding!, identity: undefined }],
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ status: 'new' });
  });

  it('preserves a legacy-only identity across a later legacy-only report', async () => {
    const [first] = consensus([42]);
    const initial = await processRoundReport({
      gitCommonDir: dir,
      target: 'legacy-only-repeat',
      round: 1,
      findings: [{ ...first!, identity: undefined }],
    });
    const [later] = consensus([42], '00000000-0000-7000-8000-000000000002');
    const repeated = await processRoundReport({
      gitCommonDir: dir,
      target: 'legacy-only-repeat',
      round: 2,
      findings: [{ ...later!, identity: undefined }],
    });

    expect(repeated.findings[0]).toMatchObject({ status: 'repeat', identity: initial.findings[0]!.identity });
    expect((await loadConvergeRunState(dir, 'legacy-only-repeat'))!.findings[initial.findings[0]!.identity])
      .toMatchObject({ identityOrigin: 'legacy' });
  });

  it.each([false, true])('keeps legacy history separate through mixed-report repeats when modern comes first: %s', async (modernFirst) => {
    const target = `legacy-to-mixed-${modernFirst}`;
    const [first] = consensus([42]);
    const legacy = { ...first!, identity: undefined };
    const initial = await processRoundReport({ gitCommonDir: dir, target, round: 1, findings: [legacy] });
    const legacyIdentity = initial.findings[0]!.identity;
    await recordVerdicts({ gitCommonDir: dir, target, round: 1,
      verdicts: [{ key: legacyIdentity, verdict: 'dismissed', reason: 'Legacy finding was reviewed' }] });

    const [modern] = consensus([42], '00000000-0000-7000-8000-000000000002');
    const mixed = modernFirst ? [modern!, { ...modern!, identity: undefined }] : [{ ...modern!, identity: undefined }, modern!];
    const transition = await processRoundReport({ gitCommonDir: dir, target, round: 2, findings: mixed });
    const transitionModern = transition.findings.find(({ finding }) => finding.identity !== undefined)!;
    const transitionLegacy = transition.findings.find(({ finding }) => finding.identity === undefined)!;
    expect(transitionModern).toMatchObject({ status: 'new' });
    expect(transitionLegacy).toMatchObject({ status: 'suppressed', identity: legacyIdentity });
    expect(transitionModern.identity).not.toBe(legacyIdentity);

    const [nextModern] = consensus([42], '00000000-0000-7000-8000-000000000003');
    const next = modernFirst
      ? [nextModern!, { ...nextModern!, identity: undefined }]
      : [{ ...nextModern!, identity: undefined }, nextModern!];
    const repeated = await processRoundReport({ gitCommonDir: dir, target, round: 3, findings: next });
    expect(repeated.findings.find(({ finding }) => finding.identity !== undefined))
      .toMatchObject({ status: 'repeat', identity: transitionModern.identity });
    expect(repeated.findings.find(({ finding }) => finding.identity === undefined))
      .toMatchObject({ status: 'suppressed', identity: legacyIdentity });
  });

  it('allocates a fresh modern identity for ambiguous same-digest history without transferring verdicts', async () => {
    const target = 'ambiguous-modern-history';
    const [first] = consensus([42]);
    const initial = await processRoundReport({
      gitCommonDir: dir,
      target,
      round: 1,
      findings: [first!, { ...first!, identity: `report:${RUN_ID}:ffffffffffffffff` }],
    });
    await recordVerdicts({ gitCommonDir: dir, target, round: 1,
      verdicts: [{ key: initial.findings[0]!.identity, verdict: 'dismissed', reason: 'First modern claim was reviewed' }] });

    const [later] = consensus([42], '00000000-0000-7000-8000-000000000002');
    const result = await processRoundReport({ gitCommonDir: dir, target, round: 2, findings: [later!] });

    expect(result.findings[0]).toMatchObject({ status: 'new' });
    expect(result.findings[0]!.identity).not.toBe(initial.findings[0]!.identity);
    expect(result.findings[0]!.identity).not.toBe(initial.findings[1]!.identity);
  });

  it('rejects malformed report-like keys and non-string text atomically', async () => {
    const [finding] = consensus([42]);
    const target = 'atomic-malformed-report';
    await processRoundReport({ gitCommonDir: dir, target, round: 1, findings: [finding!] });
    const state = await loadConvergeRunState(dir, target);
    const confusable = `r\u0435\u0440\u043ert:${finding!.identity!.slice('report:'.length)}`;

    for (const invalid of [
      { ...finding!, identity: confusable },
      { ...finding!, description: null },
    ]) {
      await expect(processRoundReport({
        gitCommonDir: dir,
        target,
        round: 2,
        findings: [finding!, invalid as unknown as typeof finding],
      })).rejects.toThrow(/invalid (report identity|finding text)/i);
      expect(await loadConvergeRunState(dir, target)).toEqual(state);
    }
  });

  it('matches canonically equivalent Unicode claim text across report runs', async () => {
    const [first] = consensus([42]);
    const initial = await processRoundReport({
      gitCommonDir: dir,
      target: 'canonical-claim-text',
      round: 1,
      findings: [{ ...first!, title: 'Café access', description: 'Line one\r\nLine two' }],
    });
    const [later] = consensus([42], '00000000-0000-7000-8000-000000000002');
    const repeated = await processRoundReport({
      gitCommonDir: dir,
      target: 'canonical-claim-text',
      round: 2,
      findings: [{ ...later!, title: 'Cafe\u0301 access', description: 'Line one\nLine two' }],
    });

    expect(repeated.findings[0]).toMatchObject({ status: 'repeat', identity: initial.findings[0]!.identity });
  });

  it('keeps distinct same-location claims separate through verdict resolution', async () => {
    const findings = consensus([42, 42]).map((finding, index) => ({
      ...finding,
      title: index === 0 ? 'Page token is restored as an empty cursor' : 'Folder frontier grows without a bound',
      description: index === 0 ? 'An empty cursor reaches the provider.' : 'The persisted frontier can exhaust memory.',
      gating: { reason: 'consensus' as const },
    }));
    expect(new Set(findings.map((finding) => finding.identity)).size).toBe(2);

    const classified = await processRoundReport({ gitCommonDir: dir, target: 'same-location', round: 1, findings });
    expect(new Set(classified.findings.map((finding) => finding.identity)).size).toBe(2);
    const dismissed = classified.findings[0]!.identity;
    const outstanding = classified.findings[1]!.identity;
    const result = await recordVerdicts({ gitCommonDir: dir, target: 'same-location', round: 1,
      verdicts: [{ key: dismissed, verdict: 'dismissed', reason: 'Cursor is normalized by the caller' }] });
    expect(result.resolution).toMatchObject({ status: 'unresolved', unresolved: [outstanding] });
  });

  it('does not exchange same-location identities when later report order reverses', async () => {
    const first = consensus([42, 42]).map((finding, index) => ({
      ...finding,
      title: index === 0 ? 'Empty cursor reaches the provider' : 'Frontier exceeds the storage limit',
      description: index === 0 ? 'Restore normalizes an empty page token.' : 'Folder queue grows without a bound.',
    }));
    const initial = await processRoundReport({ gitCommonDir: dir, target: 'reordered-claims', round: 1, findings: first });
    const later = consensus([42, 42], '00000000-0000-7000-8000-000000000002')
      .map((finding, index) => ({
        ...finding,
        title: first[1 - index]!.title,
        description: first[1 - index]!.description,
      }));
    const reordered = await processRoundReport({ gitCommonDir: dir, target: 'reordered-claims', round: 2, findings: later });
    expect(reordered.findings.map((finding) => finding.identity))
      .toEqual(initial.findings.map((finding) => finding.identity).reverse());
  });

  it('does not reuse a prior run alias before the new run classification arrives', async () => {
    const findings = consensus([11, 19]).map((f) => ({ ...f,
      severity: f.startLine === 19 ? 'critical' as const : 'important' as const }));
    const initial = await processRoundReport({ gitCommonDir: dir, target: 'test', round: 1, findings });
    await recordVerdicts({ gitCommonDir: dir, target: 'test', round: 1,
      verdicts: initial.findings.map((f) => ({ key: f.identity, verdict: 'dismissed' as const, reason: 'synthetic guard' })) });
    const { kept } = applyReportThresholds(consensus([12, 11], '00000000-0000-7000-8000-000000000002'), { minConsensusScore: 0.9 });
    const next = kept.map((f) => ({ ...f, severity: 'critical' as const }));
    const classified = await processRoundReport({ gitCommonDir: dir, target: 'test', round: 2, findings: next });
    expect(classified.findings[0]).toMatchObject({ status: 'regating', identity: initial.findings[0]!.identity });
    const priorCritical = initial.findings[1]!.identity;
    // Before RCL-51, first-wins telemetry emitted only the first bare anchor.
    // That old graph could not lend the sibling's critical verdict here.
    const oldKey = stableFindingKey(next[0]!);
    const oldMapping = { identity_key: oldKey, matched_identity: initial.findings[0]!.identity, status: 'new' as const };
    expect(verdictKeys(oldMapping, [oldMapping])).not.toContain(priorCritical);
    // The envelope is published before round_processed: no current-run mapping
    // exists yet, so the server can only follow the PR's prior alias graph.
    const key = next[0]!.identity!;
    expect(verdictKeys({ identity_key: key, matched_identity: key, status: 'new' }, roundIdentities(initial.findings)))
      .not.toContain(priorCritical);
  });

  it.each([
    { starts: [11, 19, 12], dismissedIndex: 0 }, { starts: [11, 19, 12], dismissedIndex: 1 },
    { starts: [12, 19, 11], dismissedIndex: 0 }, { starts: [12, 19, 11], dismissedIndex: 1 },
  ])('does not alias a gating sibling in order $starts when dismissing $dismissedIndex', async ({ starts, dismissedIndex }) => {
    const { kept } = applyReportThresholds(consensus(starts), { minConsensusScore: 0.9 });
    const findings = kept.map((f) => ({ ...f, gating: { reason: 'consensus' as const } }));
    const result = await processRoundReport({ gitCommonDir: dir, target: 'test', round: 1, findings });
    const mappings = roundIdentities(result.findings);
    const dismissed = result.findings[dismissedIndex]!;
    const unresolved = result.findings[1 - dismissedIndex]!;
    expect(verdictKeys(mappings[1 - dismissedIndex]!, mappings)).not.toContain(dismissed.identity);
    const verdict = await recordVerdicts({ gitCommonDir: dir, target: 'test', round: 1,
      verdicts: [{ key: dismissed.identity, verdict: 'dismissed', reason: 'synthetic guard' }] });
    expect(verdict.resolution).toMatchObject({ status: 'unresolved', unresolved: [unresolved.identity] });
  });

  it.each([0, 1])('does not borrow sibling %i re-triage when report keys reorder across rounds', async (dismissedIndex) => {
    const initial = await processRoundReport({ gitCommonDir: dir, target: 'test', round: 1, findings: consensus([11, 19]) });
    await recordVerdicts({ gitCommonDir: dir, target: 'test', round: 1,
      verdicts: initial.findings.map((f) => ({ key: f.identity, verdict: 'dismissed' as const, reason: 'synthetic guard' })) });
    const firstMappings = roundIdentities(initial.findings);
    const regenerated = consensus([19, 11], '00000000-0000-7000-8000-000000000002');
    const findings = regenerated.map((f) => ({ ...f, severity: 'critical' as const, gating: { reason: 'consensus' as const } }));
    const next = await processRoundReport({ gitCommonDir: dir, target: 'test', round: 2, findings });
    expect(next.findings.map((f) => f.status)).toEqual(['regating', 'regating']);
    expect(next.findings.map((f) => f.identity)).toEqual(initial.findings.map((f) => f.identity).reverse());
    const mappings = roundIdentities(next.findings);
    const verdict = await recordVerdicts({ gitCommonDir: dir, target: 'test', round: 2,
      verdicts: [{ key: next.findings[dismissedIndex]!.identity, verdict: 'dismissed', reason: 'synthetic re-triage' }] });
    expect(verdict.resolution).toMatchObject({ status: 'unresolved', unresolved: [next.findings[1 - dismissedIndex]!.identity] });
    expect(verdictKeys(mappings[1 - dismissedIndex]!, [...firstMappings, ...mappings]))
      .not.toContain(next.findings[dismissedIndex]!.identity);
  });

  it.each([{ starts: [11, 19, 12] }, { starts: [12, 19, 11] }])('keeps each sighting addressable in allocation order $starts', async ({ starts }) => {
    const { kept, dropped } = applyReportThresholds(consensus(starts), { minConsensusScore: 0.9 });
    const findings = kept.map((f) => ({ ...f, gating: { reason: f.startLine === 11 ? 'none' as const : 'consensus' as const } }));
    const result = sampleResult({ findings, belowThresholdFindings: dropped });
    const original = JSON.stringify(result);
    const envelope = buildRunEnvelope(result, { report_json: original }, { level: 'full', delivery: { mode: 'direct' } });
    expect(envelope.findings).toHaveLength(3);
    expect(new Set(envelope.findings.map((f) => f.identity_key)).size).toBe(3);
    expect(envelope.findings.map((f) => f.ref)).toEqual(['f001', 'f002', 'f003']);

    const classified = await processRoundReport({ gitCommonDir: dir, target: 'test', round: 1, runId: result.run!.id, findings });
    const mappings = roundIdentities(classified.findings);
    expect(buildEvent({ kind: 'round_processed', runId: result.run!.id, round: 1,
      payload: { identities: mappings } }).payload.identities).toEqual(mappings);
    expect(mappings.every((m) => m.identity_key.length === 60)).toBe(true);
    expect(mappings).toHaveLength(2);
    for (const [i, f] of classified.findings.entries()) {
      expect(mappings[i]).toEqual({ identity_key: envelope.findings[i]!.identity_key, matched_identity: f.identity, status: 'new' });
    }
    const observer = classified.findings.find((f) => f.finding.startLine === 19)!;
    const race = classified.findings.find((f) => f.finding.startLine === 11)!;
    expect(observer.identity).not.toBe(race.identity);
    const verdict = await recordVerdicts({ gitCommonDir: dir, target: 'test', round: 1,
      verdicts: [{ key: observer.identity, verdict: 'dismissed', reason: 'synthetic guard exists' }] });
    expect(verdict.resolution).toMatchObject({ status: 'converged-dismissal-only', unresolved: [], fixedThisRound: 0 });
    const state = await loadConvergeRunState(dir, 'test');
    expect(state!.findings[race.identity]!.verdict).toBeUndefined();
    expect(state!.findings[observer.identity]!.verdict).toBe('dismissed');
    expect(JSON.stringify(result)).toBe(original);

    const replay = await processRoundReport({ gitCommonDir: dir, target: 'test', round: 1, findings });
    expect(roundIdentities(replay.findings)).toEqual(mappings);
    const moved = [...findings].reverse().map((f) => ({ ...f, startLine: f.startLine + 1, endLine: f.endLine + 1 }));
    const movedConsensus = computeConsensus(
      '00000000-0000-7000-8000-000000000002',
      moved.map((finding) => ({ representative: finding, members: [{ finding, model: 'test-model', role: 'general' }] })),
      [sampleReview({ model: 'test-model', role: 'general', findings: moved })],
      new Map()
    );
    const next = await processRoundReport({ gitCommonDir: dir, target: 'test', round: 2, findings: movedConsensus });
    const movedObserver = next.findings.find((f) => f.finding.startLine === 20)!;
    expect(movedObserver.finding.identity).not.toBe(observer.finding.identity);
    expect(movedObserver).toMatchObject({ identity: observer.identity, status: 'suppressed' });
    expect(next.findings.find((f) => f.finding.startLine === 12)).toMatchObject({ identity: race.identity, status: 'repeat' });
    expect(roundIdentities(next.findings)).toHaveLength(2);
  });
});

// The evidence server follows aliases from a sighting's matched identity.
// Keep this independent of the allocator so a shared key cannot mask a failure.
function verdictKeys(mapping: ReturnType<typeof roundIdentities>[number], history: ReturnType<typeof roundIdentities>) {
  const graph = new Map(history.filter((m) => m.identity_key !== m.matched_identity)
    .map((m) => [m.identity_key, m.matched_identity]));
  const keys = new Set([mapping.identity_key, mapping.matched_identity]);
  let current = mapping.matched_identity;
  for (let hops = 0; hops < 16; hops++) {
    const next = graph.get(current);
    if (!next || keys.has(next)) break;
    keys.add(next);
    current = next;
  }
  return [...keys];
}
