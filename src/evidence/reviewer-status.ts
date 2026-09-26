import { decodeCapturedInputs } from '../dispatch/captured-inputs.js';
import { CheckpointJournal, checkpointPath, exportCheckpointProof, type CheckpointState, type FrozenCheckpointPlan } from '../dispatch/checkpoint.js';
import { decodeOriginalLaunch, remainingOriginalBudget, type OriginalBudget } from '../dispatch/original-launch.js';
import { classifyMissingReview, previewReviewerRecovery, type RecoveryPreview } from '../dispatch/recovery-policy.js';
import { resolveQuorumPolicy } from '../dispatch/quorum.js';
import { MAX_TIMER_DELAY_MS } from '../config/schema.js';
import { recoveryAttemptsFromCheckpoint } from '../dispatch/recovery.js';
import { decodeRecoveryOperation, remainingRecoveryBudget, type RecoveryBudget } from '../dispatch/recovery-operation.js';
import { stableStringify } from '../report/run-header.js';
import { deriveReviewerHealth } from '../report/reviewer-health.js';
import { inspectReviewerArtifact } from '../report/reviewer-artifact.js';
import { UUID } from '../telemetry/recovery/source.js';
import { loadReviewerLineage } from './reviewer-lineage.js';

const MAX_LINEAGE_DEPTH = 32;

export interface InspectReviewerStatusInput {
  commonDir: string;
  target: string;
  runId: string;
  nowMs?: number;
}

export interface ReviewerSeatStatus {
  seat: string;
  model: string;
  role: string;
  route: string;
  completedChunks: number[];
  missingChunks: number[];
  complete: boolean;
}

export interface ReviewerStatus {
  version: 1;
  scope: 'local_structural_status_only';
  authorization: 'not_recovery_authorization_or_server_approval';
  target: string;
  runId: string;
  kind: 'original' | 'successor';
  plan: { digest: string; headSha: string; mergeBaseSha: string; patchSha256: string };
  health: {
    successfulSeats: number;
    minimumSuccessful: number;
    successesNeeded: number;
    conclusive: boolean;
    seats: ReviewerSeatStatus[];
  };
  attempts: {
    physical: number;
    newOnly: number;
    uncertain: number;
    failures: Array<{ classification: string; count: number }>;
    verifier: {
      current: { intents: number; uncertain: number; status: 'absent' | 'open' | 'complete' | 'failed';
        maxPhysicalCalls?: number; expiresAtMs?: number; remainingMs?: number };
      inherited: { intents: number; uncertain: number };
    };
    /** Async has no complete intent ledger here and is explicitly excluded. */
    reviewerAndVerifier: { physical: number; newOnly: number; uncertain: number };
  };
  budget: OriginalBudget | RecoveryBudget;
  finalized: boolean;
  terminalArtifact: { available: boolean };
  lineage: Array<{
    runId: string;
    kind: 'original' | 'successor';
    reportSha256?: string;
    checkpointSha256?: string;
    capturedInputsSha256: string;
  }>;
}

type DecodedRun = {
  journal: CheckpointJournal;
  state: CheckpointState;
  plan: FrozenCheckpointPlan;
  captureDigest: string;
  kind: 'original' | 'successor';
  budget: OriginalBudget | RecoveryBudget;
  source?: { runId: string; reportSha256: string; checkpointSha256: string };
};

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function requireInput(input: InspectReviewerStatusInput): Required<InspectReviewerStatusInput> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.commonDir !== 'string' ||
    !input.commonDir || typeof input.target !== 'string' || !input.target || typeof input.runId !== 'string' ||
    !UUID.test(input.runId)) throw new Error('reviewer_status_invalid_input');
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('reviewer_status_invalid_now');
  return { commonDir: input.commonDir, target: input.target, runId: input.runId, nowMs };
}

function sameRun(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }

function decodeSource(bytes: string): { runId: string; reportSha256: string; checkpointSha256: string } {
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new Error('reviewer_status_invalid_source_binding'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || stableStringify(value) !== bytes) {
    throw new Error('reviewer_status_invalid_source_binding');
  }
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== 3 || typeof source.run_id !== 'string' || !UUID.test(source.run_id) ||
    typeof source.report_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.report_sha256) ||
    typeof source.checkpoint_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.checkpoint_sha256)) {
    throw new Error('reviewer_status_invalid_source_binding');
  }
  return { runId: source.run_id, reportSha256: source.report_sha256, checkpointSha256: source.checkpoint_sha256 };
}

async function decodeRun(commonDir: string, target: string, runId: string, nowMs: number): Promise<DecodedRun> {
  const journal = await CheckpointJournal.inspectRead(checkpointPath(commonDir, target, runId));
  const plan = journal.getPlan();
  if (plan.target !== target) throw new Error('reviewer_status_target_mismatch');
  const [state, bindings] = await Promise.all([journal.read(), journal.readBindings()]);
  const captureBytes = bindings['captured-inputs'];
  if (captureBytes === undefined) throw new Error('reviewer_status_missing_capture: legacy journal cannot be inspected; retain captured inputs and launch descriptor');
  const captured = decodeCapturedInputs(captureBytes, plan);
  const launchBytes = bindings.launch, sourceBytes = bindings.source, operationBytes = bindings.operation;
  if (launchBytes !== undefined && (sourceBytes !== undefined || operationBytes !== undefined)) throw new Error('reviewer_status_mixed_bindings');
  if (launchBytes !== undefined) {
    const launch = decodeOriginalLaunch(launchBytes);
    if (!sameRun(launch.runId, runId) || launch.target !== target || launch.planDigest !== plan.digest || launch.capturedInputsSha256 !== captured.digest) {
      throw new Error('reviewer_status_launch_mismatch');
    }
    return { journal, state, plan, captureDigest: captured.digest, kind: 'original', budget: remainingOriginalBudget(launch, nowMs) };
  }
  if (sourceBytes === undefined || operationBytes === undefined) {
    throw new Error('reviewer_status_missing_launch: legacy journal cannot be inspected; retain original launch or successor operation bindings');
  }
  const operation = decodeRecoveryOperation(operationBytes), source = decodeSource(sourceBytes);
  if (!sameRun(operation.successorRunId, runId) || operation.target !== target || operation.planDigest !== plan.digest ||
    operation.capturedInputsSha256 !== captured.digest || !sameRun(source.runId, operation.sourceRunId) ||
    source.reportSha256 !== operation.sourceReportSha256 || source.checkpointSha256 !== operation.sourceCheckpointSha256) {
    throw new Error('reviewer_status_operation_mismatch');
  }
  return { journal, state, plan, captureDigest: captured.digest, kind: 'successor', budget: remainingRecoveryBudget(operation, nowMs), source };
}

function seatStatus(plan: FrozenCheckpointPlan, state: CheckpointState, fraction: number): ReviewerStatus['health'] {
  const successful = new Set(state.successes.map(item => item.cell));
  const selected = state.successes.map(item => ({ cell: item.cell, review: JSON.parse(item.reviewBytes) }));
  const health = deriveReviewerHealth(plan, selected, { version: 1, fraction });
  const seats = plan.roster.map(seat => {
    const cells = plan.cells.filter(cell => cell.seat === seat.seat);
    const completedChunks = cells.filter(cell => successful.has(cell.id)).map(cell => cell.chunk).sort((a, b) => a - b);
    const missingChunks = cells.filter(cell => !successful.has(cell.id)).map(cell => cell.chunk).sort((a, b) => a - b);
    return { ...seat, completedChunks, missingChunks, complete: missingChunks.length === 0 };
  });
  return { successfulSeats: health.successfulSeats.length, minimumSuccessful: health.policy.minimumSuccessful,
    successesNeeded: Math.max(0, health.policy.minimumSuccessful - health.successfulSeats.length), conclusive: health.conclusive, seats };
}

async function assertTerminalVerification(journal: CheckpointJournal, expected: { bytes: string; digest: string } | undefined): Promise<void> {
  const phase = await journal.readVerification();
  if ((phase !== undefined) !== (expected !== undefined)) throw new Error('reviewer_status_verification_mismatch');
  if (phase !== undefined) {
    const proof = await journal.exportVerificationProof();
    if (proof.bytes !== expected!.bytes || proof.digest !== expected!.digest) throw new Error('reviewer_status_verification_mismatch');
  }
}

async function verifierAttempts(runs: readonly DecodedRun[], nowMs: number): Promise<ReviewerStatus['attempts']['verifier']> {
  const rows = await Promise.all(runs.map(async run => {
    const phase = await run.journal.readVerification();
    if (phase === undefined) return { intents: 0, uncertain: 0, status: 'absent' as const };
    if (phase.terminal) await run.journal.exportVerificationProof();
    return { intents: phase.intents.length, uncertain: phase.uncertain.length,
      status: phase.terminal?.status ?? 'open' as const,
      maxPhysicalCalls: phase.plan.maxPhysicalCalls, expiresAtMs: phase.plan.expiresAtMs,
      remainingMs: phase.terminal ? 0 : Math.max(0, phase.plan.expiresAtMs - nowMs) };
  }));
  const current = rows.at(-1)!;
  const inherited = rows.slice(0, -1).reduce((sum, row) => ({
    intents: sum.intents + row.intents, uncertain: sum.uncertain + row.uncertain,
  }), { intents: 0, uncertain: 0 });
  return { current, inherited };
}

function attempts(states: readonly CheckpointState[], selected: CheckpointState, verifier: Awaited<ReturnType<typeof verifierAttempts>>): ReviewerStatus['attempts'] {
  const entries = states.flatMap(state => recoveryAttemptsFromCheckpoint(state));
  const selectedEntries = recoveryAttemptsFromCheckpoint(selected);
  const failures = new Map<string, number>();
  for (const entry of entries) {
    if (entry.outcome?.status === 'success') continue;
    const classification = entry.outcome === undefined ? 'uncertain_outcome' : classifyMissingReview(entry.outcome).reason;
    failures.set(classification, (failures.get(classification) ?? 0) + 1);
  }
  const uncertain = states.reduce((sum, state) => sum + state.uncertain.length, 0);
  return { physical: entries.length, newOnly: selectedEntries.length, uncertain, verifier,
    reviewerAndVerifier: { physical: entries.length + verifier.inherited.intents + verifier.current.intents,
      newOnly: selectedEntries.length + verifier.current.intents,
      uncertain: uncertain + verifier.inherited.uncertain + verifier.current.uncertain },
    failures: [...failures.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([classification, count]) => ({ classification, count })) };
}

async function sourceLineage(
  commonDir: string, target: string, initial: DecodedRun, initialRunId: string, nowMs: number,
): Promise<{ lineage: ReviewerStatus['lineage']; runs: DecodedRun[] }> {
  const chain: ReviewerStatus['lineage'] = [];
  const runs: DecodedRun[] = [];
  const seen = new Set<string>();
  let run = initial, runId = initialRunId;
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
    const key = runId.toLowerCase();
    if (seen.has(key)) throw new Error('reviewer_status_lineage_cycle');
    seen.add(key);
    let checkpointSha256: string | undefined, reportSha256: string | undefined;
    if (run.state.finalized) checkpointSha256 = (await exportCheckpointProof(run.journal)).digest;
    const terminal = await run.journal.readTerminalReport();
    if (terminal) reportSha256 = terminal.reportSha256;
    chain.unshift({ runId, kind: run.kind, ...(reportSha256 ? { reportSha256 } : {}),
      ...(checkpointSha256 ? { checkpointSha256 } : {}), capturedInputsSha256: run.captureDigest });
    runs.unshift(run);
    if (run.kind === 'original') return { lineage: chain, runs };
    const source = run.source!;
    const sourceRun = await decodeRun(commonDir, target, source.runId, nowMs);
    if (!sourceRun.state.finalized) throw new Error('reviewer_status_unsealed_source');
    const sourceProof = await exportCheckpointProof(sourceRun.journal);
    const sourceTerminal = await sourceRun.journal.readTerminalReport();
    if (!sourceTerminal || sourceProof.digest !== source.checkpointSha256 || sourceTerminal.reportSha256 !== source.reportSha256 ||
      sourceRun.captureDigest !== run.captureDigest) throw new Error('reviewer_status_source_binding_mismatch');
    const inspected = inspectReviewerArtifact(sourceTerminal.reviewerArtifactBytes, {
      expectedReportBytes: sourceTerminal.reportBytes,
      expectedRunId: source.runId,
      expectedTarget: target,
      expectedPlan: sourceRun.plan,
    });
    if (!sameRun(inspected.runId, source.runId) || inspected.reportSha256 !== source.reportSha256 || inspected.proof.digest !== source.checkpointSha256 ||
      inspected.captured.digest !== sourceRun.captureDigest) throw new Error('reviewer_status_source_report_mismatch');
    await assertTerminalVerification(sourceRun.journal, inspected.verificationProof);
    run = sourceRun; runId = source.runId;
  }
  throw new Error('reviewer_status_lineage_depth');
}

function chainedState(runs: readonly Pick<DecodedRun, 'state'>[]): CheckpointState {
  const successes: CheckpointState['successes'] = [], outcomes: CheckpointState['outcomes'] = [], records: CheckpointState['records'] = [], uncertain: CheckpointState['uncertain'] = [];
  const successfulCells = new Set<string>(), pendingCells = new Set<string>(), attempts = new Set<string>();
  for (const run of runs) {
    for (const entry of recoveryAttemptsFromCheckpoint(run.state)) {
      if (attempts.has(entry.id)) throw new Error('reviewer_status_duplicate_attempt');
      attempts.add(entry.id);
      if (successfulCells.has(entry.cell)) throw new Error('reviewer_status_success_resampled');
      if (pendingCells.has(entry.cell)) throw new Error('reviewer_status_uncertain_resampled');
      if (entry.outcome === undefined) pendingCells.add(entry.cell);
    }
    for (const success of run.state.successes) {
      if (successfulCells.has(success.cell)) throw new Error('reviewer_status_duplicate_success');
      successfulCells.add(success.cell); successes.push(success);
    }
    outcomes.push(...run.state.outcomes); records.push(...run.state.records); uncertain.push(...run.state.uncertain);
  }
  return { records, outcomes, successes, uncertain, finalized: runs.at(-1)!.state.finalized };
}

/**
 * Inspects only the exact local checkpoint path for one run. It validates local
 * persistence and explicit successor links; it does not authorize recovery or
 * establish a server/native approval.
 */
export async function inspectReviewerStatus(input: InspectReviewerStatusInput): Promise<ReviewerStatus> {
  const request = requireInput(input);
  const run = await decodeRun(request.commonDir, request.target, request.runId, request.nowMs);
  const capture = decodeCapturedInputs((await run.journal.readBindings())['captured-inputs']!, run.plan);
  const [terminal, chain] = await Promise.all([run.journal.readTerminalReport(),
    sourceLineage(request.commonDir, request.target, run, request.runId, request.nowMs)]);
  if (terminal) {
    const inspected = inspectReviewerArtifact(terminal.reviewerArtifactBytes, { expectedReportBytes: terminal.reportBytes,
      expectedRunId: request.runId, expectedTarget: request.target, expectedPlan: run.plan });
    await assertTerminalVerification(run.journal, inspected.verificationProof);
  }
  const terminalArtifact = { available: terminal !== undefined };
  const merged = chainedState(chain.runs);
  const verifier = await verifierAttempts(chain.runs, request.nowMs);
  const health = seatStatus(run.plan, merged, capture.policy.fraction);
  return freeze({ version: 1 as const, scope: 'local_structural_status_only' as const,
    authorization: 'not_recovery_authorization_or_server_approval' as const, target: request.target, runId: request.runId,
    kind: run.kind, plan: { digest: run.plan.digest, headSha: run.plan.headSha, mergeBaseSha: run.plan.mergeBaseSha, patchSha256: run.plan.patchSha256 },
    health, attempts: attempts(chain.runs.map(item => item.state), run.state, verifier), budget: run.budget, finalized: run.state.finalized, terminalArtifact, lineage: chain.lineage });
}

/** Plain local summary; it deliberately excludes prompts, results, errors and credentials. */
export function formatReviewerStatus(status: ReviewerStatus): string {
  return `${status.target} run ${status.runId}: ${status.health.successfulSeats}/${status.health.minimumSuccessful} complete seats; ` +
    `${status.attempts.physical} reviewer calls (${status.attempts.uncertain} uncertain); ` +
    `${status.attempts.verifier.current.intents} current verifier calls; ` +
    `${status.attempts.reviewerAndVerifier.physical} reviewer-plus-verifier calls (async calls excluded); ` +
    `${status.finalized ? 'finalized' : 'open'}; terminal artifact ${status.terminalArtifact.available ? 'available' : 'unavailable'}.`;
}


export interface InspectReviewerRecoveryPreviewInput extends InspectReviewerStatusInput {
  maxAdditionalCalls: number;
  maxAttemptsPerCell: number;
  timeBudgetMs: number;
}

export interface ReviewerRecoveryPreview {
  version: 1;
  scope: 'local_structural_preview_only';
  authorization: 'not_recovery_authorization_or_server_approval';
  target: string;
  runId: string;
  source: { reportSha256: string; checkpointSha256: string; capturedInputsSha256: string; planDigest: string };
  proposedBudget: { maxAdditionalCalls: number; maxAttemptsPerCell: number; timeBudgetMs: number };
  recovery: RecoveryPreview;
  eligibleAssignments: Array<{ cell: string; seat: string; chunk: number; model: string; role: string; route: string }>;
}

/**
 * Read-only proposal for a new successor. The proposed time budget is not a
 * renewed operation deadline. Native ownership, current input identity, spent
 * attempts and producer authority must be checked by the guarded launch.
 */
export async function inspectReviewerRecoveryPreview(input: InspectReviewerRecoveryPreviewInput): Promise<ReviewerRecoveryPreview> {
  const request = requireInput(input);
  const proposedBudget = { maxAdditionalCalls: input.maxAdditionalCalls, maxAttemptsPerCell: input.maxAttemptsPerCell, timeBudgetMs: input.timeBudgetMs };
  if (![proposedBudget.maxAdditionalCalls, proposedBudget.maxAttemptsPerCell].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000) ||
    !Number.isSafeInteger(proposedBudget.timeBudgetMs) || proposedBudget.timeBudgetMs < 1 || proposedBudget.timeBudgetMs > MAX_TIMER_DELAY_MS) {
    throw new Error('reviewer_preview_invalid_budget');
  }
  const chain = await loadReviewerLineage({ commonDir: request.commonDir, target: request.target, runId: request.runId });
  const run = chain.latest;
  const inspected = run.inspected;
  const proof = run.proof;
  const merged = chainedState(chain.runs);
  const attempts = chain.attempts;
  const policy = resolveQuorumPolicy(run.plan.roster.length, inspected.captured.policy.fraction);
  const recovery = previewReviewerRecovery(run.plan.cells, attempts, policy, {
    ...proposedBudget, additionalCallsUsed: 0, remainingMs: proposedBudget.timeBudgetMs,
  });
  const health = seatStatus(run.plan, merged, inspected.captured.policy.fraction);
  if (health.successfulSeats !== inspected.artifact.health.successfulSeats.length || health.minimumSuccessful !== inspected.artifact.health.policy.minimumSuccessful ||
    health.conclusive !== inspected.artifact.health.conclusive) throw new Error('reviewer_preview_health_mismatch');
  return freeze({ version: 1, scope: 'local_structural_preview_only', authorization: 'not_recovery_authorization_or_server_approval',
    target: request.target, runId: request.runId,
    source: { reportSha256: run.terminal.reportSha256, checkpointSha256: proof.digest, capturedInputsSha256: run.captured.digest, planDigest: run.plan.digest },
    proposedBudget, recovery,
    eligibleAssignments: recovery.eligibleCallIndices.map(index => {
      const cell = run.plan.cells[index]!;
      return { cell: cell.id, seat: cell.seat, chunk: cell.chunk, model: cell.model, role: cell.role, route: cell.route };
    }),
  });
}

export function formatReviewerRecoveryPreview(preview: ReviewerRecoveryPreview): string {
  return `${preview.target} run ${preview.runId}: ${preview.recovery.successfulSeats}/${preview.recovery.policy.minimumSuccessful} complete seats; ` +
    `${preview.recovery.successesNeeded} still needed; ${preview.eligibleAssignments.length} eligible missing chunks; ` +
    `${preview.recovery.blockedCells.length} blocked chunks; next: ${preview.recovery.nextAction}. ` +
    'Read-only proposal; a guarded launch must revalidate source, accounting and authority.';
}
