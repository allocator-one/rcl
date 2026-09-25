import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleCompletedReview } from '../../src/report/assembly.js';
import { deriveConsensusAssembly } from '../../src/report/consensus-assembly.js';
import type { Finding, ModelReview } from '../../src/consensus/types.js';
import type { Config } from '../../src/config/schema.js';

afterEach(() => vi.restoreAllMocks());
const runId = '019921a0-0000-7000-8000-000000000105';
const role = { name: 'general', systemPrompt: '', description: '', focus: [], isSpecialized: false };
const finding = (id: string, file: string, severity: Finding['severity'] = 'minor'): Finding => ({
  id, file, startLine: 1, endLine: 1, severity, category: 'correctness', title: `Missing guard in ${file}`,
  description: 'Execution bypasses the required guard.',
});
const review = (model: string, findings: Finding[] = [], extras: Partial<ModelReview> = {}): ModelReview => ({
  model, role: role.name, provider: 'fake', status: 'success', durationMs: 1, findings, ...extras,
});
function fixture(thresholds?: Config['thresholds']) {
  return { runId, chunkReviews: [
    review('model-a', [finding('critical', 'b.ts', 'critical'), finding('minor', 'a.ts')]),
    review('model-a', [finding('repeated', 'b.ts', 'critical')]),
    review('model-b', [finding('corroboration', 'b.ts', 'critical')]),
    review('model-c'),
  ], arrivedAsync: [] as ModelReview[], roleMap: new Map([[role.name, role]]), thresholds };
}
async function completed(input: ReturnType<typeof fixture>, collect = true) {
  const contributions = vi.fn();
  const report = await assembleCompletedReview({
    chunkReviews: input.chunkReviews, arrivedAsync: input.arrivedAsync, asyncLaunched: input.arrivedAsync.length,
    startTime: 0, roleMap: input.roleMap, config: { thresholds: input.thresholds }, diff: { source: 'local', files: [] },
    gatingConfig: { mode: 'all-findings', minModels: 2, verificationModel: undefined,
      verificationTimeoutMs: 100, verificationPassTimeoutMs: 100 },
    run: { id: input.runId, rclVersion: '4.1.3', command: 'review', target: { kind: 'patch' }, roster: [],
      runner: { kind: 'agent' }, startedAt: new Date(0) },
  }, collect ? { onFindingContributions: contributions } : {});
  return { report, contributions: contributions.mock.calls[0]?.[0] };
}

describe('deterministic consensus assembly', () => {
  it('keeps the existing complete-assembly baseline: blocking findings survive filtering and raw references survive collapse', async () => {
    const input = fixture({ minConfidence: 1, minConsensusScore: 1 });
    const { report, contributions } = await completed(input);
    expect(report.reviews.map(row => row.model)).toEqual(['model-a', 'model-b', 'model-c']);
    expect(report.findings.map(row => [row.file, row.severity])).toEqual([['b.ts', 'critical']]);
    expect(report.belowThresholdFindings!.map(row => row.file)).toEqual(['a.ts']);
    expect(contributions).toEqual([
      { reportIdentity: report.findings[0]!.identity, disposition: 'kept', contributions: [
        { reviewIndex: 0, findingIndex: 0 }, { reviewIndex: 0, findingIndex: 2 }, { reviewIndex: 1, findingIndex: 0 },
      ] },
      { reportIdentity: report.belowThresholdFindings![0]!.identity, disposition: 'below_threshold',
        contributions: [{ reviewIndex: 0, findingIndex: 1 }] },
    ]);
  });

  it('returns exactly the legacy ordered opinions, identities, thresholds and contribution map', async () => {
    const input = fixture({ minConfidence: 1, minConsensusScore: 1 });
    const original = structuredClone(input);
    const legacy = await completed(input);
    const pure = deriveConsensusAssembly({ ...input, collectContributions: true });
    expect(pure.reviews).toEqual(legacy.report.reviews);
    expect(pure.reportFindings).toEqual(legacy.report.findings);
    expect(pure.droppedFindings).toEqual(legacy.report.belowThresholdFindings);
    expect(pure.contributions).toEqual(legacy.contributions);
    expect(pure.consensusFindings.map(row => row.file)).toEqual(['b.ts', 'a.ts']);
    expect(pure.consensusFindings.every(row => row.identity!.startsWith(`report:${runId}:`))).toBe(true);
    expect(input).toEqual(original);
  });

  it('keeps omitted report filters at zero and distinguishes them from configured defaults', () => {
    const omitted = deriveConsensusAssembly(fixture());
    expect(omitted.reportFindings.map(row => row.file)).toEqual(['b.ts', 'a.ts']);
    expect(omitted.droppedFindings).toEqual([]);
    const filtered = deriveConsensusAssembly(fixture({ minConfidence: 0.2, minConsensusScore: 0.4 }));
    expect(filtered.reportFindings.map(row => row.file)).toEqual(['b.ts']);
    expect(filtered.droppedFindings.map(row => row.file)).toEqual(['a.ts']);
    expect(omitted.contributions).toBeUndefined();
  });

  it('preserves incomplete blocking coverage and opportunistic async precedence', () => {
    const input = fixture();
    input.chunkReviews = [review('incomplete', [finding('partial', 'partial.ts')]),
      review('incomplete', [], { status: 'timeout', error: 'timed out' }), review('complete', [finding('kept', 'complete.ts')])];
    input.arrivedAsync = [review('incomplete', [finding('rescue', 'rescue.ts')], { async: true }),
      review('complete', [], { status: 'error', error: 'async failed', async: true }),
      review('bonus', [finding('bonus', 'bonus.ts')], { async: true }),
      review('bonus', [], { status: 'timeout', async: true })];
    const pure = deriveConsensusAssembly({ ...input, collectContributions: true });
    expect(pure.reviews.map(row => [row.model, row.status])).toEqual([
      ['incomplete', 'timeout'], ['complete', 'success'], ['bonus', 'success'],
    ]);
    expect(pure.reportFindings.map(row => row.file)).toEqual(['bonus.ts', 'complete.ts']);
    expect(pure.contributions!.flatMap(group => group.contributions)).toEqual([
      { reviewIndex: 2, findingIndex: 0 }, { reviewIndex: 1, findingIndex: 0 },
    ]);
  });

  it('does not invoke clocks, random IDs or providers and produces stable output for the caller run ID', () => {
    const input = fixture();
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock must remain outside pure assembly'); });
    vi.spyOn(performance, 'now').mockImplementation(() => { throw new Error('no monotonic clock'); });
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('no random identity'); });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('no provider'); });
    const first = deriveConsensusAssembly(input);
    expect(deriveConsensusAssembly(input)).toEqual(first);
    const second = deriveConsensusAssembly({ ...input, runId: '019921a0-0000-7000-8000-000000000106' });
    expect(second.consensusFindings.map(row => row.identity)).not.toEqual(first.consensusFindings.map(row => row.identity));
    expect(second.consensusFindings.map(({ identity: _identity, ...row }) => row))
      .toEqual(first.consensusFindings.map(({ identity: _identity, ...row }) => row));
  });

  it('keeps contribution collection optional without changing findings or weighting semantics', () => {
    const input = fixture();
    const ordinary = deriveConsensusAssembly(input), collected = deriveConsensusAssembly({ ...input, collectContributions: true });
    expect(ordinary.contributions).toBeUndefined();
    expect(collected.reportFindings).toEqual(ordinary.reportFindings);
    const weighted = deriveConsensusAssembly({ ...input, modelWeights: new Map([['model-a', 0.5], ['model-b', 1.5]]) });
    expect(weighted.reportFindings[0]!.consensus.modelWeights).toEqual({ 'model-a': 0.5, 'model-b': 1.5 });
    expect(ordinary.reportFindings[0]!.consensus.modelWeights).toBeUndefined();
    expect(deriveConsensusAssembly({ ...input, chunkReviews: [], arrivedAsync: [], collectContributions: true }))
      .toEqual({ reviews: [], consensusFindings: [], reportFindings: [], droppedFindings: [], contributions: [] });
  });
});
