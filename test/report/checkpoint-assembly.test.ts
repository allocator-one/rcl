import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Finding, ModelReview } from '../../src/consensus/types.js';
import type { Config } from '../../src/config/schema.js';
import type { Diff } from '../../src/resolver/types.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, exportCheckpointProof, freezeCheckpointPlan,
  type CheckpointProof, type CheckpointResult } from '../../src/dispatch/checkpoint.js';
import { captureReviewerInputs } from '../../src/dispatch/captured-inputs.js';
import { captureAggregationInputs } from '../../src/report/aggregation-inputs.js';
import { assembleCheckpointReview, deriveCheckpointConsensus } from '../../src/report/checkpoint-assembly.js';
import { projectCheckpointReport } from '../../src/report/checkpoint-projection.js';
import { captureSupplementalAsync } from '../../src/report/supplemental-async.js';
import { configDigest, diffDigest, sha256Hex, stableStringify } from '../../src/report/run-header.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const role = { name: 'general', systemPrompt: 'Review.', focus: [], description: 'General', isSpecialized: false };
const runId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const policy = { version: 1 as const, fraction: 2 / 3 };
const thresholds = { minConsensusScore: 0, minConfidence: 0, dedupeLineWindow: 5, jaccardThreshold: 0.3 };
const emptyAsync = () => captureSupplementalAsync([], 0);
function finding(id: string, file = 'tenant.ts'): Finding {
  return { id, file, startLine: 1, endLine: 1, severity: 'critical', category: 'security',
    title: 'Missing tenant isolation', description: 'An unrelated tenant can read this record.' };
}
function fixture(options: { models?: string[]; chunks?: number; appendix?: boolean; minConfidence?: number;
  aggregation?: boolean; verified?: boolean; missingThresholds?: boolean } = {}) {
  const models = options.models ?? ['model-a', 'model-b', 'model-c'];
  const chunks = options.chunks ?? 2;
  const diff: Diff = { source: 'local', files: [{ filename: 'tenant.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new\n', additions: 1, deletions: 1, language: 'typescript' }] };
  const patchBytes = stableStringify(diff.files.map(file => ({ filename: file.filename, status: file.status,
    previousFilename: null, patch: file.patch, additions: file.additions, deletions: file.deletions, blobSha: null })));
  const resolvedThresholds = { ...thresholds, minConfidence: options.minConfidence ?? 0 };
  const config: Config = { quorumFraction: policy.fraction, thresholds: resolvedThresholds,
    output: { belowThresholdAppendix: options.appendix ?? true } };
  if (options.missingThresholds) delete config.thresholds;
  const configBytes = stableStringify(config), specBytes = 'Exact spec', contextBytes = '[]';
  const toolsBytes = stableStringify({ parser: { name: 'findings-json', version: 1 }, aggregation: { name: 'consensus', version: 2 } });
  const chunkBytes = Array.from({ length: chunks }, (_, chunk) => `chunk ${chunk}`);
  const plan = freezeCheckpointPlan({ target: 'rcl-105', headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40),
    patchSha256: diffDigest(diff.files), configSha256: configDigest(config), specSha256: sha256Hex(specBytes),
    contextSha256: sha256Hex(contextBytes), toolsSha256: sha256Hex(toolsBytes), parser: { name: 'findings-json', version: 1 },
    roster: models.map((model, index) => ({ seat: `s${index}`, model, role: role.name, route: 'fake' })),
    chunks: chunkBytes.map((bytes, index) => ({ index, total: chunks, digest: sha256Hex(bytes) })),
    prompts: chunkBytes.flatMap((_, chunk) => models.map((_, seat) => ({ seat: `s${seat}`, chunk,
      systemSha256: sha256Hex('system'), userSha256: sha256Hex(`prompt ${chunk}`) }))),
  });
  const aggregation = captureAggregationInputs({ algorithm: { name: 'consensus', version: 2 }, diffSha256: plan.patchSha256,
    roleMap: new Map([[role.name, role]]), thresholds: resolvedThresholds,
    gating: { mode: options.verified ? 'verified-consensus' : 'all-findings', minModels: 2,
      verificationModel: options.verified ? 'google/gemini-3.8-flash' : undefined,
      verificationTimeoutMs: 100, verificationPassTimeoutMs: 100 },
    modelWeights: new Map([[models[0]!, 0.75]]), belowThresholdAppendix: options.appendix ?? true });
  const capture = captureReviewerInputs({ plan, policy, patchBytes, configBytes, specBytes, contextBytes, toolsBytes,
    chunkBytes, assignments: plan.cells.map(cell => ({ model: cell.model, provider: cell.route, role })),
    prompts: plan.cells.map(cell => ({ systemPrompt: 'system', userPrompt: `prompt ${cell.chunk}` })),
    ...(options.aggregation === false ? {} : { aggregation }) });
  expect(sha256Hex(patchBytes)).toBe(plan.patchSha256);
  return { plan, capture, diff, config };
}
type Fixture = ReturnType<typeof fixture>;
interface Row { cell: string; id: string; findings?: Finding[]; status?: ModelReview['status']; uncertain?: boolean }
async function proof(f: Fixture, rows: Row[], captureBytes: string | undefined = f.capture.bytes): Promise<CheckpointProof> {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-checkpoint-assembly-'))); roots.push(commonDir);
  return withNativeTarget(commonDir, f.plan.target, async ownership => {
    const journal = await CheckpointJournal.create({ commonDir, namespace: 'assembly', plan: f.plan, ownership });
    if (captureBytes !== undefined) await journal.bind('captured-inputs', captureBytes, ownership);
    for (const row of rows) {
      const cell = f.plan.cells.find(item => item.id === row.cell)!;
      const paidAttempt = { id: row.id, kind: row.uncertain ? 'unknown' as const : 'paid' as const };
      await journal.recordIntent(cell.id, paidAttempt, ownership);
      if (!row.uncertain) {
        const status = row.status ?? 'success';
        const review: ModelReview = { model: cell.model, role: cell.role, provider: cell.route, durationMs: 1,
          findings: row.findings ?? [], status, ...(status === 'success' ? {} : { error: 'Temporary failure' }),
          usage: { inputTokens: 10, outputTokens: 3 } };
        const reviewBytes = JSON.stringify(review, null, 2);
        const result: CheckpointResult = status === 'success' ? { kind: 'success', chunk: cell.chunk, reviewBytes }
          : { kind: 'failure', chunk: cell.chunk, reviewBytes, possiblyBilled: true };
        await journal.recordResult(cell.id, paidAttempt, result, ownership);
      }
    }
    await journal.finalize(ownership);
    return exportCheckpointProof(journal);
  });
}
const rowsFor = (f: Fixture, seats: string[], prefix: string): Row[] => f.plan.cells.filter(cell => seats.includes(cell.seat))
  .map(cell => ({ cell: cell.id, id: `${prefix}-${cell.id}` }));
function input(f: Fixture, source: CheckpointProof, successor: CheckpointProof) {
  const projection = projectCheckpointReport({ sources: [{ runId: runId(1), proof: source }], successor: { runId: runId(2), proof: successor }, policy });
  return { projection, supplementalAsync: emptyAsync(), diff: f.diff, startTime: Date.now(),
    run: { id: runId(2), rclVersion: '4.1.3', command: 'review' as const,
      target: { kind: 'patch' as const, repo: 'allocator-one/rcl', prNumber: 105, headSha: f.plan.headSha },
      roster: f.plan.roster.map(seat => ({ model: seat.model, role: seat.role, provider: seat.route, lane: 'blocking' as const })),
      spec: { source: 'flag' as const, sha256: f.plan.specSha256 }, contextFiles: [], runner: { kind: 'agent' as const },
      startedAt: new Date(), converge: { target: f.plan.target, round: 2, attempt: 2 } } };
}
function asyncReview(model: string, item: Finding, status: ModelReview['status'] = 'success'): string {
  return JSON.stringify({ model, role: 'general', provider: 'fake', status, async: true, durationMs: 1,
    findings: [item], ...(status === 'success' ? {} : { error: 'Async failure' }) } satisfies ModelReview);
}

describe('proof-bound checkpoint assembly', () => {
  it('refuses a missing retained verifier phase before any live verifier call', async () => {
    const f = fixture({ chunks: 1, verified: true }), rows = rowsFor(f, ['s0', 's1'], 'complete');
    rows[0]!.findings = [{ ...finding('candidate'), severity: 'important' }];
    const args = input(f, await proof(f, rows), await proof(f, []));
    const ask = vi.fn(async () => ({ model: 'google/gemini-3.8-flash', provider: 'google',
      status: 'success' as const, text: '[{"id":"F1","verdict":"confirmed"}]', durationMs: 1 }));
    await expect(assembleCheckpointReview(args, { ask })).rejects.toThrow('checkpoint_gating_missing_phase');
    expect(ask).not.toHaveBeenCalled();
  });

  it('uses the captured deterministic ordering for both offline and completed reports', async () => {
    const f = fixture({ chunks: 1 }), rows = rowsFor(f, ['s0', 's1'], 'ordered');
    rows[0]!.findings = ['a.ts', 'ä.ts', 'z.ts'].map((file, index) => finding(`f${index}`, file));
    const args = input(f, await proof(f, rows), await proof(f, []));
    const locale = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => { throw new Error('ambient collation forbidden'); });
    try {
      const derived = deriveCheckpointConsensus(args), assembled = await assembleCheckpointReview(args);
      expect(derived.consensus.reportFindings.map(item => item.file)).toEqual(['a.ts', 'z.ts', 'ä.ts']);
      expect(assembled.report.findings).toEqual(derived.consensus.reportFindings);
      expect(assembled.contributions).toEqual(derived.contributions);
    } finally { locale.mockRestore(); }
  });

  it('rebuilds the same findings and raw contribution map without clocks or verification', async () => {
    const f = fixture({ chunks: 1 });
    const source = await proof(f, [
      { cell: 's0:0', id: 'old-success', findings: [finding('same-id')] },
      { cell: 's1:0', id: 'old-failed', status: 'error', findings: [finding('failed', 'failed.ts')] },
    ]);
    const args = input(f, source, await proof(f, [{ cell: 's1:0', id: 'new-success', findings: [finding('same-id')] }]));
    args.supplementalAsync = captureSupplementalAsync([asyncReview('bonus', finding('bonus', 'bonus.ts'))], 0);
    const assembled = await assembleCheckpointReview(args);
    const before = stableStringify(args), clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock forbidden'); });
    try {
      const derived = deriveCheckpointConsensus(args);
      expect(derived.consensus.reviews).toEqual(assembled.report.reviews);
      expect(derived.consensus.reportFindings).toEqual(assembled.report.findings);
      expect(derived.contributions).toEqual(assembled.contributions);
      expect(derived.observations).toEqual(assembled.observations);
      expect(derived.projection.health).toBe(args.projection.health);
      expect(stableStringify(args)).toBe(before);
    } finally { clock.mockRestore(); }
    // A verified-consensus capture can also be derived offline; no verifier
    // dependency exists on this synchronous boundary.
    const verified = fixture({ chunks: 1, verified: true });
    const rows = rowsFor(verified, ['s0', 's1'], 'complete'); rows[0]!.findings = [finding('retained')];
    const verifiedArgs = input(verified, await proof(verified, rows), await proof(verified, []));
    expect(deriveCheckpointConsensus(verifiedArgs).consensus.reportFindings).toHaveLength(1);
  });

  it('derives retained critical findings and health from the same projection despite unrelated extra inputs', async () => {
    const f = fixture(), rows = rowsFor(f, ['s0', 's1'], 'source');
    rows[0]!.findings = [finding('retained')];
    const source = await proof(f, rows), successor = await proof(f, []), original = source.bytes;
    const args = input(f, source, successor);
    const unrelatedOverrides = { ...args, chunkReviews: [], reviewerHealth: { conclusive: true } };
    const result = await assembleCheckpointReview(unrelatedOverrides);
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.findings[0]!.severity).toBe('critical');
    expect(result.report.run.ci_exit_code).toBe(1);
    expect(result.report.run.config_sha256).toBe(f.plan.configSha256);
    expect(result.projection).toBe(args.projection);
    expect(result.projection.newPhysicalAttempts).toEqual([]);
    expect(result.contributions[0]!.origins).toEqual([expect.objectContaining({ kind: 'checkpoint', runId: runId(1),
      proofDigest: source.digest, cell: 's0:0', seat: 's0', attemptId: 'source-s0:0', findingIndex: 0 })]);
    expect(source.bytes).toBe(original);
  });

  it('keeps complete duplicate seats voting once and preserves incomplete observations and async precedence', async () => {
    const f = fixture({ models: ['same', 'same', 'only-incomplete', 'different'] });
    const source = await proof(f, [...rowsFor(f, ['s0', 's3'], 'complete'),
      { cell: 's1:0', id: 'partial-duplicate', findings: [finding('partial-duplicate', 'duplicate.ts')] },
      { cell: 's2:0', id: 'partial-only', findings: [finding('partial-only', 'incomplete.ts')] }]);
    const args = input(f, source, await proof(f, []));
    args.supplementalAsync = captureSupplementalAsync([
      asyncReview('only-incomplete', finding('must-not-rescue', 'rescue.ts')),
      asyncReview('same', finding('shadowed', 'shadowed.ts')),
      asyncReview('independent-async', finding('opportunistic', 'async.ts')),
      asyncReview('failed-async', finding('failed-observation', 'failure.ts'), 'error'),
    ], 0);
    const result = await assembleCheckpointReview(args);
    expect(result.projection.health.successfulSeats).toEqual(['s0', 's3']);
    expect(result.projection.health.conclusive).toBe(false);
    expect(result.report.reviews.filter(review => review.model === 'same')).toHaveLength(1);
    expect(result.report.reviews.find(review => review.model === 'same')!.status).toBe('success');
    expect(result.report.reviews.find(review => review.model === 'only-incomplete')!.status).not.toBe('success');
    expect(result.report.findings.map(item => item.file)).toEqual(['async.ts']);
    expect(result.observations.map(item => item.reason).sort()).toEqual([
      'async_shadowed_by_blocking', 'async_shadowed_by_blocking', 'incomplete_seat', 'incomplete_seat', 'unsuccessful_async',
    ].sort());
    expect(result.contributions[0]!.origins).toEqual([{ kind: 'async', snapshotSha256: args.supplementalAsync.digest, reviewIndex: 2, findingIndex: 0 }]);
  });

  it('maps identical raw finding IDs by cell positions through out-of-order completion and dedupe', async () => {
    const f = fixture();
    const source = await proof(f, [
      { cell: 's1:1', id: 'late-cell-first', findings: [finding('same-id')] },
      { cell: 's0:1', id: 'second', findings: [finding('same-id'), finding('same-id')] },
      { cell: 's1:0', id: 'third', findings: [finding('same-id')] },
    ]);
    const successor = await proof(f, [{ cell: 's0:0', id: 'new', findings: [finding('same-id')] }]);
    const result = await assembleCheckpointReview(input(f, source, successor));
    expect(result.report.findings).toHaveLength(1);
    const origins = result.contributions[0]!.origins;
    expect(origins).toHaveLength(5);
    expect(origins.map(origin => origin.kind === 'checkpoint' ? `${origin.attemptId}:${origin.findingIndex}` : 'async').sort())
      .toEqual(['late-cell-first:0', 'new:0', 'second:0', 'second:1', 'third:0']);
    expect(result.projection.newPhysicalAttempts.map(attempt => attempt.attemptId)).toEqual(['new']);
    expect(result.observations).toEqual([]);
  });

  it('retains below-threshold contribution mapping when the report appendix is disabled', async () => {
    const f = fixture({ appendix: false, minConfidence: 1 });
    const rows = rowsFor(f, ['s0', 's1', 's2'], 'complete'); rows[0]!.findings = [{ ...finding('minority'), severity: 'minor' }];
    const result = await assembleCheckpointReview(input(f, await proof(f, rows), await proof(f, [])));
    expect(result.report.findings).toEqual([]);
    expect(result.report.belowThresholdFindings).toBeUndefined();
    expect(result.contributions).toEqual([expect.objectContaining({ disposition: 'below_threshold',
      origins: [expect.objectContaining({ attemptId: 'complete-s0:0', findingIndex: 0 })] })]);
    expect(result.observations).toEqual([]);
  });

  it('preserves failed observations and exposes only successor attempts including uncertain cost', async () => {
    const f = fixture({ chunks: 1 });
    const source = await proof(f, [
      { cell: 's0:0', id: 'old-failed', status: 'timeout', findings: [finding('failed')] },
      { cell: 's1:0', id: 'old-success' },
    ]);
    const successor = await proof(f, [{ cell: 's0:0', id: 'new-success', findings: [finding('current')] },
      { cell: 's2:0', id: 'new-uncertain', uncertain: true }]);
    const result = await assembleCheckpointReview(input(f, source, successor));
    expect(result.observations).toEqual([expect.objectContaining({ reason: 'unsuccessful_attempt',
      origin: expect.objectContaining({ attemptId: 'old-failed' }), finding: finding('failed') })]);
    expect(result.projection.newPhysicalAttempts.map(attempt => attempt.attemptId)).toEqual(['new-success', 'new-uncertain']);
    expect(result.projection.newPhysicalAttempts[1]).toMatchObject({ certainty: 'uncertain', possiblyBilled: true });
    expect(result.projection.newPhysicalAttempts[1]!.review).toBeUndefined();
    expect(result.projection.proofs[0]!.proof).toBe(source);
  });

  it('refuses cloned projection or async evidence before any verifier call', async () => {
    const f = fixture({ verified: true });
    const args = input(f, await proof(f, rowsFor(f, ['s0', 's1'], 'source')), await proof(f, []));
    const ask = vi.fn();
    await expect(assembleCheckpointReview({ ...args, projection: structuredClone(args.projection) }, { ask }))
      .rejects.toThrow('checkpoint_assembly_unvalidated_projection');
    await expect(assembleCheckpointReview({ ...args, supplementalAsync: structuredClone(args.supplementalAsync) }, { ask }))
      .rejects.toThrow('checkpoint_assembly_unvalidated_async');
    expect(ask).not.toHaveBeenCalled();
  });

  it('refuses changed run, patch, roster, spec, context and captured policy before verification', async () => {
    const f = fixture({ verified: true });
    const source = await proof(f, rowsFor(f, ['s0', 's1'], 'source')), successor = await proof(f, []);
    const args = input(f, source, successor), ask = vi.fn();
    const changes = [
      { ...args, run: { ...args.run, id: runId(3) } },
      { ...args, diff: { ...args.diff, files: [{ ...args.diff.files[0]!, patch: 'changed' }] } },
      { ...args, run: { ...args.run, target: { ...args.run.target, headSha: 'f'.repeat(40) } } },
      { ...args, run: { ...args.run, roster: args.run.roster.slice(1) } },
      { ...args, run: { ...args.run, spec: { ...args.run.spec, sha256: 'f'.repeat(64) } } },
      { ...args, run: { ...args.run, contextFiles: [{ path: 'unexpected', sha256: 'f'.repeat(64) }] } },
      { ...args, projection: projectCheckpointReport({ sources: [{ runId: runId(1), proof: source }],
        successor: { runId: runId(2), proof: successor }, policy: { version: 1, fraction: 1 } }) },
    ];
    for (const changed of changes) await expect(assembleCheckpointReview(changed, { ask })).rejects.toThrow();
    expect(ask).not.toHaveBeenCalled();
  });

  it('requires identical valid capture bytes, present aggregation and explicit matching static config', async () => {
    const ask = vi.fn();
    for (const options of [{ aggregation: false }, { missingThresholds: true }]) {
      const f = fixture(options);
      await expect(assembleCheckpointReview(input(f, await proof(f, rowsFor(f, ['s0', 's1'], 'source')), await proof(f, [])), { ask }))
        .rejects.toThrow();
    }
    const f = fixture(), source = await proof(f, rowsFor(f, ['s0', 's1'], 'source'));
    const malformed = await proof(f, [], '{}');
    await expect(assembleCheckpointReview(input(f, source, malformed), { ask })).rejects.toThrow();
    const malformedSource = await proof(f, rowsFor(f, ['s0', 's1'], 'invalid-capture'), '{}');
    await expect(assembleCheckpointReview(input(f, malformedSource, malformed), { ask })).rejects.toThrow();
    const changed = JSON.parse(f.capture.bytes) as { blobs: Record<string, string> };
    changed.blobs['f'.repeat(64)] = 'unreferenced';
    const foreignCapture = await proof(f, [], stableStringify(changed));
    await expect(assembleCheckpointReview(input(f, source, foreignCapture), { ask })).rejects.toThrow();
    expect(ask).not.toHaveBeenCalled();
  });
});
