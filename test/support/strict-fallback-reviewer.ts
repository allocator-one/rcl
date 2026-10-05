import type { Config } from '../../src/config/schema.js';
import type { Finding, ModelReview } from '../../src/consensus/types.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, exportCheckpointProof, freezeCheckpointPlan, type CheckpointResult } from '../../src/dispatch/checkpoint.js';
import { captureReviewerInputs } from '../../src/dispatch/captured-inputs.js';
import { createOriginalLaunch, encodeOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { captureAggregationInputs } from '../../src/report/aggregation-inputs.js';
import { assembleCheckpointReview, deriveCheckpointConsensus } from '../../src/report/checkpoint-assembly.js';
import { projectCheckpointReport } from '../../src/report/checkpoint-projection.js';
import { serializeReviewerArtifact } from '../../src/report/reviewer-artifact.js';
import { describeReviewerEvidence } from '../../src/report/reviewer-evidence.js';
import { captureSupplementalAsync } from '../../src/report/supplemental-async.js';
import { configDigest, diffDigest, sha256Hex, stableStringify } from '../../src/report/run-header.js';
import { planGating } from '../../src/consensus/gating.js';
import { sanitizeForDelivery } from '../../src/telemetry/envelope.js';
import { toMarkdown } from '../../src/output/markdown.js';

const runId = '00000000-0000-4000-8000-000000000159';
const role = { name: 'general', systemPrompt: 'Review.', focus: [], description: 'General', isSpecialized: false };
const policy = { version: 1 as const, fraction: 2 / 3 };
const thresholds = { minConsensusScore: 0, minConfidence: 0, dedupeLineWindow: 5, jaccardThreshold: 0.3 };

/** A compact, fully authenticated strict-fallback artifact for delivery tests. */
export async function strictFallbackReviewerFixture(commonDir: string, terminal: 'failed' | 'complete' = 'failed') {
  const finding: Finding = { id: 'F1', file: 'tenant.ts', startLine: 1, endLine: 1,
    severity: 'important', category: 'security', title: 'Missing tenant isolation',
    description: 'An unrelated tenant can read this record.' };
  const diff = { source: 'local' as const, files: [{ filename: 'tenant.ts', status: 'modified' as const,
    patch: '@@ -1 +1 @@\n-old\n+new\n', additions: 1, deletions: 1, language: 'typescript' }] };
  const patchBytes = stableStringify(diff.files.map(file => ({ filename: file.filename, status: file.status,
    previousFilename: null, patch: file.patch, additions: file.additions, deletions: file.deletions, blobSha: null })));
  const config: Config = { quorumFraction: policy.fraction, thresholds, output: { belowThresholdAppendix: true } };
  const configBytes = stableStringify(config), specBytes = 'Exact spec', contextBytes = '[]';
  const toolsBytes = stableStringify({ parser: { name: 'findings-json', version: 1 }, aggregation: { name: 'consensus', version: 2 } });
  const models = ['model-a', 'model-b', 'model-c'];
  const plan = freezeCheckpointPlan({ target: 'rcl-159', headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40),
    patchSha256: diffDigest(diff.files), configSha256: configDigest(config), specSha256: sha256Hex(specBytes),
    contextSha256: sha256Hex(contextBytes), toolsSha256: sha256Hex(toolsBytes),
    parser: { name: 'findings-json', version: 1 },
    roster: models.map((model, index) => ({ seat: `s${index}`, model, role: role.name, route: 'fake' })),
    chunks: [{ index: 0, total: 1, digest: sha256Hex('chunk 0') }],
    prompts: models.map((_, seat) => ({ seat: `s${seat}`, chunk: 0,
      systemSha256: sha256Hex('system'), userSha256: sha256Hex('prompt 0') })),
  });
  const aggregation = captureAggregationInputs({ algorithm: { name: 'consensus', version: 2 },
    diffSha256: plan.patchSha256, roleMap: new Map([[role.name, role]]), thresholds,
    gating: { mode: 'verified-consensus', minModels: 2, verificationModel: 'google/gemini-3.8-flash',
      verificationTimeoutMs: 100, verificationPassTimeoutMs: 100 },
    modelWeights: new Map([[models[0]!, 0.75]]), belowThresholdAppendix: true });
  const captured = captureReviewerInputs({ plan, policy, patchBytes, configBytes, specBytes, contextBytes,
    toolsBytes, chunkBytes: ['chunk 0'], aggregation,
    assignments: plan.cells.map(cell => ({ model: cell.model, provider: cell.route, role })),
    prompts: plan.cells.map(() => ({ systemPrompt: 'system', userPrompt: 'prompt 0' })) });
  const launch = createOriginalLaunch({ runId, target: plan.target, originalNativeClaim: { attempt: 1, round: 1 },
    capturedInputsSha256: captured.digest, planDigest: plan.digest, startedAtMs: 1, expiresAtMs: 1_000,
    maxPhysicalCalls: 3, maxAttemptsPerCell: 1 });

  let journal!: CheckpointJournal;
  await withNativeTarget(commonDir, plan.target, async ownership => {
    journal = await CheckpointJournal.create({ commonDir, namespace: runId, plan, ownership });
    await journal.bind('captured-inputs', captured.bytes, ownership);
    await journal.bind('launch', encodeOriginalLaunch(launch), ownership);
    for (const cell of plan.cells.filter(item => item.seat !== 's2')) {
      const attempt = { id: `review-${cell.id}`, kind: 'paid' as const };
      const review: ModelReview = { model: cell.model, role: cell.role, provider: cell.route, durationMs: 1,
        findings: cell.seat === 's0' ? [finding] : [], status: 'success' };
      const result: CheckpointResult = { kind: 'success', chunk: cell.chunk, reviewBytes: JSON.stringify(review) };
      await journal.recordIntent(cell.id, attempt, ownership);
      await journal.recordResult(cell.id, attempt, result, ownership);
    }
    await journal.finalize(ownership);
  });
  const checkpoint = await exportCheckpointProof(journal);
  const projection = projectCheckpointReport({ sources: [], successor: { runId, proof: checkpoint }, policy });
  const startedAt = Date.now();
  const assembly = { projection, supplementalAsync: captureSupplementalAsync([], 0), diff, startTime: startedAt,
    run: { id: runId, rclVersion: '4.4.14', command: 'review' as const,
      target: { kind: 'pr' as const, repo: 'allocator-one/rcl', prNumber: 159,
        headSha: plan.headSha, baseSha: plan.mergeBaseSha },
      roster: plan.roster.map(seat => ({ model: seat.model, role: seat.role, provider: seat.route, lane: 'blocking' as const })),
      spec: { source: 'flag' as const, sha256: plan.specSha256 }, contextFiles: [],
      runner: { kind: 'agent' as const }, startedAt: new Date(startedAt),
      converge: { target: plan.target, round: 1, attempt: 1 } } };
  const consensus = deriveCheckpointConsensus(assembly).consensus;
  const verificationPlan = planGating(consensus.reportFindings, { minModels: aggregation.gating.minModels,
    verificationModel: aggregation.gating.verificationModel!, verificationTimeoutMs: 100,
    verificationPassTimeoutMs: 100, diffFiles: diff.files,
    modelWeights: new Map(aggregation.modelWeights!.map(row => [row.model, row.weight])) });
  await withNativeTarget(commonDir, plan.target, async ownership => {
    await journal.beginVerification({ runId, gatingPlanBytes: stableStringify(verificationPlan),
      model: verificationPlan.model, provider: 'google',
      batches: verificationPlan.batches.map(({ systemPrompt, userPrompt }) => ({ systemPrompt, userPrompt })),
      startedAtMs: 2, expiresAtMs: 102, verificationTimeoutMs: 100, verificationPassTimeoutMs: 100,
      maxPhysicalCalls: verificationPlan.batches.length }, ownership);
    if (terminal === 'complete') {
      for (const [batchIndex] of verificationPlan.batches.entries()) {
        await journal.recordVerificationIntent({ batchIndex, attemptId: `verify-${batchIndex}`, startedAtMs: 3 }, ownership);
        await journal.recordVerificationResult({ batchIndex, attemptId: `verify-${batchIndex}`, finishedAtMs: 4,
          answerBytes: JSON.stringify({ model: verificationPlan.model, provider: 'google', status: 'success',
            durationMs: 1, text: '[{"id":"F1","verdict":"unrefuted"}]' }) }, ownership);
      }
      await journal.finalizeVerification({ status: 'complete', finishedAtMs: 5 }, ownership);
    } else {
      await journal.finalizeVerification({ status: 'failed', finishedAtMs: 5,
        reason: 'verification_execution_deadline' }, ownership);
    }
  });
  const verificationProof = await journal.exportVerificationProof();
  const assembled = await assembleCheckpointReview(assembly, { verificationProof });
  const report = { ...assembled.report, run: { ...assembled.report.run,
    reviewer_evidence: describeReviewerEvidence(checkpoint, assembly.supplementalAsync) } };
  const reportBytes = JSON.stringify(sanitizeForDelivery(report, { version: 1, parseFailures: false }));
  const artifact = serializeReviewerArtifact({ assembly, reportBytes,
    representation: { version: 1, parseFailures: false }, verificationProof });
  await withNativeTarget(commonDir, plan.target, async ownership => {
    await journal.retainTerminalReport({ reportBytes, reviewerArtifactBytes: artifact.bytes }, ownership);
  });
  const result = JSON.parse(reportBytes);
  return { runId, result, artifacts: { report_json: reportBytes,
    report_md: toMarkdown(result) }, artifact, verificationProof };
}
