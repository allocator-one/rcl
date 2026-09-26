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
import { planGating } from '../../src/consensus/gating.js';
import { projectCheckpointReport } from '../../src/report/checkpoint-projection.js';
import { captureSupplementalAsync } from '../../src/report/supplemental-async.js';
import { configDigest, diffDigest, sha256Hex, stableStringify } from '../../src/report/run-header.js';

import { buildRunEnvelope, declareReviewerRecovery, sanitizeForDelivery } from '../../src/telemetry/envelope.js';
import { MAX_ARTIFACT_BYTES, validateRunEnvelope } from '../../src/telemetry/envelope-validation.js';
import { createOriginalLaunch, encodeOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { createRecoveryOperation, encodeRecoveryOperation } from '../../src/dispatch/recovery-operation.js';
import { describeReviewerEvidence, reviewerEvidenceDescriptorSchema as compatibilityDescriptorSchema } from '../../src/report/reviewer-evidence.js';
import { reviewerEvidenceDescriptorSchema as leafDescriptorSchema } from '../../src/report/reviewer-evidence-schema.js';
import { serializeReviewerArtifact, validateReviewerArtifact, inspectReviewerArtifact, isReviewerArtifact } from '../../src/report/reviewer-artifact.js';

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
interface Row { cell: string; id: string; findings?: Finding[]; status?: ModelReview['status']; uncertain?: boolean; error?: string }
async function proof(f: Fixture, rows: Row[], captureBytes: string | undefined = f.capture.bytes, bindings: Array<['launch' | 'source' | 'operation', string]> = []): Promise<CheckpointProof> {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-checkpoint-assembly-'))); roots.push(commonDir);
  return withNativeTarget(commonDir, f.plan.target, async ownership => {
    const journal = await CheckpointJournal.create({ commonDir, namespace: 'assembly', plan: f.plan, ownership });
    if (captureBytes !== undefined) await journal.bind('captured-inputs', captureBytes, ownership);
    for (const [name, bytes] of bindings) await journal.bind(name, bytes, ownership);
    for (const row of rows) {
      const cell = f.plan.cells.find(item => item.id === row.cell)!;
      const paidAttempt = { id: row.id, kind: row.uncertain ? 'unknown' as const : 'paid' as const };
      await journal.recordIntent(cell.id, paidAttempt, ownership);
      if (!row.uncertain) {
        const status = row.status ?? 'success';
        const review: ModelReview = { model: cell.model, role: cell.role, provider: cell.route, durationMs: 1,
          findings: row.findings ?? [], status, ...(status === 'success' ? {} : { error: row.error ?? 'Temporary failure' }),
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
  return baseInput(f, projection);
}
function baseInput(f: Fixture, projection: ReturnType<typeof projectCheckpointReport>) {
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


async function sealedVerificationArtifact(failed = false, activeRunId = runId(2)) {
  const f = fixture({ chunks: 1, verified: true }), commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-artifact-verification-'))); roots.push(commonDir);
  const launch = createOriginalLaunch({ runId: activeRunId, target: f.plan.target, originalNativeClaim: { attempt: 2, round: 2 }, capturedInputsSha256: f.capture.digest, planDigest: f.plan.digest, startedAtMs: 1, expiresAtMs: 1_000, maxPhysicalCalls: 3, maxAttemptsPerCell: 1 });
  let journal!: CheckpointJournal, checkpoint!: CheckpointProof;
  await withNativeTarget(commonDir, f.plan.target, async ownership => { journal = await CheckpointJournal.create({ commonDir, namespace: activeRunId, plan: f.plan, ownership }); await journal.bind('captured-inputs', f.capture.bytes, ownership); await journal.bind('launch', encodeOriginalLaunch(launch), ownership);
    for (const cell of f.plan.cells.filter(cell => ['s0', 's1'].includes(cell.seat))) { const attempt = { id: `review-${cell.id}`, kind: 'paid' as const }, review: ModelReview = { model: cell.model, role: cell.role, provider: cell.route, durationMs: 1, findings: cell.seat === 's0' ? [{ ...finding('important'), severity: 'important' }] : [], status: 'success' }; await journal.recordIntent(cell.id, attempt, ownership); await journal.recordResult(cell.id, attempt, { kind: 'success', chunk: cell.chunk, reviewBytes: JSON.stringify(review) }, ownership); } await journal.finalize(ownership); checkpoint = await exportCheckpointProof(journal); });
  const base = baseInput(f, projectCheckpointReport({ sources: [], successor: { runId: activeRunId, proof: checkpoint }, policy }));
  const args = { ...base, run: { ...base.run, id: activeRunId, converge: { target: f.plan.target, round: 2, attempt: 2 } } };
  const consensus = deriveCheckpointConsensus(args).consensus, aggregation = f.capture.aggregation!;
  const plan = planGating(consensus.reportFindings, { minModels: aggregation.gating.minModels, verificationModel: aggregation.gating.verificationModel!, verificationTimeoutMs: aggregation.gating.verificationTimeoutMs, verificationPassTimeoutMs: aggregation.gating.verificationPassTimeoutMs, diffFiles: args.diff.files, modelWeights: new Map(aggregation.modelWeights!.map(row => [row.model, row.weight])) });
  await withNativeTarget(commonDir, f.plan.target, async ownership => { const saved = { runId: activeRunId, gatingPlanBytes: stableStringify(plan), model: plan.model, provider: 'google', batches: plan.batches.map(({ systemPrompt, userPrompt }) => ({ systemPrompt, userPrompt })), startedAtMs: 2, expiresAtMs: 102, verificationTimeoutMs: 100, verificationPassTimeoutMs: 100, maxPhysicalCalls: plan.batches.length }; await journal.beginVerification(saved, ownership); if (!failed) for (const [batchIndex] of plan.batches.entries()) { await journal.recordVerificationIntent({ batchIndex, attemptId: `verify-${batchIndex}`, startedAtMs: 3 }, ownership); await journal.recordVerificationResult({ batchIndex, attemptId: `verify-${batchIndex}`, finishedAtMs: 4, answerBytes: JSON.stringify({ model: plan.model, provider: 'google', status: 'success', durationMs: 1, text: '[{"id":"F1","verdict":"refuted"}]' }) }, ownership); } await journal.finalizeVerification(failed ? { status: 'failed', finishedAtMs: 5, reason: 'deadline' } : { status: 'complete', finishedAtMs: 5 }, ownership); });
  const verificationProof = await journal.exportVerificationProof(), assembled = await assembleCheckpointReview(args, { verificationProof });
  const reportBytes = JSON.stringify(sanitizeForDelivery(assembled.report, representation));
  const artifact = serializeReviewerArtifact({ assembly: args, representation, reportBytes, verificationProof });
  return { f, args, verificationProof, artifact, reportBytes };
}


const representation = { version: 1 as const, parseFailures: false };
async function complete(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture({ chunks: 1, ...options });
  const rows = rowsFor(f, ['s0', 's1'], 'source');
  rows[0]!.findings = [finding('retained')];
  const args = input(f, await proof(f, rows), await proof(f, []));
  const assembled = await assembleCheckpointReview(args);
  const reportBytes = JSON.stringify(sanitizeForDelivery(assembled.report, representation));
  return { f, args, assembled, reportBytes };
}
function rewrite(bytes: string, mutate: (wire: any) => void): string {
  const wire = JSON.parse(bytes); mutate(wire); return stableStringify(wire);
}

describe('private reviewer artifact', () => {
  it('binds exact private proofs to ordinary sanitized bytes with deterministic conservation and health', async () => {
    const { args, assembled, reportBytes } = await complete();
    const before = stableStringify(args);
    const artifact = serializeReviewerArtifact({ assembly: args, reportBytes, representation });
    const wire = JSON.parse(artifact.bytes);
    expect(wire.version).toBe(1);
    expect(wire.kind).toBe('private-reviewer-evidence');
    expect(wire.report).toEqual({ bytes: reportBytes, sha256: sha256Hex(reportBytes) });
    expect(wire.checkpoints.map((item: any) => item.bytes)).toEqual(args.projection.proofs.map(item => item.proof.bytes));
    expect(wire.supplementalAsync).toEqual({ bytes: args.supplementalAsync.bytes, sha256: args.supplementalAsync.digest });
    expect(artifact.contributions).toEqual(assembled.contributions);
    expect(artifact.observations).toEqual(assembled.observations);
    expect(artifact.health).toBe(args.projection.health);
    expect(artifact.newPhysicalAttempts).toEqual([]);
    expect(artifact.validation).toMatchObject({ body: 'deterministic', health: 'derived', gate: {
      validation: 'deterministic', conservativeCiExitCode: 1, reportedCiExitCode: 1 } });
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('offline clock access'); });
    try { expect(validateReviewerArtifact(artifact.bytes, { assembly: args, representation }).digest).toBe(artifact.digest); }
    finally { clock.mockRestore(); }
    expect(isReviewerArtifact(artifact)).toBe(true);
    expect(isReviewerArtifact(structuredClone(artifact))).toBe(false);
    expect(Object.isFrozen(artifact.contributions)).toBe(true);
    expect(stableStringify(args)).toBe(before);
    expect(JSON.parse(reportBytes)).not.toHaveProperty('reviewerEvidence');
  });

  it('refuses dropped/altered delivered findings, reviews, identities, header and derivable stats', async () => {
    const { args, reportBytes } = await complete();
    const mutations = [
      (r: any) => { r.findings = []; },
      (r: any) => { r.findings[0].identity = 'borrowed'; },
      (r: any) => { r.findings[0].description = 'Different claim'; },
      (r: any) => { r.reviews[0].findings = []; },
      (r: any) => { r.reviews[0].status = 'error'; },
      (r: any) => { r.run.target.head_sha = 'f'.repeat(40); },
      (r: any) => { r.run.ci_exit_code = 0; },
      ...['totalReviews', 'successfulReviews', 'totalRawFindings', 'totalDeduped', 'belowThreshold'].map(key =>
        (r: any) => { r.stats[key]++; }),
      (r: any) => { r.stats.asyncMerged = 1; },
      (r: any) => { r.stats.modelWeights = {}; },
      (r: any) => { r.reviewerEvidence = { checkpoint: 'private prompt' }; },
    ];
    for (const mutate of mutations) {
      const altered = rewrite(reportBytes, mutate);
      expect(() => serializeReviewerArtifact({ assembly: args, reportBytes: altered, representation })).toThrow();
    }
  });

  it('refuses borrowed health, attribution, policy, async and proof bytes even if the ordinary digest is recomputed', async () => {
    const { args, reportBytes } = await complete();
    const artifact = serializeReviewerArtifact({ assembly: args, reportBytes, representation });
    for (const mutate of [
      (w: any) => { w.health.successfulSeats.push('invented-seat'); },
      (w: any) => { w.health.policy.minimumSuccessful = 1; },
      (w: any) => { w.contributions[0].origins[0].cell = 's2:0'; },
      (w: any) => { w.observations.push({ reason: 'invented' }); },
      (w: any) => { w.checkpoints[0].bytes += ' '; },
      (w: any) => { w.supplementalAsync.bytes += ' '; },
      (w: any) => { const r = JSON.parse(w.report.bytes); r.findings = []; w.report.bytes = JSON.stringify(r); w.report.sha256 = sha256Hex(w.report.bytes); },
      (w: any) => { w.representation.parseFailures = true; },
    ]) expect(() => validateReviewerArtifact(rewrite(artifact.bytes, mutate), { assembly: args, representation })).toThrow();
    expect(() => serializeReviewerArtifact({ assembly: { ...args, projection: structuredClone(args.projection) }, reportBytes, representation }))
      .toThrow('checkpoint_assembly_unvalidated_projection');
    expect(() => serializeReviewerArtifact({ assembly: { ...args, supplementalAsync: structuredClone(args.supplementalAsync) }, reportBytes, representation }))
      .toThrow('checkpoint_assembly_unvalidated_async');
  });

  it('keeps disabled appendix contributions and incomplete observations without inventing votes or source costs', async () => {
    const f = fixture({ minConfidence: 1, appendix: false });
    const rows = rowsFor(f, ['s0', 's1'], 'old');
    rows[0]!.findings = [{ ...finding('minor'), severity: 'minor' }];
    rows.push({ cell: 's2:0', id: 'partial', findings: [finding('incomplete', 'partial.ts')] });
    const args = input(f, await proof(f, rows), await proof(f, [{ cell: 's2:1', id: 'new-uncertain', uncertain: true }]));
    const assembled = await assembleCheckpointReview(args);
    const reportBytes = JSON.stringify(sanitizeForDelivery(assembled.report));
    const artifact = serializeReviewerArtifact({ assembly: args, reportBytes, representation });
    expect(artifact.contributions[0]!.disposition).toBe('below_threshold');
    expect(JSON.parse(reportBytes)).not.toHaveProperty('belowThresholdFindings');
    expect(artifact.observations.map(item => item.reason)).toEqual(['incomplete_seat']);
    expect(artifact.newPhysicalAttempts).toEqual([expect.objectContaining({ attemptId: 'new-uncertain', certainty: 'uncertain', possiblyBilled: true })]);
    expect(artifact.health.successfulSeats).toEqual(['s0', 's1']);
    expect(() => serializeReviewerArtifact({ assembly: args, representation,
      reportBytes: rewrite(reportBytes, r => { r.belowThresholdFindings = []; }) })).toThrow('reviewer_artifact_body_mismatch');
  });

  it('checks visible appendix bodies, async precedence/counts and the optional compact header descriptor', async () => {
    const f = fixture({ chunks: 1, models: ['same', 'same', 'other'], minConfidence: 1 });
    const rows = rowsFor(f, ['s0', 's1', 's2'], 'old');
    rows[0]!.findings = [{ ...finding('minority'), severity: 'minor' }];
    const args = input(f, await proof(f, rows), await proof(f, []));
    args.supplementalAsync = captureSupplementalAsync([
      asyncReview('same', finding('shadowed', 'shadowed.ts')),
      asyncReview('bonus', finding('bonus', 'bonus.ts')),
      asyncReview('failed', finding('failed', 'failed.ts'), 'error'),
    ], 3);
    const assembled = await assembleCheckpointReview(args);
    const compact = describeReviewerEvidence(args.projection.proofs.at(-1)!.proof, args.supplementalAsync);
    const delivered = sanitizeForDelivery({ ...assembled.report, run: { ...assembled.report.run, reviewer_evidence: compact } } as typeof assembled.report);
    const reportBytes = JSON.stringify(delivered);
    const artifact = serializeReviewerArtifact({ assembly: args, reportBytes, representation });
    expect(delivered.belowThresholdFindings).toHaveLength(1);
    expect(delivered.stats).toMatchObject({ asyncLaunched: 3, asyncMerged: 3, totalReviews: 4, successfulReviews: 3 });
    expect(artifact.observations.map(item => item.reason)).toEqual(['async_shadowed_by_blocking', 'unsuccessful_async']);
    expect(artifact.health.successfulSeats).toHaveLength(3);
    expect(artifact.contributions.flatMap(item => item.origins).map(origin => origin.kind).sort()).toEqual(['async', 'checkpoint']);
    for (const mutate of [
      (r: any) => { delete r.belowThresholdFindings; },
      (r: any) => { r.belowThresholdFindings[0].description = 'Altered appendix'; },
      (r: any) => { r.stats.asyncLaunched--; },
      (r: any) => { r.stats.asyncMerged++; },
      (r: any) => { r.run.reviewer_evidence.checkpoint_sha256 = 'f'.repeat(64); },
    ]) expect(() => serializeReviewerArtifact({ assembly: args, representation, reportBytes: rewrite(reportBytes, mutate) })).toThrow();
  });

  it('validates the selected sanitizer representation while preserving opaque raw evidence only privately', async () => {
    const f = fixture({ chunks: 1 });
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const source = await proof(f, [{ cell: 's0:0', id: 'old', findings: [{ ...finding('secret'), description: `token: ${secret}` }] }]);
    const successor = await proof(f, [{ cell: 's1:0', id: 'bad-parse', status: 'parse_failed', error: `Invalid JSON\nRaw response ${secret} remainder` }]);
    const args = input(f, source, successor);
    const assembled = await assembleCheckpointReview(args);
    for (const parseFailures of [false, true]) {
      const selected = { version: 1 as const, parseFailures };
      const reportBytes = JSON.stringify(sanitizeForDelivery(assembled.report, selected));
      const artifact = serializeReviewerArtifact({ assembly: args, reportBytes, representation: selected });
      expect(reportBytes).not.toContain(secret);
      expect(artifact.bytes).toContain(secret);
      expect(() => validateReviewerArtifact(artifact.bytes, { assembly: args, representation: { ...selected, parseFailures: !parseFailures } })).toThrow();
    }
  });


  it('round-trips sealed complete and failed verifier phases without a live ask', async () => {
    const complete = await sealedVerificationArtifact(), failed = await sealedVerificationArtifact(true);
    expect(complete.artifact.validation.gate).toMatchObject({ validation: 'deterministic', unresolvedFindingIdentities: [] });
    expect(JSON.parse(complete.artifact.bytes).verification).toEqual({ bytes: complete.verificationProof.bytes, sha256: complete.verificationProof.digest });
    expect(validateReviewerArtifact(complete.artifact.bytes, { assembly: complete.args, representation, verificationProof: complete.verificationProof }).bytes).toBe(complete.artifact.bytes);
    const inspected = inspectReviewerArtifact(complete.artifact.bytes, { expectedReportBytes: complete.reportBytes, expectedRunId: runId(2), expectedTarget: complete.f.plan.target, expectedPlan: complete.f.plan });
    expect(inspected.verificationProof).toEqual(complete.verificationProof);
    expect(JSON.parse(failed.reportBytes).findings[0].gating).toBeUndefined();
  });

  it('refuses omitted, cross-run, rehashed tampered verifier proof and report claims', async () => {
    const item = await sealedVerificationArtifact();
    expect(() => serializeReviewerArtifact({ assembly: item.args, representation, reportBytes: item.reportBytes })).toThrow('checkpoint_gating_missing_phase');
    const changed = rewrite(item.artifact.bytes, wire => { wire.verification.bytes = wire.verification.bytes.replace('refuted', 'unrefuted'); wire.verification.sha256 = sha256Hex(wire.verification.bytes); });
    expect(() => validateReviewerArtifact(changed, { assembly: item.args, representation })).toThrow();
    const other = await sealedVerificationArtifact(false, runId(8));
    expect(() => serializeReviewerArtifact({ assembly: item.args, representation, reportBytes: item.reportBytes, verificationProof: other.verificationProof })).toThrow();
    const claimed = rewrite(item.artifact.bytes, wire => { const report = JSON.parse(wire.report.bytes); report.stats.verification.unrefuted++; wire.report.bytes = JSON.stringify(report); wire.report.sha256 = sha256Hex(wire.report.bytes); });
    expect(() => validateReviewerArtifact(claimed, { assembly: item.args, representation })).toThrow('reviewer_artifact_body_mismatch');
  });

  it('refuses unsupported provider refutations without a sealed verifier proof', async () => {
    const f = fixture({ chunks: 1, verified: true });
    const rows = rowsFor(f, ['s0', 's1'], 'old'); rows[0]!.findings = [{ ...finding('important'), severity: 'important' }];
    const args = input(f, await proof(f, rows), await proof(f, []));
    const ask = vi.fn(async () => ({ model: 'google/gemini-3.8-flash', provider: 'google', status: 'success' as const,
      durationMs: 1, text: '[]' }));
    await expect(assembleCheckpointReview(args, { ask })).rejects.toThrow('checkpoint_gating_missing_phase');
    expect(ask).not.toHaveBeenCalled();
  });

  it('refuses false nonblocking critical annotations and any gate annotation when health is inconclusive', async () => {
    const { args, assembled } = await complete({ verified: true });
    const deterministic = serializeReviewerArtifact({ assembly: args, representation, reportBytes: JSON.stringify(sanitizeForDelivery(assembled.report)) });
    expect(deterministic.validation.gate.validation).toBe('deterministic');
    const falseNone = structuredClone(assembled.report); falseNone.findings[0]!.gating = { reason: 'none' }; falseNone.run.ci_exit_code = 0;
    expect(() => serializeReviewerArtifact({ assembly: args, representation, reportBytes: JSON.stringify(sanitizeForDelivery(falseNone)) })).toThrow();
    const f = fixture({ verified: true }), rows = rowsFor(f, ['s0'], 'one'); rows[0]!.findings = [finding('one')];
    const incomplete = input(f, await proof(f, rows), await proof(f, []));
    const report = await assembleCheckpointReview(incomplete);
    report.report.findings[0]!.gating = { reason: 'critical' };
    expect(() => serializeReviewerArtifact({ assembly: incomplete, representation, reportBytes: JSON.stringify(sanitizeForDelivery(report.report)) }))
      .toThrow('reviewer_artifact_body_mismatch');
  });

  it('round-trips exact nonvoting prose without applying ordinary-report prose transformations to private evidence', async () => {
    const f = fixture(), rows = rowsFor(f, ['s0', 's1'], 'old');
    rows.push({ cell: 's2:0', id: 'partial-prose', findings: [{ ...finding('raw-observation'), description: '\uD800' }] });
    const args = input(f, await proof(f, rows), await proof(f, []));
    const assembled = await assembleCheckpointReview(args);
    const artifact = serializeReviewerArtifact({ assembly: args, representation,
      reportBytes: JSON.stringify(sanitizeForDelivery(assembled.report)) });
    expect(artifact.observations[0]!.finding.description).toBe('\uD800');
    expect(validateReviewerArtifact(artifact.bytes, { assembly: args, representation }).bytes).toBe(artifact.bytes);
  });

  it('enforces the complete escaped artifact byte limit, including report whitespace', async () => {
    const { args, reportBytes } = await complete();
    const expanded = reportBytes + '\n'.repeat(12_500_000);
    expect(Buffer.byteLength(expanded)).toBeLessThan(MAX_ARTIFACT_BYTES);
    expect(() => serializeReviewerArtifact({ assembly: args, representation, reportBytes: expanded })).toThrow('reviewer_artifact_too_large');
    expect(() => validateReviewerArtifact(' '.repeat(MAX_ARTIFACT_BYTES + 1), { assembly: args, representation })).toThrow('reviewer_artifact_too_large');
  });
});

async function originalArtifact() {
  const f = fixture({ chunks: 1 });
  const launch = createOriginalLaunch({ runId: runId(2), target: f.plan.target, originalNativeClaim: { attempt: 2, round: 2 },
    capturedInputsSha256: f.capture.digest, planDigest: f.plan.digest, startedAtMs: 1000, expiresAtMs: 2000,
    maxPhysicalCalls: 3, maxAttemptsPerCell: 1 });
  const rows = rowsFor(f, ['s0', 's1'], 'original'); rows[0]!.findings = [finding('retained')];
  const originalProof = await proof(f, rows, f.capture.bytes, [['launch', encodeOriginalLaunch(launch)]]);
  const args = baseInput(f, projectCheckpointReport({ sources: [], successor: { runId: runId(2), proof: originalProof }, policy }));
  const assembled = await assembleCheckpointReview(args);
  const delivered = sanitizeForDelivery({ ...assembled.report, run: { ...assembled.report.run,
    reviewer_evidence: describeReviewerEvidence(originalProof, args.supplementalAsync) } } as typeof assembled.report);
  const reportBytes = JSON.stringify(delivered);
  const artifact = serializeReviewerArtifact({ assembly: args, representation, reportBytes });
  const expected = { expectedReportBytes: reportBytes, expectedRunId: runId(2), expectedTarget: f.plan.target, expectedPlan: f.plan };
  return { f, launch, originalProof, args, artifact, expected };
}

describe('reviewer recovery envelope declaration', () => {
  it('derives an original declaration from real private artifact bytes and never promotes those bytes to generic artifacts', async () => {
    const original = await originalArtifact();
    const inspected = inspectReviewerArtifact(original.artifact.bytes, original.expected);
    const declaration = declareReviewerRecovery({ artifact: original.artifact, descriptor: inspected.descriptor });
    expect(compatibilityDescriptorSchema).toBe(leafDescriptorSchema);
    expect(leafDescriptorSchema.parse(inspected.descriptor)).toEqual(inspected.descriptor);
    const result = JSON.parse(original.expected.expectedReportBytes);
    const artifacts = { report_json: original.expected.expectedReportBytes };
    const envelope = buildRunEnvelope(result, artifacts, {
      level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration,
    });
    expect(declaration).toMatchObject({ version: 1, artifact_schema: 1, sha256: original.artifact.digest,
      bytes: Buffer.byteLength(original.artifact.bytes), descriptor: inspected.descriptor });
    expect(envelope.reviewer_recovery).toEqual(declaration);
    expect(envelope.artifacts_declared.map(item => item.kind)).toEqual(['report_json']);
    expect(JSON.stringify(envelope)).not.toContain(original.artifact.bytes);
    expect(validateRunEnvelope(envelope, artifacts)).toEqual([]);
  });

  it('binds supplemented declaration source to actual source report and private artifact hashes', async () => {
    const original = await originalArtifact(), { f } = original;
    const operation = createRecoveryOperation({ operationId: runId(4), successorRunId: runId(3), sourceRunId: runId(2),
      sourceReportSha256: sha256Hex(original.expected.expectedReportBytes), sourceCheckpointSha256: original.originalProof.digest,
      capturedInputsSha256: f.capture.digest, planDigest: f.plan.digest, target: f.plan.target,
      originalNativeClaim: { attempt: 2, round: 2 }, startedAtMs: 2000, expiresAtMs: 3000, maxAdditionalCalls: 1, maxAttemptsPerCell: 1 });
    const successorProof = await proof(f, [], f.capture.bytes, [
      ['source', stableStringify({ run_id: runId(2), report_sha256: operation.sourceReportSha256, checkpoint_sha256: operation.sourceCheckpointSha256 })],
      ['operation', encodeRecoveryOperation(operation)],
    ]);
    const projection = projectCheckpointReport({ sources: [{ runId: runId(2), proof: original.originalProof }],
      successor: { runId: runId(3), proof: successorProof }, policy });
    const args = { ...baseInput(f, projection), run: { ...original.args.run, id: runId(3), converge: { target: f.plan.target, round: 3, attempt: 3 } } };
    const completed = await assembleCheckpointReview(args);
    const reportBytes = JSON.stringify(sanitizeForDelivery({ ...completed.report, run: { ...completed.report.run,
      reviewer_evidence: describeReviewerEvidence(successorProof, args.supplementalAsync) } } as typeof completed.report));
    const artifact = serializeReviewerArtifact({ assembly: args, representation, reportBytes });
    const inspected = inspectReviewerArtifact(artifact.bytes, { ...original.expected, expectedRunId: runId(3), expectedReportBytes: reportBytes });
    const declaration = declareReviewerRecovery({ artifact, descriptor: inspected.descriptor, source: {
      run_id: original.expected.expectedRunId, report_sha256: original.expected.expectedReportBytes && sha256Hex(original.expected.expectedReportBytes),
      reviewer_artifact_sha256: original.artifact.digest,
    } });
    expect(declaration.source).toEqual({ run_id: runId(2), report_sha256: operation.sourceReportSha256,
      reviewer_artifact_sha256: original.artifact.digest });
    const envelope = buildRunEnvelope(JSON.parse(reportBytes), { report_json: reportBytes }, {
      level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration,
    });
    expect(validateRunEnvelope(envelope, { report_json: reportBytes })).toEqual([]);
    expect(() => declareReviewerRecovery({ artifact: { ...artifact, digest: 'f'.repeat(64) }, descriptor: inspected.descriptor, source: declaration.source }))
      .toThrow('reviewer_recovery_invalid_artifact');
    for (const mutate of [
      (v: any) => { v.reviewer_recovery.extra = true; },
      (v: any) => { v.reviewer_recovery.source.run_id = runId(9); },
      (v: any) => { v.reviewer_recovery.descriptor.operation_id = runId(9); },
    ]) {
      const altered = structuredClone(envelope); mutate(altered);
      expect(validateRunEnvelope(altered, { report_json: reportBytes })).not.toEqual([]);
    }
  });
});

describe('separate terminal artifact inspection', () => {
  it('reconstructs original assembly and validates the exact terminal pair without inline proof or new report hash', async () => {
    const { f, launch, originalProof, artifact, expected, args } = await originalArtifact();
    const inspected = inspectReviewerArtifact(artifact.bytes, expected);
    expect(inspected.reportBytes).toBe(expected.expectedReportBytes);
    expect(inspected.reportSha256).toBe(sha256Hex(expected.expectedReportBytes));
    expect(inspected.runId).toBe(runId(2));
    expect(inspected.prTarget).toBe('allocator-one/rcl#105');
    expect(inspected.proof.bytes).toBe(originalProof.bytes);
    expect(inspected.captured.digest).toBe(f.capture.digest);
    expect(inspected.launch).toEqual(launch);
    expect(inspected.descriptor).toMatchObject({ kind: 'original', launch_sha256: sha256Hex(encodeOriginalLaunch(launch)) });
    expect(inspected.assembly.diff.files).toEqual(args.diff.files);
    expect(inspected.assembly.run.startedAt).toEqual(args.run.startedAt);
    expect(inspected.artifact.digest).toBe(artifact.digest);
    expect(JSON.parse(inspected.reportBytes)).not.toHaveProperty('reviewerEvidence');
  });

  it('requires external terminal bytes, run, target and full expected plan and rejects altered reconstruction metadata', async () => {
    const { artifact, expected } = await originalArtifact();
    for (const key of ['expectedReportBytes', 'expectedRunId', 'expectedTarget', 'expectedPlan']) {
      const missing = { ...expected } as Record<string, unknown>; delete missing[key];
      expect(() => inspectReviewerArtifact(artifact.bytes, missing as any)).toThrow('reviewer_artifact_invalid_expectations');
    }
    for (const altered of [
      { ...expected, expectedReportBytes: expected.expectedReportBytes + ' ' },
      { ...expected, expectedRunId: runId(9) },
      { ...expected, expectedTarget: 'another-target' },
      { ...expected, expectedPlan: freezeCheckpointPlan({ ...expected.expectedPlan, headSha: 'f'.repeat(40) }) },
      { ...expected, expectedPrTarget: 'allocator-one/rcl#106' },
    ]) expect(() => inspectReviewerArtifact(artifact.bytes, altered)).toThrow();
    for (const mutate of [
      (w: any) => { delete w.assembly; },
      (w: any) => { w.assembly.diff.files[0].patchIndex = 99; },
      (w: any) => { w.assembly.diff.files.push(w.assembly.diff.files[0]); },
      (w: any) => { w.assembly.run.id = runId(9); },
      (w: any) => { w.assembly.run.converge.attempt++; },
      (w: any) => { w.assembly.run.contextFiles = [{ path: 'different', sha256: 'a'.repeat(64) }]; },
      (w: any) => { w.assembly.diff.source = 'invented'; },
      (w: any) => { w.checkpoints[0].sha256 = 'f'.repeat(64); },
    ]) expect(() => inspectReviewerArtifact(rewrite(artifact.bytes, mutate), expected)).toThrow();
  });

  it('inspects an explicitly linked successor and keeps the source claim and prior report hash separate', async () => {
    const original = await originalArtifact(), { f } = original;
    const operation = createRecoveryOperation({ operationId: runId(4), successorRunId: runId(3), sourceRunId: runId(2),
      sourceReportSha256: sha256Hex(original.expected.expectedReportBytes), sourceCheckpointSha256: original.originalProof.digest,
      capturedInputsSha256: f.capture.digest, planDigest: f.plan.digest, target: f.plan.target,
      originalNativeClaim: { attempt: 2, round: 2 }, startedAtMs: 2000, expiresAtMs: 3000, maxAdditionalCalls: 1, maxAttemptsPerCell: 1 });
    const successor = await proof(f, [], f.capture.bytes, [
      ['source', stableStringify({ run_id: runId(2), report_sha256: operation.sourceReportSha256, checkpoint_sha256: operation.sourceCheckpointSha256 })],
      ['operation', encodeRecoveryOperation(operation)],
    ]);
    const projection = projectCheckpointReport({ sources: [{ runId: runId(2), proof: original.originalProof }],
      successor: { runId: runId(3), proof: successor }, policy });
    const args = { ...baseInput(f, projection), run: { ...original.args.run, id: runId(3), converge: { target: f.plan.target, round: 3, attempt: 3 } } };
    const assembled = await assembleCheckpointReview(args);
    const reportBytes = JSON.stringify(sanitizeForDelivery(assembled.report));
    const artifact = serializeReviewerArtifact({ assembly: args, representation, reportBytes });
    const inspected = inspectReviewerArtifact(artifact.bytes, { ...original.expected, expectedRunId: runId(3), expectedReportBytes: reportBytes });
    expect(inspected.operation).toEqual(operation);
    expect(inspected.descriptor).toMatchObject({ kind: 'supplemented', source: { report_sha256: operation.sourceReportSha256 } });
    expect(inspected.reportSha256).toBe(sha256Hex(reportBytes));
    expect(inspected.reportSha256).not.toBe(operation.sourceReportSha256);
    expect(inspected.nativeClaim).toEqual({ target: f.plan.target, attempt: 3, round: 3 });
  });
});
