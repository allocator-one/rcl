import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { captureReviewerInputs } from '../../src/dispatch/captured-inputs.js';
import { CheckpointJournal, checkpointPath, exportCheckpointProof, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { createOriginalLaunch, encodeOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { createRecoveryOperation, encodeRecoveryOperation } from '../../src/dispatch/recovery-operation.js';
import { captureAggregationInputs } from '../../src/report/aggregation-inputs.js';
import { assembleCheckpointReview } from '../../src/report/checkpoint-assembly.js';
import { projectCheckpointReport } from '../../src/report/checkpoint-projection.js';
import { serializeReviewerArtifact } from '../../src/report/reviewer-artifact.js';
import { configDigest, diffDigest, sha256Hex, stableStringify } from '../../src/report/run-header.js';
import { captureSupplementalAsync } from '../../src/report/supplemental-async.js';
import { sanitizeForDelivery } from '../../src/telemetry/envelope.js';
import { formatReviewerStatus, inspectReviewerStatus, inspectReviewerRecoveryPreview } from '../../src/evidence/reviewer-status.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const target = 'allocator-one/allocator-one#9165';
const runId = '01a0daa6-b575-759b-942c-e879460be5bf';
const successorRunId = '01a0daa6-b575-759b-942c-e879460be5c1';
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const role = { name: 'general', systemPrompt: 'Review.', focus: [], description: 'General', isSpecialized: false };
const review = (model: string, status: 'success' | 'timeout' = 'success') => JSON.stringify({ model, provider: 'fake', role: 'general', status,
  durationMs: 1, findings: [], ...(status === 'timeout' ? { error: 'timeout' } : {}) });

async function fixture(namespace = runId, chunkCount = 2) {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-reviewer-status-'))); roots.push(commonDir);
  const files = [{ filename: 'changed.ts', status: 'modified' as const, previousFilename: null, patch: '@@ -1 +1 @@\n-old\n+new\n', additions: 1, deletions: 1, blobSha: null, language: 'typescript' }];
  const thresholds = { minConsensusScore: 0, minConfidence: 0, dedupeLineWindow: 3, jaccardThreshold: 0.3 };
  const config = { quorumFraction: 2 / 3, thresholds, output: { belowThresholdAppendix: true } };
  const chunks = ['first chunk', 'second chunk'].slice(0, chunkCount);
  const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: diffDigest(files),
    configSha256: configDigest(config), specSha256: sha('spec'), contextSha256: sha('[]'),
    toolsSha256: sha(stableStringify({ parser: { name: 'findings-json', version: 1 }, aggregation: { name: 'consensus', version: 2 } })),
    parser: { name: 'findings-json', version: 1 }, roster: ['a', 'b', 'c'].map(seat => ({ seat, model: `model-${seat}`, role: 'general', route: 'fake' })),
    chunks: chunks.map((bytes, index) => ({ index, total: chunks.length, digest: sha(bytes) })),
    prompts: chunks.flatMap((_, chunk) => ['a', 'b', 'c'].map(seat => ({ seat, chunk, systemSha256: sha('Review.'), userSha256: sha(`prompt ${seat}:${chunk}`) }))),
  });
  const aggregation = captureAggregationInputs({ algorithm: { name: 'consensus', version: 2 }, diffSha256: plan.patchSha256,
    roleMap: new Map([[role.name, role]]), thresholds, gating: { mode: 'all-findings', minModels: 2, verificationModel: undefined,
      verificationTimeoutMs: 60_000, verificationPassTimeoutMs: 180_000 }, belowThresholdAppendix: true });
  const patchBytes = stableStringify(files.map(({ language: _language, ...file }) => file));
  const capture = captureReviewerInputs({ plan, policy: { version: 1, fraction: 2 / 3 }, patchBytes, configBytes: stableStringify(config),
    specBytes: 'spec', contextBytes: '[]', toolsBytes: stableStringify({ parser: { name: 'findings-json', version: 1 }, aggregation: { name: 'consensus', version: 2 } }),
    chunkBytes: chunks, assignments: plan.cells.map(cell => ({ model: cell.model, provider: cell.route, role })),
    prompts: plan.cells.map(cell => ({ systemPrompt: 'Review.', userPrompt: `prompt ${cell.seat}:${cell.chunk}` })), aggregation,
  });
  let journal!: CheckpointJournal;
  await withNativeTarget(commonDir, target, async ownership => {
    journal = await CheckpointJournal.create({ commonDir, namespace, plan, ownership });
    await journal.bind('captured-inputs', capture.bytes, ownership);
    await journal.bind('launch', encodeOriginalLaunch(createOriginalLaunch({ runId, target, originalNativeClaim: { attempt: 25, round: 14 },
      capturedInputsSha256: capture.digest, planDigest: plan.digest, startedAtMs: 1_000, expiresAtMs: 10_000, maxPhysicalCalls: 12, maxAttemptsPerCell: 2 })), ownership);
    for (const { index: chunk } of plan.chunks) {
      const cell = `a:${chunk}`, attempt = { id: `paid-a-${chunk}`, kind: 'paid' as const };
      await journal.recordIntent(cell, attempt, ownership);
      await journal.recordResult(cell, attempt, { kind: 'success', chunk, reviewBytes: review('model-a') }, ownership);
    }
    const failed = { id: 'paid-b-0', kind: 'paid' as const };
    await journal.recordIntent('b:0', failed, ownership);
    await journal.recordResult('b:0', failed, { kind: 'failure', chunk: 0, reviewBytes: review('model-b', 'timeout'), possiblyBilled: true }, ownership);
    await journal.recordIntent('c:0', { id: 'unknown-c-0', kind: 'unknown' }, ownership);
  });
  return { commonDir, plan, journal, capture, files, config };
}

async function terminalPair(run: string, plan: ReturnType<typeof freezeCheckpointPlan>, proof: Awaited<ReturnType<typeof exportCheckpointProof>>, files: any[]) {
  const projection = projectCheckpointReport({ sources: [], successor: { runId: run, proof }, policy: { version: 1, fraction: 2 / 3 } });
  const assembly = { projection, supplementalAsync: captureSupplementalAsync([], 0), diff: { source: 'local' as const, files }, startTime: 1_000,
    run: { id: run, rclVersion: '4.1.4', command: 'review' as const,
      target: { kind: 'pr' as const, repo: 'allocator-one/allocator-one', prNumber: 9165, headSha: plan.headSha, baseSha: 'c'.repeat(40) },
      roster: plan.roster.map(seat => ({ model: seat.model, provider: seat.route, role: seat.role, lane: 'blocking' as const })),
      spec: { source: 'flag' as const, sha256: plan.specSha256 }, contextFiles: [], runner: { kind: 'agent' as const }, startedAt: new Date(1_000),
      converge: { target, attempt: 25, round: 14 } } };
  const assembled = await assembleCheckpointReview(assembly);
  const reportBytes = JSON.stringify(sanitizeForDelivery(assembled.report));
  return { reportBytes, reviewerArtifactBytes: serializeReviewerArtifact({ assembly, representation: { version: 1, parseFailures: false }, reportBytes }).bytes };
}

describe('local reviewer status', () => {
  it('derives original-seat health, attempts and saved budget without exposing result bytes', async () => {
    const { commonDir, plan } = await fixture();
    const status = await inspectReviewerStatus({ commonDir, target, runId, nowMs: 4_000 });
    expect(status).toMatchObject({ version: 1, scope: 'local_structural_status_only', authorization: 'not_recovery_authorization_or_server_approval',
      target, runId, kind: 'original', finalized: false, terminalArtifact: { available: false },
      plan: { digest: plan.digest }, health: { successfulSeats: 1, minimumSuccessful: 2, successesNeeded: 1, conclusive: false },
      attempts: { physical: 4, newOnly: 4, uncertain: 1, failures: [{ classification: 'transient_failure', count: 1 }, { classification: 'uncertain_outcome', count: 1 }] },
      budget: { remainingMs: 6_000, maxPhysicalCalls: 12, maxAttemptsPerCell: 2, expiresAtMs: 10_000 },
    });
    expect(status.health.seats).toEqual([
      expect.objectContaining({ seat: 'a', completedChunks: [0, 1], missingChunks: [], complete: true }),
      expect.objectContaining({ seat: 'b', completedChunks: [], missingChunks: [0, 1], complete: false }),
      expect.objectContaining({ seat: 'c', completedChunks: [], missingChunks: [0, 1], complete: false }),
    ]);
    expect(JSON.stringify(status)).not.toContain('timeout');
    expect(formatReviewerStatus(status)).toContain('1/2 complete seats');
  });

  it('uses the exact checkpoint path and refuses legacy journals without capture and launch bindings', async () => {
    const { commonDir, plan } = await fixture();
    const legacyRun = '01a0daa6-b575-759b-942c-e879460be5c0';
    await withNativeTarget(commonDir, target, async ownership => {
      await CheckpointJournal.create({ commonDir, namespace: legacyRun, plan, ownership });
    });
    await expect(inspectReviewerStatus({ commonDir, target, runId: 'not-a-run' })).rejects.toThrow('reviewer_status_invalid_input');
    await expect(inspectReviewerStatus({ commonDir, target: 'allocator-one/allocator-one#9999', runId })).rejects.toThrow();
    await expect(inspectReviewerStatus({ commonDir, target, runId: legacyRun })).rejects.toThrow('reviewer_status_missing_capture');
    expect(checkpointPath(commonDir, target, runId)).toContain(runId);
    expect(plan.target).toBe(target);
  });

  it('follows only an explicit retained source chain and reports digest-only ancestry', async () => {
    const { commonDir, plan, capture, files } = await fixture('seed', 1);
    await withNativeTarget(commonDir, target, async ownership => {
      const source = await CheckpointJournal.create({ commonDir, namespace: runId, plan, ownership });
      await source.bind('captured-inputs', capture.bytes, ownership);
      await source.bind('launch', encodeOriginalLaunch(createOriginalLaunch({ runId, target, originalNativeClaim: { attempt: 25, round: 14 },
        capturedInputsSha256: capture.digest, planDigest: plan.digest, startedAtMs: 1_000, expiresAtMs: 10_000, maxPhysicalCalls: 12, maxAttemptsPerCell: 2 })), ownership);
      for (const seat of ['a', 'b']) {
        const attempt = { id: `source-${seat}`, kind: 'paid' as const };
        const cell = source.getPlan().cells.find(item => item.seat === seat)!;
        await source.recordIntent(cell.id, attempt, ownership);
        await source.recordResult(cell.id, attempt, { kind: 'success', chunk: cell.chunk, reviewBytes: review(`model-${seat}`) }, ownership);
      }
      await source.finalize(ownership);
      const proof = await exportCheckpointProof(source), terminal = await terminalPair(runId, plan, proof, files);
      await source.retainTerminalReport(terminal, ownership);
      const operation = createRecoveryOperation({ operationId: '01a0daa6-b575-759b-942c-e879460be5c2', successorRunId, sourceRunId: runId,
        sourceReportSha256: sha256Hex(terminal.reportBytes), sourceCheckpointSha256: proof.digest, capturedInputsSha256: capture.digest, planDigest: plan.digest,
        target, originalNativeClaim: { attempt: 25, round: 14 }, startedAtMs: 1_000, expiresAtMs: 10_000, maxAdditionalCalls: 3, maxAttemptsPerCell: 2 });
      const successor = await CheckpointJournal.create({ commonDir, namespace: successorRunId, plan, ownership });
      await successor.bind('captured-inputs', capture.bytes, ownership);
      await successor.bind('source', stableStringify({ run_id: runId, report_sha256: sha256Hex(terminal.reportBytes), checkpoint_sha256: proof.digest }), ownership);
      await successor.bind('operation', encodeRecoveryOperation(operation), ownership);
      const attempt = { id: 'successor-c', kind: 'paid' as const };
      const cell = successor.getPlan().cells.find(item => item.seat === 'c')!;
      await successor.recordIntent(cell.id, attempt, ownership);
      await successor.recordResult(cell.id, attempt, { kind: 'success', chunk: cell.chunk, reviewBytes: review('model-c') }, ownership);
    });
    const status = await inspectReviewerStatus({ commonDir, target, runId: successorRunId, nowMs: 2_000 });
    expect(status.kind).toBe('successor');
    expect(status.health).toMatchObject({ successfulSeats: 3, minimumSuccessful: 2, successesNeeded: 0, conclusive: true });
    expect(status.attempts).toMatchObject({ physical: 3, newOnly: 1, uncertain: 0 });
    expect(status.lineage).toEqual([
      expect.objectContaining({ runId, kind: 'original', capturedInputsSha256: capture.digest }),
      expect.objectContaining({ runId: successorRunId, kind: 'successor', capturedInputsSha256: capture.digest }),
    ]);
    expect(JSON.stringify(status)).not.toContain('reviewerArtifactBytes');
    await writeFile(join(checkpointPath(commonDir, target, runId), 'terminal-report', 'reviewer-artifact.json'), '{"tampered":true}\n');
    await expect(inspectReviewerStatus({ commonDir, target, runId: successorRunId, nowMs: 2_000 })).rejects.toThrow();
  });
});


describe('local missing-reviewer preview', () => {
  async function seal(value: Awaited<ReturnType<typeof fixture>>) {
    await withNativeTarget(value.commonDir, target, async ownership => {
      await value.journal.finalize(ownership);
      await value.journal.retainTerminalReport(await terminalPair(runId, value.plan, await exportCheckpointProof(value.journal), value.files), ownership);
    });
  }

  it('plans only missing chunks from a sealed source and preserves uncertain calls without authorizing a launch', async () => {
    const value = await fixture();
    await seal(value);
    const before = (await exportCheckpointProof(value.journal)).digest;
    const result = await inspectReviewerRecoveryPreview({ commonDir: value.commonDir, target, runId, nowMs: 20_000,
      maxAdditionalCalls: 2, maxAttemptsPerCell: 2, timeBudgetMs: 30_000 });
    expect(result).toMatchObject({ scope: 'local_structural_preview_only', authorization: 'not_recovery_authorization_or_server_approval',
      proposedBudget: { maxAdditionalCalls: 2, maxAttemptsPerCell: 2, timeBudgetMs: 30_000 },
      recovery: { successfulSeats: 1, successesNeeded: 1, remainingCalls: 2, nextAction: 'retry_missing_assignments' } });
    expect(result.eligibleAssignments.map(item => item.cell)).toEqual(['b:0', 'b:1']);
    expect(result.recovery.blockedCells).toContainEqual({ cell: 'c:0', reason: 'uncertain_outcome' });
    expect(result.source.reportSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.source.checkpointSha256).toBe(before);
    expect((await exportCheckpointProof(value.journal)).digest).toBe(before);
    expect(JSON.stringify(result)).not.toContain('prompt b:0');
    expect(JSON.stringify(result)).not.toContain('reviewBytes');
  });

  it('refuses open or unretained sources and invalid proposed budgets without changing saved bounds', async () => {
    const value = await fixture();
    const request = { commonDir: value.commonDir, target, runId, nowMs: 4_000,
      maxAdditionalCalls: 2, maxAttemptsPerCell: 2, timeBudgetMs: 30_000 };
    await expect(inspectReviewerRecoveryPreview(request)).rejects.toThrow('reviewer_lineage_unsealed');
    await withNativeTarget(value.commonDir, target, async ownership => { await value.journal.finalize(ownership); });
    await expect(inspectReviewerRecoveryPreview(request)).rejects.toThrow('reviewer_lineage_terminal_missing');
    await withNativeTarget(value.commonDir, target, async ownership => {
      await value.journal.retainTerminalReport(await terminalPair(runId, value.plan, await exportCheckpointProof(value.journal), value.files), ownership);
    });
    const before = (await exportCheckpointProof(value.journal)).digest;
    const proposed = await inspectReviewerRecoveryPreview({ ...request, maxAttemptsPerCell: 3 });
    expect(proposed.proposedBudget.maxAttemptsPerCell).toBe(3);
    expect((await inspectReviewerStatus(request)).budget.maxAttemptsPerCell).toBe(2);
    await expect(inspectReviewerRecoveryPreview({ ...request, maxAdditionalCalls: 0 })).rejects.toThrow('reviewer_preview_invalid_budget');
    expect((await exportCheckpointProof(value.journal)).digest).toBe(before);
  });

  it('reports the existing report path with no eligible calls once retained seats already reach quorum', async () => {
    const value = await fixture();
    await withNativeTarget(value.commonDir, target, async ownership => {
      for (const chunk of [0, 1]) {
        const attempt = { id: `retry-b-${chunk}`, kind: 'paid' as const };
        await value.journal.recordIntent(`b:${chunk}`, attempt, ownership);
        await value.journal.recordResult(`b:${chunk}`, attempt, { kind: 'success', chunk, reviewBytes: review('model-b') }, ownership);
      }
    });
    await seal(value);
    const result = await inspectReviewerRecoveryPreview({ commonDir: value.commonDir, target, runId, nowMs: 4_000,
      maxAdditionalCalls: 1, maxAttemptsPerCell: 2, timeBudgetMs: 30_000 });
    expect(result.recovery).toMatchObject({ successfulSeats: 2, successesNeeded: 0, nextAction: 'build_report' });
    expect(result.eligibleAssignments).toEqual([]);
  });
});
