import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeConsensus, applyReportThresholds } from '../../src/consensus/voter.js';
import { processRoundReport, recordVerdicts, loadConvergeRunState } from '../../src/converge/run-state.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { roundIdentities } from '../../src/telemetry/events.js';
import { sampleFinding, sampleResult, sampleReview } from '../telemetry/fixtures.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'rcl-report-identity-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function consensus(starts: number[]) {
  const inputs = starts.map((startLine) => sampleFinding({
    startLine, endLine: startLine,
    severity: startLine === 12 ? 'nitpick' : 'important',
  }));
  const model = 'test-model';
  const role = 'general';
  return computeConsensus(
    inputs.map((finding) => ({ representative: finding, members: [{ finding, model, role }] })),
    [sampleReview({ model, role, findings: inputs }), sampleReview({ model: 'other-model', role })],
    new Map()
  );
}

describe('report identity through native classification and telemetry', () => {
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
    const findings = consensus([19, 11]).map((f) => ({ ...f, severity: 'critical' as const, gating: { reason: 'consensus' as const } }));
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

    const classified = await processRoundReport({ gitCommonDir: dir, target: 'test', round: 1, findings });
    const mappings = roundIdentities(classified.findings);
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
