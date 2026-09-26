import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Finding, ModelReview } from '../../src/consensus/types.js';
import type { Config } from '../../src/config/schema.js';
import type { Diff } from '../../src/resolver/types.js';
import { withNativeTarget, type NativeTargetOwnership } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, checkpointPath, exportCheckpointProof, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { executeCheckpointGating } from '../../src/dispatch/checkpoint-gating-execution.js';
import { captureReviewerInputs } from '../../src/dispatch/captured-inputs.js';
import { captureAggregationInputs } from '../../src/report/aggregation-inputs.js';
import { assembleCheckpointReview } from '../../src/report/checkpoint-assembly.js';
import { projectCheckpointReport } from '../../src/report/checkpoint-projection.js';
import { captureSupplementalAsync } from '../../src/report/supplemental-async.js';
import { configDigest, diffDigest, sha256Hex, stableStringify } from '../../src/report/run-header.js';
import { sanitizeForDelivery } from '../../src/telemetry/envelope.js';
import { createRecoveryOperation, encodeRecoveryOperation } from '../../src/dispatch/recovery-operation.js';
import { createOriginalLaunch, encodeOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { serializeReviewerArtifact } from '../../src/report/reviewer-artifact.js';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { guardReviewerRecoveryLaunch } from '../../src/converge/recovery-launch.js';
import { inspectReviewerStatus } from '../../src/evidence/reviewer-status.js';
import { loadReviewerLineage } from '../../src/evidence/reviewer-lineage.js';
import { convergeAttemptStatePath, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState, resolveRoundResolution } from '../../src/converge/run-state.js';
import * as retainedReports from '../../src/converge/retained-report.js';
import { processRetainedRoundReport, processSupplementedRoundReport, retainedLaunchInputSha256 } from '../../src/converge/retained-report.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-round-'))); roots.push(path); return path; }
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
      verificationTimeoutMs: options.verified ? 3000 : 100, verificationPassTimeoutMs: options.verified ? 5000 : 100 },
    modelWeights: new Map([[models[0]!, 0.75]]), belowThresholdAppendix: options.appendix ?? true });
  const capture = captureReviewerInputs({ plan, policy, patchBytes, configBytes, specBytes, contextBytes, toolsBytes,
    chunkBytes, assignments: plan.cells.map(cell => ({ model: cell.model, provider: cell.route, role })),
    prompts: plan.cells.map(cell => ({ systemPrompt: 'system', userPrompt: `prompt ${cell.chunk}` })),
    ...(options.aggregation === false ? {} : { aggregation }) });
  expect(sha256Hex(patchBytes)).toBe(plan.patchSha256);
  return { plan, capture, diff, config };
}

async function retained(options: { seats?: number; partial?: boolean; seal?: boolean; terminal?: boolean; substitutedProof?: boolean; supplemented?: boolean; verified?: boolean; minorityError?: boolean; deliveryPending?: boolean } = {}) {
  const f = fixture({ chunks: 2, verified: options.verified });
  const gitCommonDir = await directory(), target = f.plan.target, id = runId(10);
  const run = { id, rclVersion: '4.1.3', command: 'review' as const,
    target: { kind: 'patch' as const, repo: 'allocator-one/rcl', prNumber: 105,
      headSha: f.plan.headSha, baseSha: f.plan.mergeBaseSha },
    roster: f.plan.roster.map(seat => ({ model: seat.model, role: seat.role, provider: seat.route, lane: 'blocking' as const })),
    spec: { source: 'flag' as const, sha256: f.plan.specSha256 }, contextFiles: [], runner: { kind: 'agent' as const },
    startedAt: new Date(1000), converge: { target, round: 1, attempt: 1 } };
  let reportBytes = '';
  await guardReviewLaunch({ gitCommonDir, target, headSha: f.plan.headSha,
    inputSha256: retainedLaunchInputSha256(f.capture.digest, run), maxAttempts: 3, maxRounds: 3,
    validate: async () => {}, run: async (claim, ownership) => {
      run.converge = claim as typeof run.converge;
      const launch = createOriginalLaunch({ runId: id, target, originalNativeClaim: { attempt: 1, round: 1 },
        capturedInputsSha256: f.capture.digest, planDigest: f.plan.digest, startedAtMs: 1000, expiresAtMs: options.verified ? 61000 : 2000,
        maxPhysicalCalls: 6, maxAttemptsPerCell: 1 });
      const createJournal = async (commonDir: string, owner: NativeTargetOwnership, suffix: string) => {
        const journal = await CheckpointJournal.create({ commonDir, namespace: id, plan: f.plan, ownership: owner });
        await journal.bind('captured-inputs', f.capture.bytes, owner);
        await journal.bind(options.supplemented ? 'source' : 'launch', options.supplemented ? '{}' : encodeOriginalLaunch(launch), owner);
        for (const cell of f.plan.cells) {
          const seat = Number(cell.seat.slice(1));
          if (seat >= (options.seats ?? 2) && !options.minorityError || options.partial && cell.chunk > 0) continue;
          const failed = options.minorityError && seat >= (options.seats ?? 2);
          const attempt = { id: `${suffix}-${cell.id}`, kind: 'paid' as const };
          const review: ModelReview = { model: cell.model, role: cell.role, provider: cell.route, status: failed ? 'error' : 'success', ...(failed ? { error: 'HTTP 400 invalid request' } : {}),
            durationMs: 1, findings: seat === 0 && cell.chunk === 0 ? [{ ...finding('original-critical'), severity: options.verified ? 'important' : 'critical' }] : [] };
          await journal.recordIntent(cell.id, attempt, owner);
          await journal.recordResult(cell.id, attempt, failed ? { kind: 'failure', chunk: cell.chunk, reviewBytes: JSON.stringify(review), possiblyBilled: false }
            : { kind: 'success', chunk: cell.chunk, reviewBytes: JSON.stringify(review) }, owner);
        }
        if (options.seal !== false) await journal.finalize(owner);
        return journal;
      };
      const journal = await createJournal(gitCommonDir, ownership, 'original');
      if (options.seal === false || options.supplemented) {
        reportBytes = JSON.stringify({ run: { id }, findings: [] });
        return { runId: id, reportJsonSha256: sha256Hex(reportBytes), totalReviews: 3, successfulReviews: 0, deliveryPending: false };
      }
      let proof = await exportCheckpointProof(journal);
      if (options.substitutedProof) {
        const other = await directory();
        proof = await withNativeTarget(other, target, async owner => exportCheckpointProof(await createJournal(other, owner, 'substituted')));
      }
      const projection = projectCheckpointReport({ sources: [], successor: { runId: id, proof }, policy });
      const assembly = { projection, supplementalAsync: emptyAsync(), diff: f.diff, startTime: 1000, run };
      const gate = options.verified ? await executeCheckpointGating({ assembly, commonDir: gitCommonDir, ownership, journal,
        askFactory: () => async () => ({ model: 'google/gemini-3.8-flash', provider: 'google', status: 'success' as const, durationMs: 1, text: '[]' }),
        beforeLaunch: async () => {}, onLateAuditError: () => {}, nowMs: () => 1100, monotonicNow: () => 0 }) : undefined;
      const { report } = await assembleCheckpointReview(assembly, ...(gate?.verificationProof ? [{ verificationProof: gate.verificationProof }] : []));
      reportBytes = JSON.stringify(sanitizeForDelivery(report));
      const artifact = serializeReviewerArtifact({ assembly, reportBytes, representation: { version: 1, parseFailures: false }, ...(gate?.verificationProof ? { verificationProof: gate.verificationProof } : {}) });
      if (options.terminal !== false) await journal.retainTerminalReport({ reportBytes, reviewerArtifactBytes: artifact.bytes }, ownership);
      const health = projection.health;
      return { runId: id, reportJsonSha256: sha256Hex(reportBytes), totalReviews: health.policy.seatCount,
        successfulReviews: health.successfulSeats.length, deliveryPending: options.deliveryPending ?? false, hardFailure: options.minorityError ?? false,
        reviewerHealth: { version: 1, policy: health.policy, successfulSeats: health.successfulSeats.length } };
    } });
  return { gitCommonDir, target, id, reportBytes, currentHeadSha: f.plan.headSha, round: 1, maxRounds: 3,
    checkpoint: checkpointPath(gitCommonDir, target, id), f, run };
}
async function nativeBytes(f: Awaited<ReturnType<typeof retained>>) {
  return Promise.all([convergeRunStatePath(f.gitCommonDir, f.target), convergeAttemptStatePath(f.gitCommonDir, f.target)].map(path => readFile(path)));
}
async function alterState(f: Awaited<ReturnType<typeof retained>>, mutate: (value: any) => void, attempt = false) {
  const path = (attempt ? convergeAttemptStatePath : convergeRunStatePath)(f.gitCommonDir, f.target);
  const state = JSON.parse(await readFile(path, 'utf8')); mutate(state); await writeFile(path, JSON.stringify(state));
}

describe('native admission of an original retained report', () => {
  it('admits conclusive complete seats while retaining actionable findings and replays without another round or attempt', async () => {
    const f = await retained(), attempts = (await nativeBytes(f))[1];
    const first = await processRetainedRoundReport(f);
    expect(first.roundCap).toBe(3);
    expect(resolveRoundResolution((await loadConvergeRunState(f.gitCommonDir, f.target))!, 1)!.status).toBe('unresolved');
    expect(first.findings).toHaveLength(1);
    expect(first.findings[0]!.finding.severity).toBe('critical');
    expect(first.findings[0]!.finding.description).toBe('An unrelated tenant can read this record.');
    const replay = await processRetainedRoundReport(f);
    expect(replay).toEqual(first);
    expect((await loadConvergeRunState(f.gitCommonDir, f.target))!.rounds).toHaveLength(1);
    expect((await nativeBytes(f))[1]).toEqual(attempts);
    expect(await loadConvergeAttemptState(f.gitCommonDir, f.target)).toMatchObject({ attemptsUsed: 1, cap: 3 });
  });

  it('refuses expired existing ownership rather than taking a replacement target lock', async () => {
    const f = await retained(); let expired!: NativeTargetOwnership;
    await withNativeTarget(f.gitCommonDir, f.target, async owner => { expired = owner; });
    const before = await nativeBytes(f);
    await expect(processRetainedRoundReport({ ...f, ownership: expired })).rejects.toThrow('native_target_not_owned');
    expect(await nativeBytes(f)).toEqual(before);
  });

  it('reuses live ownership for the entire validation and admission instead of acquiring a second target lock', async () => {
    const f = await retained();
    await withNativeTarget(f.gitCommonDir, f.target, async ownership => {
      const result = await processRetainedRoundReport({ ...f, ownership });
      expect(result.findings).toHaveLength(1);
      expect(resolveRoundResolution((await loadConvergeRunState(f.gitCommonDir, f.target))!, 1)!.status).toBe('unresolved');
    });
  });

  it('admits a structurally replayed sealed verifier phase', async () => {
    const f = await retained({ verified: true });
    const phase = await (await CheckpointJournal.inspectRead(f.checkpoint)).readVerification();
    expect(phase!.terminal!.status).toBe('complete');
    expect(JSON.parse(f.reportBytes).findings[0].gating.verification.verdict).toBe('unavailable');
    expect((await processRetainedRoundReport(f)).findings).toHaveLength(1);
    const status = await inspectReviewerStatus({ commonDir: f.gitCommonDir, target: f.target, runId: f.id });
    expect(status.attempts.verifier.current).toMatchObject({ intents: 1, status: 'complete' });
  });

  it.each(['missing', 'replaced'])('refuses a %s verifier journal before admission or lineage reuse', async kind => {
    const f = await retained({ verified: true }), before = await nativeBytes(f);
    const change = kind === 'missing'
      ? vi.spyOn(CheckpointJournal.prototype, 'readVerification').mockResolvedValue(undefined)
      : vi.spyOn(CheckpointJournal.prototype, 'exportVerificationProof').mockResolvedValue({ bytes: '{}', digest: 'f'.repeat(64) });
    try {
      await expect(processRetainedRoundReport(f)).rejects.toThrow('retained_report_verification_mismatch');
      await expect(inspectReviewerStatus({ commonDir: f.gitCommonDir, target: f.target, runId: f.id })).rejects.toThrow('reviewer_status_verification_mismatch');
      await expect(loadReviewerLineage({ commonDir: f.gitCommonDir, target: f.target, runId: f.id }))
        .rejects.toThrow('reviewer_lineage_verification_mismatch');
      expect(await nativeBytes(f)).toEqual(before);
    } finally { change.mockRestore(); }
  });

  it('admits a conclusive original quorum despite a permanent minority failure and pending delivery', async () => {
    const f = await retained({ minorityError: true, deliveryPending: true });
    expect((await loadConvergeRunState(f.gitCommonDir, f.target))!.lastLaunch).toMatchObject({
      hardFailure: true, deliveryPending: true, successfulReviews: 2, totalReviews: 3 });
    const attempts = (await nativeBytes(f))[1];
    const admitted = await processRetainedRoundReport(f);
    expect(admitted.findings).toHaveLength(1);
    expect(resolveRoundResolution((await loadConvergeRunState(f.gitCommonDir, f.target))!, 1)!.status).toBe('unresolved');
    expect((await nativeBytes(f))[1]).toEqual(attempts);
    expect((await loadConvergeRunState(f.gitCommonDir, f.target))!.lastLaunch).toMatchObject({ hardFailure: true, deliveryPending: true });
  });

  it('refuses partial seats despite enough successful individual chunk calls and preserves native counters', async () => {
    const f = await retained({ seats: 3, partial: true }), before = await nativeBytes(f);
    await expect(processRetainedRoundReport(f)).rejects.toThrow('retained_report_inconclusive_health');
    expect(await nativeBytes(f)).toEqual(before);
  });

  it.each(['status', 'run', 'head', 'input', 'round', 'attempt', 'hash', 'successes', 'total', 'policy', 'spent'])(
    'refuses native %s mismatch before admission without changing either native file', async kind => {
      const f = await retained();
      await alterState(f, state => {
        if (kind === 'spent') { state.attemptsUsed = 0; state.attempts = []; return; }
        const launch = state.lastLaunch;
        if (kind === 'status') launch.status = 'pending';
        if (kind === 'run') launch.runId = runId(99);
        if (kind === 'head') launch.headSha = 'c'.repeat(40);
        if (kind === 'input') launch.inputSha256 = 'c'.repeat(64);
        if (kind === 'round') launch.round = 2;
        if (kind === 'attempt') launch.attempt = 2;
        if (kind === 'hash') launch.reportJsonSha256 = 'c'.repeat(64);
        if (kind === 'successes') launch.successfulReviews = 3;
        if (kind === 'total') launch.totalReviews = 4;
        if (kind === 'policy') launch.reviewerHealth.policy.fraction = 1;
      }, kind === 'spent');
      const before = await nativeBytes(f);
      await expect(processRetainedRoundReport(f)).rejects.toThrow('retained_report_native_launch_mismatch');
      expect(await nativeBytes(f)).toEqual(before);
    });

  it('refuses current-head drift and any byte change to the exact ordinary report', async () => {
    const f = await retained(), before = await nativeBytes(f);
    await expect(processRetainedRoundReport({ ...f, currentHeadSha: 'c'.repeat(40) })).rejects.toThrow('retained_report_head_mismatch');
    await expect(processRetainedRoundReport({ ...f, reportBytes: f.reportBytes + '\n' })).rejects.toThrow('retained_report_terminal_mismatch');
    expect(await nativeBytes(f)).toEqual(before);
  });

  it('refuses an otherwise valid artifact from a different local journal proof', async () => {
    const f = await retained({ substitutedProof: true }), before = await nativeBytes(f);
    await expect(processRetainedRoundReport(f)).rejects.toThrow('retained_report_checkpoint_mismatch');
    expect(await nativeBytes(f)).toEqual(before);
  });

  it.each(['main', 'terminal'])('refuses a missing sealed %s before native admission', async kind => {
    const f = await retained(kind === 'main' ? { seal: false } : { terminal: false }), before = await nativeBytes(f);
    await expect(processRetainedRoundReport(f)).rejects.toThrow(kind === 'main' ? 'retained_report_unsealed_checkpoint' : 'retained_report_missing_terminal');
    expect(await nativeBytes(f)).toEqual(before);
  });

  it('refuses supplemented native authority without pretending the source is an original launch', async () => {
    const f = await retained({ supplemented: true }), before = await nativeBytes(f);
    await expect(processRetainedRoundReport(f)).rejects.toThrow('retained_report_supplemented_authority_unsupported');
    expect(await nativeBytes(f)).toEqual(before);
  });

  it('binds target metadata, original roster order, spec and exact capture in the retained-only launch digest', () => {
    const f = fixture(), run = { target: { kind: 'patch' as const, repo: 'allocator-one/rcl', prNumber: 105, headSha: f.plan.headSha, baseSha: f.plan.mergeBaseSha },
      roster: f.plan.roster.map(seat => ({ model: seat.model, role: seat.role, provider: seat.route, lane: 'blocking' as const })), spec: { source: 'flag' as const, sha256: f.plan.specSha256 } };
    const digest = retainedLaunchInputSha256(f.capture.digest, run);
    expect(digest).toBe(retainedLaunchInputSha256(f.capture.digest, structuredClone(run)));
    for (const changed of [{ ...run, target: { ...run.target, prNumber: 106 } }, { ...run, roster: [...run.roster].reverse() },
      { ...run, spec: { ...run.spec, sha256: 'c'.repeat(64) } }]) expect(retainedLaunchInputSha256(f.capture.digest, changed)).not.toBe(digest);
    expect(retainedLaunchInputSha256('c'.repeat(64), run)).not.toBe(digest);
  });
});

async function supplemented(options: { complete?: boolean; verified?: boolean } = {}) {
  const f = await retained({ seats: 1, verified: options.verified });
  const originalReport = f.reportBytes;
  const sourceJournal = await CheckpointJournal.inspectRead(f.checkpoint);
  const sourceProof = await exportCheckpointProof(sourceJournal);
  const successor = runId(20), startedAtMs = Date.now();
  let reportBytes = '';
  await guardReviewerRecoveryLaunch({ gitCommonDir: f.gitCommonDir, target: f.target,
    sourceRunId: f.id, successorRunId: successor, operationId: runId(30), headSha: f.currentHeadSha,
    inputSha256: retainedLaunchInputSha256(f.f.capture.digest, f.run), startedAtMs,
    expiresAtMs: startedAtMs + 60_000, maxAdditionalCalls: 2, maxAttemptsPerCell: 1,
    run: async ({ journal, operation, ownership }) => {
      for (const cell of f.f.plan.cells.filter(cell => cell.seat === 's1')) {
        if (options.complete === false && cell.chunk === 1) continue;
        const attempt = { id: `successor-${cell.id}`, kind: 'paid' as const };
        const review: ModelReview = { model: cell.model, role: cell.role, provider: cell.route,
          status: 'success', durationMs: 1, findings: [] };
        await journal.recordIntent(cell.id, attempt, ownership);
        await journal.recordResult(cell.id, attempt, { kind: 'success', chunk: cell.chunk,
          reviewBytes: JSON.stringify(review) }, ownership);
      }
      await journal.finalize(ownership);
      const proof = await exportCheckpointProof(journal);
      const projection = projectCheckpointReport({ sources: [{ runId: f.id, proof: sourceProof }],
        successor: { runId: successor, proof }, policy });
      const run = { ...f.run, id: successor, startedAt: new Date(startedAtMs),
        converge: { target: f.target, ...operation.successorNativeClaim! } };
      const assembly = { projection, supplementalAsync: emptyAsync(), diff: f.f.diff, startTime: startedAtMs, run };
      const gate = options.verified ? await executeCheckpointGating({ assembly, commonDir: f.gitCommonDir, ownership, journal,
        askFactory: () => async () => ({ model: 'google/gemini-3.8-flash', provider: 'google', status: 'success' as const, durationMs: 1, text: '[]' }),
        beforeLaunch: async () => {}, onLateAuditError: () => {}, nowMs: () => startedAtMs + 1, monotonicNow: () => 0 }) : undefined;
      const { report } = await assembleCheckpointReview(assembly, ...(gate?.verificationProof ? [{ verificationProof: gate.verificationProof }] : []));
      reportBytes = JSON.stringify(sanitizeForDelivery(report));
      const artifact = serializeReviewerArtifact({ assembly, reportBytes,
        representation: { version: 1, parseFailures: false }, ...(gate?.verificationProof ? { verificationProof: gate.verificationProof } : {}) });
      await journal.retainTerminalReport({ reportBytes, reviewerArtifactBytes: artifact.bytes }, ownership);
    } });
  return { ...f, reportBytes, originalReport, sourceJournal, successor };
}

describe('native admission of a supplemented retained report', () => {
  it('counts structural inherited verifier history without treating it as a new call or recovery authority', async () => {
    // Recovery launch correctly refuses conclusive sources. This synthetic local
    // lineage tests only forensic status accounting and confers no launch authority.
    const f = await retained({ verified: true }), successorId = runId(20);
    const source = await CheckpointJournal.inspectRead(f.checkpoint), sourceProof = await source.exportProof();
    const before = await nativeBytes(f);
    await withNativeTarget(f.gitCommonDir, f.target, async ownership => {
      const operation = createRecoveryOperation({ operationId: runId(30), successorRunId: successorId, sourceRunId: f.id,
        sourceReportSha256: sha256Hex(f.reportBytes), sourceCheckpointSha256: sourceProof.digest,
        capturedInputsSha256: f.f.capture.digest, planDigest: f.f.plan.digest, target: f.target,
        originalNativeClaim: { attempt: 1, round: 1 }, successorNativeClaim: { attempt: 2, round: 2 },
        startedAtMs: 2000, expiresAtMs: 62000, maxAdditionalCalls: 1, maxAttemptsPerCell: 1 });
      const journal = await CheckpointJournal.create({ commonDir: f.gitCommonDir, namespace: successorId, plan: f.f.plan, ownership });
      await journal.bind('captured-inputs', f.f.capture.bytes, ownership);
      await journal.bind('source', stableStringify({ run_id: f.id, report_sha256: sha256Hex(f.reportBytes), checkpoint_sha256: sourceProof.digest }), ownership);
      await journal.bind('operation', encodeRecoveryOperation(operation), ownership);
      await journal.finalize(ownership);
      const assembly = { projection: projectCheckpointReport({ sources: [{ runId: f.id, proof: sourceProof }],
        successor: { runId: successorId, proof: await journal.exportProof() }, policy }), supplementalAsync: emptyAsync(),
        diff: f.f.diff, startTime: 2000, run: { ...f.run, id: successorId, startedAt: new Date(2000),
          converge: { target: f.target, attempt: 2, round: 2 } } };
      const gate = await executeCheckpointGating({ assembly, commonDir: f.gitCommonDir, ownership, journal,
        askFactory: () => async () => ({ model: 'google/gemini-3.8-flash', provider: 'google', status: 'success' as const, durationMs: 1, text: '[]' }),
        beforeLaunch: async () => {}, onLateAuditError: () => {}, nowMs: () => 2001, monotonicNow: () => 0 });
      const reportBytes = JSON.stringify(sanitizeForDelivery((await assembleCheckpointReview(assembly, { verificationProof: gate.verificationProof })).report));
      const artifact = serializeReviewerArtifact({ assembly, reportBytes, representation: { version: 1, parseFailures: false }, verificationProof: gate.verificationProof });
      await journal.retainTerminalReport({ reportBytes, reviewerArtifactBytes: artifact.bytes }, ownership);
    });
    const status = await inspectReviewerStatus({ commonDir: f.gitCommonDir, target: f.target, runId: successorId });
    expect(status.attempts).toMatchObject({ physical: 4, newOnly: 0, verifier: {
      current: { intents: 1, uncertain: 0, status: 'complete' }, inherited: { intents: 1, uncertain: 0 } },
      reviewerAndVerifier: { physical: 6, newOnly: 1, uncertain: 0 } });
    expect(await nativeBytes(f)).toEqual(before);
    const original = CheckpointJournal.prototype.exportVerificationProof;
    const change = vi.spyOn(CheckpointJournal.prototype, 'exportVerificationProof').mockImplementation(async function() {
      const actual = await original.call(this);
      return (await this.exportProof()).digest === sourceProof.digest ? { ...actual, digest: 'f'.repeat(64) } : actual;
    });
    try {
      await expect(inspectReviewerStatus({ commonDir: f.gitCommonDir, target: f.target, runId: successorId }))
        .rejects.toThrow('reviewer_status_verification_mismatch');
      expect(await nativeBytes(f)).toEqual(before);
    } finally { change.mockRestore(); }
  });
  it('admits a second successor without losing the first successor chunk or the original finding', async () => {
    const f = await supplemented({ complete: false });
    const source = await loadReviewerLineage({ commonDir: f.gitCommonDir, target: f.target, runId: f.successor });
    const sourceReports = source.runs.map(entry => entry.terminal.reportBytes);
    const startedAtMs = Date.now(), id = runId(40);
    let reportBytes = '';
    await guardReviewerRecoveryLaunch({ gitCommonDir: f.gitCommonDir, target: f.target,
      sourceRunId: f.successor, successorRunId: id, operationId: runId(50), headSha: f.currentHeadSha,
      inputSha256: retainedLaunchInputSha256(f.f.capture.digest, f.run), startedAtMs,
      expiresAtMs: startedAtMs + 60_000, maxAdditionalCalls: 1, maxAttemptsPerCell: 1,
      run: async ({ journal, operation, ownership }) => {
        const cell = f.f.plan.cells.find(cell => cell.seat === 's1' && cell.chunk === 1)!;
        const attempt = { id: 'second-successor-only-missing-chunk', kind: 'paid' as const };
        const review: ModelReview = { model: cell.model, role: cell.role, provider: cell.route,
          status: 'success', durationMs: 1, findings: [] };
        await journal.recordIntent(cell.id, attempt, ownership);
        await journal.recordResult(cell.id, attempt, { kind: 'success', chunk: cell.chunk,
          reviewBytes: JSON.stringify(review) }, ownership);
        await journal.finalize(ownership);
        const projection = projectCheckpointReport({ sources: source.runs.map(entry => ({ runId: entry.runId, proof: entry.proof })),
          successor: { runId: id, proof: await exportCheckpointProof(journal) }, policy });
        const assembly = { projection, supplementalAsync: source.latest.inspected.supplementalAsync,
          diff: f.f.diff, startTime: startedAtMs, run: { ...f.run, id, startedAt: new Date(startedAtMs),
            converge: { target: f.target, ...operation.successorNativeClaim! } } };
        reportBytes = JSON.stringify(sanitizeForDelivery((await assembleCheckpointReview(assembly)).report));
        const artifact = serializeReviewerArtifact({ assembly, reportBytes, representation: { version: 1, parseFailures: false } });
        await journal.retainTerminalReport({ reportBytes, reviewerArtifactBytes: artifact.bytes }, ownership);
      } });
    const attempts = (await nativeBytes(f))[1];
    const admitted = await processSupplementedRoundReport({ ...f, reportBytes });
    expect(admitted.findings).toHaveLength(1);
    expect(admitted.findings[0]!.finding.description).toBe('An unrelated tenant can read this record.');
    const combined = await loadReviewerLineage({ commonDir: f.gitCommonDir, target: f.target, runId: id });
    expect(combined.runs).toHaveLength(3);
    expect(combined.runs.slice(0, 2).map(entry => entry.terminal.reportBytes)).toEqual(sourceReports);
    expect(combined.latest.state.successes).toHaveLength(1);
    expect(combined.latest.inspected.artifact.health.successfulSeats).toHaveLength(2);
    expect((await loadConvergeRunState(f.gitCommonDir, f.target))!.rounds).toMatchObject([{ round: 1, runId: id }]);
    expect((await nativeBytes(f))[1]).toEqual(attempts);
    expect(await loadConvergeAttemptState(f.gitCommonDir, f.target)).toMatchObject({ attemptsUsed: 3, cap: 3 });
  });

  it('admits the same unadmitted round once, preserves original findings and spends no further attempt', async () => {
    const f = await supplemented(), beforeAttempts = (await nativeBytes(f))[1];
    const sourceBefore = await f.sourceJournal.readTerminalReport();
    const first = await processSupplementedRoundReport(f);
    expect(first.findings).toHaveLength(1);
    expect(first.findings[0]!.finding.description).toBe('An unrelated tenant can read this record.');
    const state = (await loadConvergeRunState(f.gitCommonDir, f.target))!;
    expect(state.rounds.map(({ round, runId }) => ({ round, runId }))).toEqual([{ round: 1, runId: f.successor }]);
    expect(resolveRoundResolution(state, 1)!.status).toBe('unresolved');
    expect(await processSupplementedRoundReport(f)).toEqual(first);
    expect((await loadConvergeRunState(f.gitCommonDir, f.target))!.rounds).toHaveLength(1);
    expect((await nativeBytes(f))[1]).toEqual(beforeAttempts);
    expect(await f.sourceJournal.readTerminalReport()).toEqual(sourceBefore);
    expect(sourceBefore!.reportBytes).toBe(f.originalReport);
    expect(await loadConvergeAttemptState(f.gitCommonDir, f.target)).toMatchObject({ attemptsUsed: 2, cap: 3 });
  });

  it('refuses a still-incomplete chunked seat without admitting or changing accounting', async () => {
    const f = await supplemented({ complete: false }), before = await nativeBytes(f);
    await expect(processSupplementedRoundReport(f)).rejects.toThrow('supplemented_report_inconclusive_health');
    expect(await nativeBytes(f)).toEqual(before);
  });

  it('refuses a round already bound to another run', async () => {
    const f = await supplemented();
    await alterState(f, state => { state.rounds.push({ round: 1, runId: f.id,
      counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } }); });
    const before = await nativeBytes(f);
    await expect(processSupplementedRoundReport(f)).rejects.toThrow('supplemented_report_round_already_bound');
    expect(await nativeBytes(f)).toEqual(before);
  });

  it.each(['operation', 'source', 'root', 'health', 'report', 'claim'])('refuses a mismatched native %s binding', async kind => {
    const f = await supplemented();
    await alterState(f, state => {
      if (kind === 'operation') state.lastLaunch.recovery.operationId = runId(90);
      if (kind === 'source') state.lastLaunch.recovery.sourceRunId = runId(90);
      if (kind === 'root') state.lastLaunch.recovery.originalNativeClaim.attempt = 2;
      if (kind === 'health') state.lastLaunch.reviewerHealth.successfulSeats = 3;
      if (kind === 'report') state.lastLaunch.reportJsonSha256 = 'c'.repeat(64);
      if (kind === 'claim') state.lastLaunch.recovery.sourceNativeClaim.attempt = 2;
    });
    const before = await nativeBytes(f);
    await expect(processSupplementedRoundReport(f)).rejects.toThrow('supplemented_report_native_launch_mismatch');
    expect(await nativeBytes(f)).toEqual(before);
  });

  it('requires the exact ordinary bytes and current head and rejects stale ownership', async () => {
    const f = await supplemented(); let ownership!: NativeTargetOwnership;
    await withNativeTarget(f.gitCommonDir, f.target, async value => { ownership = value; });
    const before = await nativeBytes(f);
    await expect(processSupplementedRoundReport({ ...f, reportBytes: f.reportBytes + '\n' })).rejects.toThrow('supplemented_report_terminal_mismatch');
    await expect(processSupplementedRoundReport({ ...f, currentHeadSha: 'c'.repeat(40) })).rejects.toThrow('supplemented_report_head_mismatch');
    await expect(processSupplementedRoundReport({ ...f, ownership })).rejects.toThrow('native_target_not_owned');
    expect(await nativeBytes(f)).toEqual(before);
  });

  it('admits a successor with structurally replayed sealed verifier evidence', async () => {
    const f = await supplemented({ verified: true });
    expect((await processSupplementedRoundReport(f)).findings).toHaveLength(1);
    const status = await inspectReviewerStatus({ commonDir: f.gitCommonDir, target: f.target, runId: f.successor });
    expect(status.attempts).toMatchObject({ physical: 4, newOnly: 2, verifier: { current: { intents: 1, status: 'complete' }, inherited: { intents: 0, uncertain: 0 } }, reviewerAndVerifier: { physical: 5, newOnly: 3, uncertain: 0 } });
  });
});


describe('proof-bound native intake routing', () => {
  it('admits an original through the same entry point used by converge-report', async () => {
    const f = await retained();
    const result = await retainedReports.processReviewerRoundReport(f);
    expect(result.findings[0]!.finding.severity).toBe('critical');
    expect((await loadConvergeRunState(f.gitCommonDir, f.target))!.rounds[0]!.runId).toBe(f.id);
  });

  it('admits a supplemented report through that entry point and replays without another claim', async () => {
    const f = await supplemented(), before = await loadConvergeAttemptState(f.gitCommonDir, f.target);
    await retainedReports.processReviewerRoundReport(f);
    await retainedReports.processReviewerRoundReport(f);
    expect((await loadConvergeRunState(f.gitCommonDir, f.target))!.rounds).toHaveLength(1);
    expect((await loadConvergeRunState(f.gitCommonDir, f.target))!.rounds[0]!.runId).toBe(f.successor);
    expect(await loadConvergeAttemptState(f.gitCommonDir, f.target)).toEqual(before);
    expect((await f.sourceJournal.readTerminalReport())!.reportBytes).toBe(f.originalReport);
  });

  it('cannot route a successor around its proof by claiming an original ordinary kind', async () => {
    const f = await supplemented(), report = JSON.parse(f.reportBytes), before = await nativeBytes(f);
    report.run.reviewer_evidence = { version: 1, kind: 'original' };
    await expect(retainedReports.processReviewerRoundReport({ ...f, reportBytes: JSON.stringify(report) }))
      .rejects.toThrow('supplemented_report_terminal_mismatch');
    expect(await nativeBytes(f)).toEqual(before);
  });
});
