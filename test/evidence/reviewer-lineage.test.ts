import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { processSupplementedRoundReport, retainedLaunchInputSha256 } from '../../src/converge/retained-report.js';
import { loadConvergeRunState } from '../../src/converge/run-state.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, exportCheckpointProof, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { captureReviewerInputs } from '../../src/dispatch/captured-inputs.js';
import { createOriginalLaunch, encodeOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { createRecoveryOperation, encodeRecoveryOperation } from '../../src/dispatch/recovery-operation.js';
import { loadReviewerLineage } from '../../src/evidence/reviewer-lineage.js';
import { captureAggregationInputs } from '../../src/report/aggregation-inputs.js';
import { assembleCheckpointReview } from '../../src/report/checkpoint-assembly.js';
import { projectCheckpointReport } from '../../src/report/checkpoint-projection.js';
import { serializeReviewerArtifact } from '../../src/report/reviewer-artifact.js';
import { configDigest, diffDigest, sha256Hex, stableStringify } from '../../src/report/run-header.js';
import { captureSupplementalAsync } from '../../src/report/supplemental-async.js';
import { sanitizeForDelivery } from '../../src/telemetry/envelope.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const target = 'allocator-one/rcl#105';
const rootId = '11111111-1111-4111-8111-111111111111';
const successorId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const role = { name: 'general', systemPrompt: 'Review.', focus: [], description: 'General', isSpecialized: false };

function review(cell: string, status: 'success' | 'error', error = 'timeout') {
  return JSON.stringify({ model: `model-${cell}`, provider: 'fake', role: 'general', status, durationMs: 1,
    findings: cell === 'a' && status === 'success' ? [{ id: 'f', file: 'a.ts', startLine: 1, endLine: 1,
      severity: 'important', category: 'correctness', title: 't', description: 'd' }] : [],
    ...(status === 'error' ? { error } : {}) });
}

async function fixture(options: {
  rootMaxPhysicalCalls?: number;
  rootMaxAttemptsPerCell?: number;
  rootBFailures?: number;
  rootBError?: string;
  rootBPending?: boolean;
  concurrentSuccessor?: boolean;
  successorCalls?: number;
  successorMaxAttemptsPerCell?: number;
  successorClaim?: number;
} = {}) {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-reviewer-lineage-')));
  roots.push(commonDir);
  const files = [{ filename: 'a.ts', status: 'modified' as const, previousFilename: null, patch: '@@\n+x', additions: 1, deletions: 0, blobSha: null, language: 'typescript' }];
  const config = { quorumFraction: 2 / 3, thresholds: { minConsensusScore: 0, minConfidence: 0, dedupeLineWindow: 3, jaccardThreshold: 0.3 }, output: { belowThresholdAppendix: true } };
  const tools = stableStringify({ parser: { name: 'findings-json', version: 1 }, aggregation: { name: 'consensus', version: 1 } });
  const seats = options.concurrentSuccessor ? ['a', 'b', 'c'] : ['a', 'b'];
  const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: diffDigest(files),
    configSha256: configDigest(config), specSha256: sha256Hex('spec'), contextSha256: sha256Hex('[]'), toolsSha256: sha256Hex(tools),
    parser: { name: 'findings-json', version: 1 }, roster: seats.map(seat => ({ seat, model: `model-${seat}`, role: 'general', route: 'fake' })),
    chunks: [{ index: 0, total: 1, digest: sha256Hex('chunk') }],
    prompts: seats.map(seat => ({ seat, chunk: 0, systemSha256: sha256Hex('Review.'), userSha256: sha256Hex(`prompt-${seat}`) })),
  });
  const captured = captureReviewerInputs({ plan, policy: { version: 1, fraction: 2 / 3 },
    patchBytes: stableStringify(files.map(({ language: _language, ...file }) => file)), configBytes: stableStringify(config), specBytes: 'spec', contextBytes: '[]', toolsBytes: tools, chunkBytes: ['chunk'],
    assignments: plan.cells.map(cell => ({ model: cell.model, provider: cell.route, role })),
    prompts: plan.cells.map(cell => ({ systemPrompt: 'Review.', userPrompt: `prompt-${cell.seat}` })),
    aggregation: captureAggregationInputs({ algorithm: { name: 'consensus', version: 1 }, diffSha256: plan.patchSha256,
      roleMap: new Map([[role.name, role]]), thresholds: config.thresholds,
      gating: { mode: 'all-findings', minModels: 2, verificationTimeoutMs: 100, verificationPassTimeoutMs: 100 }, belowThresholdAppendix: true }),
  });
  const baseRun: any = { id: rootId, rclVersion: 'test', command: 'review',
    target: { kind: 'patch', repo: 'allocator-one/rcl', prNumber: 105, headSha: plan.headSha, baseSha: plan.mergeBaseSha },
    roster: plan.roster.map(seat => ({ model: seat.model, role: seat.role, provider: seat.route, lane: 'blocking' })),
    spec: { source: 'flag', sha256: plan.specSha256 }, contextFiles: [], runner: { kind: 'agent' }, startedAt: new Date(1),
    converge: { target, attempt: 1, round: 1 } };
  let reportBytes = '';
  await withNativeTarget(commonDir, target, async ownership => {
    const root = await CheckpointJournal.create({ commonDir, namespace: rootId, plan, ownership });
    await root.bind('captured-inputs', captured.bytes, ownership);
    const rootBFailures = options.rootBFailures ?? 1;
    await root.bind('launch', encodeOriginalLaunch(createOriginalLaunch({ runId: rootId, target, originalNativeClaim: { attempt: 1, round: 1 },
      capturedInputsSha256: captured.digest, planDigest: plan.digest, startedAtMs: 1, expiresAtMs: 60_000,
      maxPhysicalCalls: options.rootMaxPhysicalCalls ?? 1 + rootBFailures + (options.concurrentSuccessor ? 1 : 0),
      maxAttemptsPerCell: options.rootMaxAttemptsPerCell ?? 2 })), ownership);
    await root.recordIntent('a:0', { id: 'root-a', kind: 'paid' }, ownership);
    await root.recordResult('a:0', { id: 'root-a', kind: 'paid' }, { kind: 'success', chunk: 0, reviewBytes: review('a', 'success') }, ownership);
    for (let index = 0; index < rootBFailures; index++) {
      const id = `root-b-${index}`;
      await root.recordIntent('b:0', { id, kind: 'paid' }, ownership);
      if (!options.rootBPending) await root.recordResult('b:0', { id, kind: 'paid' }, { kind: 'failure', chunk: 0, possiblyBilled: true, reviewBytes: review('b', 'error', options.rootBError) }, ownership);
    }
    if (options.concurrentSuccessor) {
      await root.recordIntent('c:0', { id: 'root-c', kind: 'paid' }, ownership);
      await root.recordResult('c:0', { id: 'root-c', kind: 'paid' }, { kind: 'failure', chunk: 0, possiblyBilled: true, reviewBytes: review('c', 'error') }, ownership);
    }
    await root.finalize(ownership);
    const rootProof = await exportCheckpointProof(root);
    const rootAssembly: any = { projection: projectCheckpointReport({ sources: [], successor: { runId: rootId, proof: rootProof }, policy: captured.policy }),
      supplementalAsync: captureSupplementalAsync([], 0), diff: { source: 'local', files }, startTime: 1, run: baseRun };
    const rootReport = JSON.stringify(sanitizeForDelivery((await assembleCheckpointReview(rootAssembly)).report));
    await root.retainTerminalReport({ reportBytes: rootReport, reviewerArtifactBytes: serializeReviewerArtifact({ assembly: rootAssembly, reportBytes: rootReport, representation: { version: 1, parseFailures: false } }).bytes }, ownership);

    const operation = createRecoveryOperation({ operationId, successorRunId: successorId, sourceRunId: rootId, sourceReportSha256: sha256Hex(rootReport), sourceCheckpointSha256: rootProof.digest,
      capturedInputsSha256: captured.digest, planDigest: plan.digest, target, originalNativeClaim: { attempt: 1, round: 1 },
      successorNativeClaim: { attempt: options.successorClaim ?? 2, round: 1 }, startedAtMs: 2, expiresAtMs: 60_000,
      maxAdditionalCalls: 2, maxAttemptsPerCell: options.successorMaxAttemptsPerCell ?? 3 });
    const successor = await CheckpointJournal.create({ commonDir, namespace: successorId, plan, ownership });
    await successor.bind('captured-inputs', captured.bytes, ownership);
    await successor.bind('source', stableStringify({ run_id: rootId, report_sha256: sha256Hex(rootReport), checkpoint_sha256: rootProof.digest }), ownership);
    await successor.bind('operation', encodeRecoveryOperation(operation), ownership);
    if (options.concurrentSuccessor) {
      await successor.recordIntent('b:0', { id: 'successor-b', kind: 'paid' }, ownership);
      await successor.recordIntent('c:0', { id: 'successor-c', kind: 'paid' }, ownership);
      await successor.recordResult('b:0', { id: 'successor-b', kind: 'paid' }, { kind: 'success', chunk: 0, reviewBytes: review('b', 'success') }, ownership);
      await successor.recordResult('c:0', { id: 'successor-c', kind: 'paid' }, { kind: 'success', chunk: 0, reviewBytes: review('c', 'success') }, ownership);
    } else for (let index = 0; index < (options.successorCalls ?? 3) - 1; index++) {
      const id = `successor-failure-${index}`;
      await successor.recordIntent('b:0', { id, kind: 'paid' }, ownership);
      await successor.recordResult('b:0', { id, kind: 'paid' }, { kind: 'failure', chunk: 0, possiblyBilled: true, reviewBytes: review('b', 'error') }, ownership);
    }
    if (!options.concurrentSuccessor) {
      const finalId = 'successor-success';
      await successor.recordIntent('b:0', { id: finalId, kind: 'paid' }, ownership);
      await successor.recordResult('b:0', { id: finalId, kind: 'paid' }, { kind: 'success', chunk: 0, reviewBytes: review('b', 'success') }, ownership);
    }
    await successor.finalize(ownership);
    const successorProof = await exportCheckpointProof(successor);
    const successorRun = { ...baseRun, id: successorId, startedAt: new Date(2), converge: { target, attempt: operation.successorNativeClaim!.attempt, round: 1 } };
    const successorAssembly: any = { projection: projectCheckpointReport({ sources: [{ runId: rootId, proof: rootProof }], successor: { runId: successorId, proof: successorProof }, policy: captured.policy }),
      supplementalAsync: captureSupplementalAsync([], 0), diff: { source: 'local', files }, startTime: 2, run: successorRun };
    reportBytes = JSON.stringify(sanitizeForDelivery((await assembleCheckpointReview(successorAssembly)).report));
    await successor.retainTerminalReport({ reportBytes, reviewerArtifactBytes: serializeReviewerArtifact({ assembly: successorAssembly, reportBytes, representation: { version: 1, parseFailures: false } }).bytes }, ownership);
  });
  return { commonDir, reportBytes, plan, captured };
}

describe('sealed reviewer lineage limits', () => {
  it('refuses an over-budget successor before supplemented admission can write native state', async () => {
    const value = await fixture();
    await expect(loadReviewerLineage({ commonDir: value.commonDir, target, runId: successorId })).rejects.toThrow('reviewer_lineage_successor_additional_call_limit');
    expect(await loadConvergeRunState(value.commonDir, target)).toBeUndefined();
    await expect(processSupplementedRoundReport({ gitCommonDir: value.commonDir, target, round: 1, reportBytes: value.reportBytes, currentHeadSha: value.plan.headSha })).rejects.toThrow('reviewer_lineage_successor_additional_call_limit');
    expect(await loadConvergeRunState(value.commonDir, target)).toBeUndefined();
  });

  it('rejects a sealed root whose recorded physical calls exceed its launch cap', async () => {
    const value = await fixture({ rootMaxPhysicalCalls: 1, successorCalls: 1 });
    await expect(loadReviewerLineage({ commonDir: value.commonDir, target, runId: successorId })).rejects.toThrow('reviewer_lineage_root_physical_call_limit');
  });

  it('rejects a sealed root whose retries exceed its per-cell launch cap', async () => {
    const value = await fixture({ rootBFailures: 2, rootMaxPhysicalCalls: 3, rootMaxAttemptsPerCell: 1, successorCalls: 1 });
    await expect(loadReviewerLineage({ commonDir: value.commonDir, target, runId: successorId })).rejects.toThrow('reviewer_lineage_root_attempts_per_cell_limit');
  });

  it('counts predecessor failures against the successor per-cell cap', async () => {
    const value = await fixture({ successorCalls: 2, successorMaxAttemptsPerCell: 1 });
    await expect(loadReviewerLineage({ commonDir: value.commonDir, target, runId: successorId })).rejects.toThrow('reviewer_lineage_successor_attempts_per_cell_limit');
  });

  it('refuses retrying an observed permanent source failure', async () => {
    const value = await fixture({ successorCalls: 1, rootBError: '401 invalid api key' });
    await expect(loadReviewerLineage({ commonDir: value.commonDir, target, runId: successorId })).rejects.toThrow('reviewer_lineage_successor_ineligible_attempt');
  });

  it('treats a sealed source intent without a result as uncertain', async () => {
    await expect(fixture({ successorCalls: 1, rootBPending: true })).rejects.toThrow('checkpoint_projection_uncertain_resampled');
  });

  it('accepts a bounded successor chain whose failures are recoverable', async () => {
    const value = await fixture({ successorCalls: 2 });
    await expect(loadReviewerLineage({ commonDir: value.commonDir, target, runId: successorId })).resolves.toMatchObject({ latest: { runId: successorId } });
  });

  it('accepts distinct concurrent intents recorded before quorum completes', async () => {
    const value = await fixture({ concurrentSuccessor: true });
    await expect(loadReviewerLineage({ commonDir: value.commonDir, target, runId: successorId })).resolves.toMatchObject({ latest: { runId: successorId } });
  });
});
