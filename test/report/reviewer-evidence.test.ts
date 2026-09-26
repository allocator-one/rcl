import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, exportCheckpointProof } from '../../src/dispatch/checkpoint.js';
import { capturePreparedCouncil } from '../../src/dispatch/capture-council.js';
import { createOriginalLaunch, encodeOriginalLaunch, type OriginalLaunch } from '../../src/dispatch/original-launch.js';
import { MAX_ARTIFACT_BYTES } from '../../src/telemetry/envelope-validation.js';
import { createRecoveryOperation, encodeRecoveryOperation } from '../../src/dispatch/recovery-operation.js';
import { chunkDiff } from '../../src/prepare/chunker.js';
import { buildPrompt } from '../../src/prepare/prompt-builder.js';
import { captureAggregationInputs } from '../../src/report/aggregation-inputs.js';
import { captureSupplementalAsync } from '../../src/report/supplemental-async.js';
import { buildRunHeader, diffDigest, sha256Hex, stableStringify } from '../../src/report/run-header.js';
import { assertReviewerRunBindings, MAX_REVIEWER_REPORT_BYTES, describeReviewerEvidence, inspectReviewerEvidenceReport, reviewerSourceBinding, validateReviewerReportChain } from '../../src/report/reviewer-evidence.js';
import type { Diff } from '../../src/resolver/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const target = 'allocator-one/rcl#105';
const ids = ['01a0daa6-b575-759b-942c-e879460be5bf', '01a0daa6-b575-759b-942c-e879460be5b0', '01a0daa6-b575-759b-942c-e879460be5b1'];
async function fixture(nativeTarget = target, withAggregation = false) {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-lineage-'))); roots.push(commonDir);
  const diff: Diff = { source: 'local', files: [{ filename: 'x.ts', language: 'typescript', status: 'modified',
    patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1 }] };
  const assignments = [0, 1].map(index => ({ model: `fake/m${index}`, provider: 'fake',
    role: { name: 'general', systemPrompt: 'Review', focus: [], description: '', isSpecialized: false } }));
  const config = { quorumFraction: 2 / 3 };
  const chunks = chunkDiff(diff.files);
  const prompts = await Promise.all(chunks.flatMap(chunk => assignments.map(a => buildPrompt(chunk, a.role))));
  const { plan, captured } = capturePreparedCouncil({ target: nativeTarget, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40),
    diff, assignments, chunks, prompts, config, specBytes: '', contextDocs: [],
    compatibility: { parser: { name: 'findings-json', version: 1 }, aggregation: { name: 'consensus', version: 2 } },
    ...(withAggregation ? { aggregationInputs: captureAggregationInputs({ algorithm: { name: 'consensus', version: 2 },
      diffSha256: diffDigest(diff.files), roleMap: new Map(assignments.map(a => [a.role.name, a.role])),
      thresholds: { minConsensusScore: 0.5, minConfidence: 0.5, dedupeLineWindow: 3, jaccardThreshold: 0.5 },
      gating: { mode: 'all-findings', minModels: 2, verificationModel: undefined, verificationTimeoutMs: 1000, verificationPassTimeoutMs: 1000 },
      belowThresholdAppendix: true }) } : {}) });
  const header = (id: string, round: number) => buildRunHeader({ id, rclVersion: '4.1.3', command: 'review',
    target: { kind: 'pr', repo: 'allocator-one/rcl', prNumber: 105, headSha: plan.headSha, baseSha: 'c'.repeat(40) },
    diff, roster: assignments.map(a => ({ model: a.model, provider: a.provider, role: a.role.name, lane: 'blocking' })),
    config, thresholds: { minConsensusScore: 0.5, minConfidence: 0.5, dedupeLineWindow: 3, jaccardThreshold: 0.5 },
    gating: { mode: 'all-findings', minModels: 2, verificationModel: undefined, verificationTimeoutMs: 1000, verificationPassTimeoutMs: 1000 },
    runner: { kind: 'agent' }, startedAt: new Date(1000), finishedAt: new Date(2000), ciExitCode: 1,
    converge: { target: nativeTarget, round, attempt: round } });
  return { commonDir, plan, captured, header, supplementalAsync: withAggregation ? captureSupplementalAsync([], 2) : undefined };
}

async function original(input: Awaited<ReturnType<typeof fixture>>, launch?: OriginalLaunch) {
  return withNativeTarget(input.commonDir, input.plan.target, async ownership => {
    const journal = await CheckpointJournal.create({ commonDir: input.commonDir, namespace: 'original', plan: input.plan, ownership });
    await journal.bind('captured-inputs', input.captured.bytes, ownership);
    if (launch) await journal.bind('launch', encodeOriginalLaunch(launch), ownership);
    await journal.finalize(ownership);
    const proof = await exportCheckpointProof(journal);
    const bytes = JSON.stringify({ run: { ...input.header(ids[0]!, 1), reviewer_evidence: describeReviewerEvidence(proof, input.supplementalAsync) },
      reviews: [], findings: [], stats: { totalReviews: 2, successfulReviews: 0, totalRawFindings: 0, totalDeduped: 0, belowThreshold: 0, durationMs: 0 },
      reviewerEvidence: { checkpoint: proof.bytes, ...(input.supplementalAsync ? { supplemental_async: input.supplementalAsync.bytes } : {}) } });
    return inspectReviewerEvidenceReport(bytes, input.plan);
  });
}

describe('immutable reviewer report lineage', () => {
  it('binds an original report to exact finalized checkpoint and captured inputs', async () => {
    const input = await fixture(), source = await original(input);
    expect(source.runId).toBe(ids[0]);
    expect(source.descriptor.kind).toBe('original');
    expect(source.proof.plan.digest).toBe(input.plan.digest);
    expect(validateReviewerReportChain([source])).toHaveLength(1);
  });


  it('keeps opaque native accounting keys separate from the actual PR binding', async () => {
    const input = await fixture('rcl-105'), source = await original(input);
    expect(source.proof.plan.target).toBe('rcl-105');
    expect(source.prTarget).toBe(target);
    expect(inspectReviewerEvidenceReport(source.reportBytes, input.plan, 'ALLOCATOR-ONE/RCL#105').prTarget).toBe(target);
    expect(() => inspectReviewerEvidenceReport(source.reportBytes, input.plan, 'allocator-one/rcl#106'))
      .toThrow('reviewer_report_target_mismatch');
    for (const change of [
      (report: any) => { delete report.run.converge; },
      (report: any) => { report.run.converge.target = 'rcl-106'; },
      (report: any) => { delete report.run.target.repo; },
    ]) {
      const report = JSON.parse(source.reportBytes); change(report);
      expect(() => inspectReviewerEvidenceReport(JSON.stringify(report), input.plan)).toThrow();
    }
  });

  it('rejects legacy/missing proof, changed target and substituted checkpoint bytes', async () => {
    const input = await fixture(), source = await original(input);
    for (const change of [
      (report: any) => { delete report.run.reviewer_evidence; },
      (report: any) => { delete report.reviewerEvidence; },
      (report: any) => { report.run.target.head_sha = 'e'.repeat(40); },
      (report: any) => { report.run.reviewer_evidence.checkpoint_sha256 = 'd'.repeat(64); },
      (report: any) => { report.reviewerEvidence.checkpoint += ' '; },
    ]) {
      const report = JSON.parse(source.reportBytes); change(report);
      expect(() => inspectReviewerEvidenceReport(JSON.stringify(report), input.plan)).toThrow();
    }
  });

  it('requires the immediate immutable source and a distinct successor run', async () => {
    const input = await fixture('rcl-105', true), source = await original(input);
    const successor = await withNativeTarget(input.commonDir, input.plan.target, async ownership => {
      const operation = createRecoveryOperation({ operationId: ids[2]!, successorRunId: ids[1]!, sourceRunId: source.runId,
        sourceReportSha256: source.reportSha256, sourceCheckpointSha256: source.proof.digest,
        capturedInputsSha256: input.captured.digest, planDigest: input.plan.digest, target: input.plan.target,
        originalNativeClaim: { attempt: 1, round: 1 }, successorNativeClaim: { attempt: 2, round: 2 }, startedAtMs: 1000, expiresAtMs: 2000, maxAdditionalCalls: 2, maxAttemptsPerCell: 2 });
      const journal = await CheckpointJournal.create({ commonDir: input.commonDir, namespace: 'successor', plan: input.plan, ownership });
      await journal.bind('captured-inputs', input.captured.bytes, ownership);
      await journal.bind('source', reviewerSourceBinding(source), ownership);
      await journal.bind('operation', encodeRecoveryOperation(operation), ownership);
      await journal.finalize(ownership);
      const proof = await exportCheckpointProof(journal), raw = JSON.parse(source.reportBytes);
      raw.run = { ...input.header(ids[1]!, 2), reviewer_evidence: describeReviewerEvidence(proof, input.supplementalAsync) };
      raw.reviewerEvidence = { checkpoint: proof.bytes, ...(input.supplementalAsync ? { supplemental_async: input.supplementalAsync.bytes } : {}) };
      return inspectReviewerEvidenceReport(JSON.stringify(raw), input.plan);
    });
    expect(validateReviewerReportChain([source, successor])).toHaveLength(2);
    const changedAsync = captureSupplementalAsync([], 3);
    const altered = JSON.parse(successor.reportBytes);
    altered.run.reviewer_evidence = describeReviewerEvidence(successor.proof, changedAsync);
    altered.reviewerEvidence.supplemental_async = changedAsync.bytes;
    const withChangedAsync = inspectReviewerEvidenceReport(JSON.stringify(altered), input.plan);
    expect(() => validateReviewerReportChain([source, withChangedAsync])).toThrow('reviewer_lineage_async_mismatch');
    // Opaque native accounting keys must not permit a different PR in the chain.
    const fork = JSON.parse(successor.reportBytes); fork.run.target.pr_number = 106;
    const forkedSuccessor = inspectReviewerEvidenceReport(JSON.stringify(fork), input.plan);
    expect(() => validateReviewerReportChain([source, forkedSuccessor])).toThrow('reviewer_lineage_target_mismatch');
    expect(() => validateReviewerReportChain([successor])).toThrow();
    expect(() => validateReviewerReportChain([source, source])).toThrow();
    const changed = JSON.parse(source.reportBytes); changed.stats.durationMs = 1;
    const other = inspectReviewerEvidenceReport(JSON.stringify(changed), input.plan);
    expect(() => validateReviewerReportChain([other, successor])).toThrow('reviewer_lineage_source_mismatch');
    expect(() => validateReviewerReportChain([JSON.parse(stableStringify(source))])).toThrow('reviewer_report_not_inspected');
  });
});

it('binds aggregation and raw async snapshot hashes and refuses omitted or substituted artifacts', async () => {
  const input = await fixture('rcl-105', true), source = await original(input);
  expect(source.descriptor.aggregation_sha256).toBe(input.captured.aggregation!.digest);
  expect(source.descriptor.supplemental_async_sha256).toBe(input.supplementalAsync!.digest);
  expect(source.supplementalAsync!.bytes).toBe(input.supplementalAsync!.bytes);
  for (const change of [
    (report: any) => { delete report.reviewerEvidence.supplemental_async; },
    (report: any) => { report.reviewerEvidence.supplemental_async = captureSupplementalAsync([], 1).bytes; },
    (report: any) => { report.run.reviewer_evidence.aggregation_sha256 = 'f'.repeat(64); },
  ]) {
    const report = JSON.parse(source.reportBytes); change(report);
    expect(() => inspectReviewerEvidenceReport(JSON.stringify(report), input.plan)).toThrow();
  }
  expect(() => describeReviewerEvidence(source.proof)).toThrow('reviewer_missing_async_snapshot');
});

function launchFor(input: Awaited<ReturnType<typeof fixture>>) {
  return createOriginalLaunch({ runId: ids[0]!, target: input.plan.target, originalNativeClaim: { attempt: 1, round: 1 },
    capturedInputsSha256: input.captured.digest, planDigest: input.plan.digest,
    startedAtMs: 1000, expiresAtMs: 2000, maxPhysicalCalls: 2, maxAttemptsPerCell: 1 });
}

async function proofWithBindings(input: Awaited<ReturnType<typeof fixture>>,
  bindings: Array<['launch' | 'source' | 'operation', string]>) {
  return withNativeTarget(input.commonDir, input.plan.target, async ownership => {
    const journal = await CheckpointJournal.create({ commonDir: input.commonDir, namespace: 'bound-proof', plan: input.plan, ownership });
    await journal.bind('captured-inputs', input.captured.bytes, ownership);
    for (const [name, bytes] of bindings) await journal.bind(name, bytes, ownership);
    await journal.finalize(ownership);
    return exportCheckpointProof(journal);
  });
}

describe('original launch report binding', () => {
  it('exposes the exact launch and digest without treating missing legacy launch as execution proof', async () => {
    const input = await fixture('rcl-105'), launch = launchFor(input), source = await original(input, launch);
    expect(source.launch).toEqual(launch);
    expect(Object.isFrozen(source.launch)).toBe(true);
    expect(source.descriptor).toMatchObject({ kind: 'original', launch_sha256: sha256Hex(encodeOriginalLaunch(launch)) });
    expect(assertReviewerRunBindings(input.header(ids[0]!, 1), source.proof, input.captured)).toBe(target);
    // Expiry is historical execution metadata; structural inspection is not a new launch.
    expect(source.launch!.expiresAtMs).toBe(2000);
    const legacy = await original(await fixture());
    expect(legacy.launch).toBeUndefined();
    expect(legacy.descriptor).not.toHaveProperty('launch_sha256');
  });

  it('refuses substituted run UUID or native claim before aggregation and during artifact inspection', async () => {
    const input = await fixture(), source = await original(input, launchFor(input));
    for (const change of [
      (run: any) => { run.id = ids[1]; },
      (run: any) => { run.converge.attempt = 2; },
      (run: any) => { run.converge.round = 2; },
      (run: any) => { delete run.converge; },
    ]) {
      const report = JSON.parse(source.reportBytes); change(report.run);
      expect(() => assertReviewerRunBindings(report.run, source.proof, input.captured)).toThrow('reviewer_report_launch_mismatch');
      expect(() => inspectReviewerEvidenceReport(JSON.stringify(report), input.plan)).toThrow('reviewer_report_launch_mismatch');
    }
  });

  it.each(['target', 'planDigest', 'capturedInputsSha256'] as const)('refuses launch with changed %s', async field => {
    const input = await fixture(), launch = launchFor(input);
    const altered = { ...launch, [field]: field === 'target' ? 'another-target' : 'f'.repeat(64) };
    const proof = await proofWithBindings(input, [['launch', encodeOriginalLaunch(altered)]]);
    expect(() => describeReviewerEvidence(proof)).toThrow('reviewer_original_launch_mismatch');
    expect(() => assertReviewerRunBindings(input.header(ids[0]!, 1), proof, input.captured)).toThrow('reviewer_original_launch_mismatch');
  });

  it.each([['source'], ['operation'], ['source', 'operation']] as const)('refuses launch mixed with %j', async (...names) => {
    const input = await fixture(), launch = launchFor(input);
    const operation = createRecoveryOperation({ operationId: ids[2]!, successorRunId: ids[1]!, sourceRunId: ids[0]!,
      sourceReportSha256: 'a'.repeat(64), sourceCheckpointSha256: 'b'.repeat(64),
      capturedInputsSha256: input.captured.digest, planDigest: input.plan.digest, target: input.plan.target,
      originalNativeClaim: { attempt: 1, round: 1 }, successorNativeClaim: { attempt: 2, round: 2 }, startedAtMs: 1000, expiresAtMs: 2000, maxAdditionalCalls: 2, maxAttemptsPerCell: 2 });
    const bytes = { source: stableStringify({ run_id: ids[0], report_sha256: 'a'.repeat(64), checkpoint_sha256: 'b'.repeat(64) }),
      operation: encodeRecoveryOperation(operation) };
    const proof = await proofWithBindings(input, [['launch', encodeOriginalLaunch(launch)], ...names.map(name => [name, bytes[name]] as ['source' | 'operation', string])]);
    expect(() => describeReviewerEvidence(proof)).toThrow('reviewer_mixed_launch_bindings');
    expect(() => assertReviewerRunBindings(input.header(ids[0]!, 1), proof, input.captured)).toThrow('reviewer_mixed_launch_bindings');
  });

  it('refuses malformed launch bytes and omitted or altered launch digest', async () => {
    const input = await fixture(), source = await original(input, launchFor(input));
    const malformed = await proofWithBindings(input, [['launch', '{}']]);
    expect(() => describeReviewerEvidence(malformed)).toThrow('original_launch_invalid_document');
    expect(() => assertReviewerRunBindings(input.header(ids[0]!, 1), malformed, input.captured)).toThrow('original_launch_invalid_document');
    for (const digest of [undefined, 'f'.repeat(64)]) {
      const raw = JSON.parse(source.reportBytes);
      raw.run.reviewer_evidence.launch_sha256 = digest;
      expect(() => inspectReviewerEvidenceReport(JSON.stringify(raw))).toThrow('reviewer_descriptor_mismatch');
    }
  });

  it('refuses a complete report one byte above the shared decimal artifact limit', async () => {
    const source = await original(await fixture());
    const bytes = source.reportBytes + ' '.repeat(MAX_ARTIFACT_BYTES + 1 - Buffer.byteLength(source.reportBytes));
    expect(Buffer.byteLength(bytes)).toBe(25_000_001);
    expect(() => inspectReviewerEvidenceReport(bytes)).toThrow('reviewer_report_invalid_bytes');
    expect(MAX_REVIEWER_REPORT_BYTES).toBe(MAX_ARTIFACT_BYTES);
  });
});
