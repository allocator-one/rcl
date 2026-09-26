import { CheckpointJournal, checkpointPath, exportCheckpointProof, type CheckpointProof, type CheckpointState, type FrozenCheckpointPlan } from '../dispatch/checkpoint.js';
import { decodeRecoveryOperation } from '../dispatch/recovery-operation.js';
import { recoveryAttemptsFromCheckpoint } from '../dispatch/recovery.js';
import { previewReviewerRecovery } from '../dispatch/recovery-policy.js';
import type { RecoveryAttempt } from '../dispatch/recovery-policy.js';
import type { CapturedReviewerInputs } from '../dispatch/captured-inputs.js';
import { inspectReviewerArtifact, type InspectedReviewerArtifact } from '../report/reviewer-artifact.js';
import { validateInspectedReviewerArtifactChain } from '../report/reviewer-evidence.js';
import { UUID } from '../telemetry/recovery/source.js';

const MAX_LINEAGE_DEPTH = 32;

export interface LoadReviewerLineageInput {
  commonDir: string;
  target: string;
  runId: string;
}

export interface ReviewerLineageRun {
  readonly runId: string;
  readonly journal: CheckpointJournal;
  readonly plan: FrozenCheckpointPlan;
  readonly state: CheckpointState;
  readonly proof: CheckpointProof;
  readonly terminal: Awaited<ReturnType<CheckpointJournal['readTerminalReport']>> & {};
  readonly inspected: InspectedReviewerArtifact;
  readonly captured: CapturedReviewerInputs;
  readonly kind: 'original' | 'successor';
}

export interface ReviewerLineage {
  readonly target: string;
  readonly plan: FrozenCheckpointPlan;
  readonly runs: readonly ReviewerLineageRun[];
  readonly attempts: readonly RecoveryAttempt[];
  readonly latest: ReviewerLineageRun;
}

function fail(code: string): never { throw new Error(`reviewer_lineage_${code}`); }
function sameRun(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }
function validInput(input: LoadReviewerLineageInput): asserts input is LoadReviewerLineageInput {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.commonDir !== 'string' || !input.commonDir ||
    typeof input.target !== 'string' || !input.target.trim() || typeof input.runId !== 'string' || !UUID.test(input.runId)) fail('invalid_input');
}

/**
 * Replays immutable journal events in order so a sealed artifact cannot turn
 * extra physical provider calls into an admissible report. Failed calls may be
 * retried within the saved per-cell limit; successes and uncertain calls may
 * never be retried. Distinct cells may remain concurrently in flight.
 */
function validatePhysicalHistory(runs: readonly ReviewerLineageRun[], rootClaim: { attempt: number; round: number }): void {
  const attemptIds = new Set<string>();
  const attemptsByCell = new Map<string, number>();
  const successful = new Set<string>();
  const uncertain = new Set<string>();
  const claims = new Set<number>([rootClaim.attempt]);
  const settled: RecoveryAttempt[] = [];
  let previousClaim = rootClaim;

  for (const [index, run] of runs.entries()) {
    const root = index === 0;
    const launch = root ? run.inspected.launch! : undefined;
    const operation = root ? undefined : run.inspected.operation!;
    const ownLimit = root ? launch!.maxPhysicalCalls : operation!.maxAdditionalCalls;
    const perCellLimit = root ? launch!.maxAttemptsPerCell : operation!.maxAttemptsPerCell;
    let ownIntents = 0;
    const active = new Map<string, RecoveryAttempt>();
    const attempts = new Map(recoveryAttemptsFromCheckpoint(run.state).map(attempt => [attempt.id, attempt]));

    if (!root) {
      const claim = run.inspected.nativeClaim;
      const attempt = claim?.attempt;
      const round = claim?.round;
      if (!claim || typeof attempt !== 'number' || typeof round !== 'number' ||
        !Number.isSafeInteger(attempt) || !Number.isSafeInteger(round) || attempt < 1 || round < 1) {
        fail('successor_claim_invalid');
      }
      const checkedClaim = { attempt, round };
      if (checkedClaim.round !== rootClaim.round || checkedClaim.attempt <= previousClaim.attempt || claims.has(checkedClaim.attempt)) {
        fail('successor_claim_not_monotonic');
      }
      claims.add(checkedClaim.attempt);
      previousClaim = checkedClaim;
    }

    for (const record of run.state.records) {
      if (record.type === 'intent') {
        const cell = record.cell!;
        const attempt = record.paidAttempt!;
        if (ownIntents >= ownLimit) fail(root ? 'root_physical_call_limit' : 'successor_additional_call_limit');
        if (attemptIds.has(attempt.id)) fail('duplicate_attempt');
        if (successful.has(cell)) fail('success_resampled');
        if (uncertain.has(cell)) fail('uncertain_resampled');
        if (active.has(cell)) fail('duplicate_inflight_attempt');
        const count = (attemptsByCell.get(cell) ?? 0) + 1;
        if (count > perCellLimit) fail(root ? 'root_attempts_per_cell_limit' : 'successor_attempts_per_cell_limit');
        if (!root) {
          const cellIndex = run.plan.cells.findIndex(candidate => candidate.id === cell);
          const preview = previewReviewerRecovery(run.plan.cells, settled, run.captured.policy, {
            maxAttemptsPerCell: perCellLimit,
            maxAdditionalCalls: ownLimit,
            additionalCallsUsed: ownIntents,
            remainingMs: 1,
          });
          if (cellIndex < 0 || !preview.eligibleCallIndices.includes(cellIndex)) fail('successor_ineligible_attempt');
        }
        attemptIds.add(attempt.id);
        attemptsByCell.set(cell, count);
        active.set(cell, { id: attempt.id, cell });
        ownIntents++;
      } else if (record.type === 'result' && record.result!.kind === 'success') {
        successful.add(record.cell!);
        const activeAttempt = active.get(record.cell!);
        const attempt = activeAttempt && attempts.get(activeAttempt.id);
        if (!activeAttempt || !attempt) fail('result_without_intent');
        settled.push(attempt);
        active.delete(record.cell!);
      } else if (record.type === 'result') {
        const activeAttempt = active.get(record.cell!);
        const attempt = activeAttempt && attempts.get(activeAttempt.id);
        if (!activeAttempt || !attempt) fail('result_without_intent');
        settled.push(attempt);
        active.delete(record.cell!);
      } else if (record.type === 'uncertain') {
        uncertain.add(record.cell!);
        const activeAttempt = active.get(record.cell!);
        if (!activeAttempt) fail('uncertain_without_intent');
        settled.push(activeAttempt);
        active.delete(record.cell!);
      }
    }
    // A finalized journal can retain intents without an explicit uncertain
    // event. Treat those calls as possibly billed before reading a successor.
    settled.push(...active.values());
  }
}

async function assertVerification(journal: CheckpointJournal, inspected: InspectedReviewerArtifact): Promise<void> {
  const phase = await journal.readVerification();
  if ((phase !== undefined) !== (inspected.verificationProof !== undefined)) fail('verification_mismatch');
  if (phase !== undefined) {
    const proof = await journal.exportVerificationProof();
    if (proof.bytes !== inspected.verificationProof!.bytes || proof.digest !== inspected.verificationProof!.digest) fail('verification_mismatch');
  }
}

type StoredReviewerRun = Pick<ReviewerLineageRun, 'runId' | 'journal' | 'plan' | 'state' | 'proof' | 'terminal'>;

async function loadStored(commonDir: string, target: string, runId: string): Promise<StoredReviewerRun> {
  const journal = await CheckpointJournal.inspectRead(checkpointPath(commonDir, target, runId));
  const plan = journal.getPlan();
  if (plan.target !== target) fail('target_mismatch');
  const [state, terminal] = await Promise.all([journal.read(), journal.readTerminalReport()]);
  if (!state.finalized) fail('unsealed');
  if (!terminal) fail('terminal_missing');
  const proof = await exportCheckpointProof(journal);
  return { runId, journal, plan, state, proof, terminal };
}

async function inspectStored(stored: StoredReviewerRun, ancestors: readonly InspectedReviewerArtifact[]): Promise<ReviewerLineageRun> {
  const { runId, journal, plan, state, proof, terminal } = stored;
  // Only select the legacy representation here. Uploaded references never
  // supply expected ancestors; the inspector rederives them from stored pairs.
  const lineage: unknown = JSON.parse(terminal.reviewerArtifactBytes)?.lineage;
  const legacy = Array.isArray(lineage) && lineage.length === 0;
  const inspected = inspectReviewerArtifact(terminal.reviewerArtifactBytes, {
    expectedReportBytes: terminal.reportBytes, expectedRunId: runId, expectedTarget: plan.target, expectedPlan: plan,
    ...(legacy ? {} : { ancestors }),
  });
  if (inspected.proof.digest !== proof.digest || inspected.reportSha256 !== terminal.reportSha256 ||
    inspected.captured.plan.digest !== plan.digest) fail('proof_mismatch');
  await assertVerification(journal, inspected);
  const kind = inspected.descriptor.kind === 'original' ? 'original' : 'successor';
  return Object.freeze({ runId, journal, plan, state, proof, terminal, inspected, captured: inspected.captured, kind });
}

/** Loads only a sealed, proof-bound lineage. It never grants native/server authority. */
export async function loadReviewerLineage(input: LoadReviewerLineageInput): Promise<ReviewerLineage> {
  validInput(input);
  const commonDir = input.commonDir;
  const target = input.target.trim();
  const initialRunId = input.runId;
  const newest: StoredReviewerRun[] = [];
  const seen = new Set<string>();
  let runId = initialRunId;
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
    const key = runId.toLowerCase();
    if (seen.has(key)) fail('cycle');
    seen.add(key);
    const run = await loadStored(commonDir, target, runId);
    newest.push(run);
    const operationBytes = run.proof.bindings.operation;
    if (operationBytes === undefined) break;
    // Discover predecessors from the independently validated saved journal,
    // never the artifact's embedded checkpoints or claimed lineage references.
    // Complete capture/source/native-claim checks follow actual inspection.
    const operation = decodeRecoveryOperation(operationBytes);
    if (operation.target !== target || operation.planDigest !== run.plan.digest ||
      !sameRun(operation.successorRunId, runId)) fail('source_binding_mismatch');
    runId = operation.sourceRunId;
  }
  if (!newest.length || newest.at(-1)!.proof.bindings.operation !== undefined) fail('depth');
  const runs: ReviewerLineageRun[] = [];
  for (const stored of newest.reverse()) {
    const run = await inspectStored(stored, runs.map(prior => prior.inspected));
    if (run.kind === 'successor') {
      const operation = run.inspected.operation;
      const source = run.inspected.descriptor.kind === 'supplemented' ? run.inspected.descriptor.source : undefined;
      if (!operation || !source || !sameRun(operation.sourceRunId, source.run_id) ||
        operation.sourceReportSha256 !== source.report_sha256 || operation.sourceCheckpointSha256 !== source.checkpoint_sha256) fail('source_binding_mismatch');
    }
    runs.push(run);
  }
  validateInspectedReviewerArtifactChain(runs.map(run => run.inspected));
  const root = runs[0]!;
  if (!root.inspected.launch || !root.inspected.nativeClaim ||
    root.inspected.launch.originalNativeClaim.attempt !== root.inspected.nativeClaim.attempt ||
    root.inspected.launch.originalNativeClaim.round !== root.inspected.nativeClaim.round) fail('root_claim_mismatch');
  const rootClaim = root.inspected.launch.originalNativeClaim;
  for (const run of runs) {
    if (run.plan.digest !== root.plan.digest || run.captured.digest !== root.captured.digest) fail('input_mismatch');
    if (run.kind === 'successor') {
      const operation = run.inspected.operation!;
      if (operation.originalNativeClaim.attempt !== rootClaim.attempt || operation.originalNativeClaim.round !== rootClaim.round ||
        !operation.successorNativeClaim || !run.inspected.nativeClaim ||
        operation.successorNativeClaim.attempt !== run.inspected.nativeClaim.attempt ||
        operation.successorNativeClaim.round !== run.inspected.nativeClaim.round ||
        operation.successorNativeClaim.round !== rootClaim.round) fail('successor_claim_mismatch');
    }
  }
  validatePhysicalHistory(runs, rootClaim);
  return Object.freeze({ target, plan: root.plan, runs: Object.freeze(runs), attempts: Object.freeze(runs.flatMap(run => recoveryAttemptsFromCheckpoint(run.state))), latest: runs.at(-1)! });
}
