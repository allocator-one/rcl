import { checkpointRecoveryCells, requireReviewerLaneBinding } from '../dispatch/checkpoint.js';
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from 'node:util';
import {
  claimConvergeAttempt,
  convergeAttemptStatePath,
  previewConvergeAttemptState,
  recordConvergeAttemptLaunch,
  recordConvergeAttemptRecoveryResume,
  type ConvergeAttemptClaim,
  type ConvergeAttemptState,
} from "./attempt-budget.js";
import {
  initialConvergeRunState,
  loadConvergeRunStateEvidence,
  validateRoundCap,
  writeState,
  type ConvergeRunState,
} from "./run-state.js";
import {
  CheckpointJournal,
  checkpointPath,
  exportCheckpointProof,
} from "../dispatch/checkpoint.js";
import { loadReviewerLineage } from "../evidence/reviewer-lineage.js";
import { recoveryAttemptsFromCheckpoint } from "../dispatch/recovery.js";
import {
  previewReviewerRecovery,
  type RecoveryAttempt,
} from "../dispatch/recovery-policy.js";
import type { QuorumPolicy } from "../dispatch/quorum.js";
import {
  createRecoveryOperation,
  encodeRecoveryOperation,
  remainingRecoveryBudget,
  decodeRecoveryOperation,
  type RecoveryOperation,
} from "../dispatch/recovery-operation.js";
import { retainedLaunchInputSha256 } from "./retained-report.js";
import { stableStringify } from "../report/run-header.js";
import { withNativeTarget, type NativeTargetOwnership } from "./target-ownership.js";
import { captureCurrentProcessIdentity, inspectProcessIdentity, type ProcessIdentity } from './process-identity.js';

/** Exact canonical operation; the callback grants no authority by itself. */
export interface BoundRecoveryOperation {
  readonly operation: RecoveryOperation;
  readonly operationBytes: string;
}

export interface ReviewerRecoveryLaunchOptions {
  gitCommonDir: string;
  target: string;
  sourceRunId: string;
  successorRunId: string;
  operationId: string;
  headSha: string;
  inputSha256: string;
  startedAtMs: number;
  expiresAtMs: number;
  maxAdditionalCalls: number;
  maxAttemptsPerCell: number;
  maxAttempts?: number;
  /** Testable clock for the persisted operation deadline; defaults to Date.now. */
  nowMs?: () => number;
  /** Invoked under target ownership after eligibility, before spending the native claim. */
  beforeClaim?: (value: BoundRecoveryOperation) => Promise<void>;
  /** Report the spent claim once, after immutable bindings and before provider intent. */
  onClaim?: (claim: ConvergeAttemptClaim) => Promise<void>;
  /** Invoked only after the successor checkpoint has all immutable bindings. */
  run: (value: {
    journal: CheckpointJournal;
    operation: RecoveryOperation;
    claim: ConvergeAttemptClaim;
    ownership: NativeTargetOwnership;
  }) => Promise<void>;
}

export type ReviewerRecoveryLaunchResult =
  | { kind: "already_quorate"; sourceRunId: string }
  | {
      kind: "claimed";
      claim: ConvergeAttemptClaim;
      operation: RecoveryOperation;
    };

type Source = {
  journal: CheckpointJournal;
  capturedBytes: string;
  sourceReportSha256: string;
  sourceCheckpointSha256: string;
  capturedInputsSha256: string;
  originalNativeClaim: { attempt: number; round: number };
  sourceNativeClaim: { attempt: number; round: number };
  policy: QuorumPolicy;
  attempts: RecoveryAttempt[];
  nativeSha256?: string;
};

class AlreadyQuorate extends Error {}
function fail(code: string): never {
  throw new Error(`recovery_launch_${code}`);
}
function operationNow(options: ReviewerRecoveryLaunchOptions): number {
  return (options.nowMs ?? Date.now)();
}
function assertOperationLive(
  operation: RecoveryOperation,
  options: ReviewerRecoveryLaunchOptions,
): void {
  if (
    remainingRecoveryBudget(operation, operationNow(options)).remainingMs <= 0
  )
    fail("operation_expired");
}
async function assertSuccessorAttempts(
  source: Source,
  journal: CheckpointJournal,
  operation: RecoveryOperation,
): Promise<void> {
  // The deadline guarded the claim. Results can be durably accepted while a
  // report/artifact is assembled, so readback time cannot relabel them late.
  const budget = remainingRecoveryBudget(operation, operation.startedAtMs);
  const state = await journal.read();
  const outcomes = new Map(
    recoveryAttemptsFromCheckpoint(state).map((attempt) => [
      attempt.id,
      attempt,
    ]),
  );
  const plan = source.journal.getPlan();
  const indexByCell = new Map(
    plan.cells.map((cell, index) => [cell.id, index]),
  );
  const settled: RecoveryAttempt[] = [...source.attempts];
  const active = new Map<string, RecoveryAttempt>();
  let ownIntents = 0;

  for (const record of state.records) {
    if (record.type === "intent") {
      if (ownIntents >= budget.maxAdditionalCalls)
        fail("successor_additional_call_limit");
      const cell = record.cell!;
      const attempt: RecoveryAttempt = { id: record.paidAttempt!.id, cell };
      if (active.has(cell)) fail("successor_duplicate_inflight_attempt");
      // Match the executor: only durable results affect selection. Other
      // in-flight cells are reserved, but do not erase still-actionable work.
      const preview = previewReviewerRecovery(
        checkpointRecoveryCells(plan),
        settled,
        source.policy,
        {
          maxAttemptsPerCell: budget.maxAttemptsPerCell,
          maxAdditionalCalls: budget.maxAdditionalCalls,
          additionalCallsUsed: ownIntents - active.size,
          remainingMs: 1,
        },
      );
      const cellIndex = indexByCell.get(cell);
      if (
        cellIndex === undefined ||
        !preview.eligibleCallIndices.includes(cellIndex)
      )
        fail("successor_ineligible_attempt");
      active.set(cell, attempt);
      ownIntents++;
      continue;
    }
    if (record.type !== "result" && record.type !== "uncertain") continue;
    const cell = record.cell!;
    const activeAttempt = active.get(cell);
    if (!activeAttempt || activeAttempt.id !== record.paidAttempt!.id)
      fail("successor_result_without_intent");
    const persisted = outcomes.get(activeAttempt.id);
    settled.push(persisted ?? activeAttempt);
    active.delete(cell);
  }
  // A sealed journal may retain unresolved paid intents as uncertainty. They
  // remain in the audit history and cannot be silently converted to success.
  settled.push(...active.values());
  previewReviewerRecovery(checkpointRecoveryCells(plan), settled, source.policy, {
    maxAttemptsPerCell: budget.maxAttemptsPerCell,
    maxAdditionalCalls: budget.maxAdditionalCalls,
    additionalCallsUsed: ownIntents,
    remainingMs: 1,
  });
}
function equalClaim(
  left: { attempt: number; round: number },
  right: { attempt: number; round: number },
): boolean {
  return left.attempt === right.attempt && left.round === right.round;
}

async function loadSource(
  options: ReviewerRecoveryLaunchOptions,
  state: ConvergeRunState,
  nativeSha256: string | undefined,
  attempts: ConvergeAttemptState | undefined,
  requiredRound: number,
): Promise<Source | "already_quorate"> {
  const lineage = await loadReviewerLineage({
    commonDir: options.gitCommonDir, target: options.target, runId: options.sourceRunId,
  });
  const latest = lineage.latest, inspected = latest.inspected;
  const plan = lineage.plan;
  requireReviewerLaneBinding(plan);
  if (plan.headSha !== options.headSha) fail("source_mismatch");
  const root = lineage.runs[0]!.inspected.launch?.originalNativeClaim;
  const source = inspected.nativeClaim;
  const sourceAttempt = source?.attempt, sourceRound = source?.round;
  if (!root || typeof sourceAttempt !== "number" || typeof sourceRound !== "number" ||
    !Number.isSafeInteger(sourceAttempt) || !Number.isSafeInteger(sourceRound) || sourceAttempt < 1 || sourceRound < 1 || root.round !== requiredRound || sourceRound !== requiredRound) {
    fail("source_round_mismatch");
  }
  const sourceClaim = { attempt: sourceAttempt, round: sourceRound };
  let previousAttempt = root.attempt - 1;
  for (const entry of lineage.runs) {
    const ancestor = entry.inspected.nativeClaim;
    if (!ancestor || ancestor.attempt !== previousAttempt + 1 || ancestor.round !== requiredRound ||
      !attempts?.attempts.some(item => item.attempt === ancestor.attempt)) fail("source_ancestor_claim_mismatch");
    previousAttempt = ancestor.attempt;
  }
  const frozenInput = retainedLaunchInputSha256(inspected.captured.digest, inspected.assembly.run);
  const health = inspected.artifact.health;
  const expectedHealth = { version: 1, policy: health.policy, successfulSeats: health.successfulSeats.length };
  const launch = state.version === 3 ? attempts?.lastLaunch : state.lastLaunch;
  const recoverySource = inspected.assembly.run.converge?.recovery_source;
  if (inspected.assembly.run.cycleId !== state.cycle?.id ||
    (state.version === 3
      ? !nativeSha256 || recoverySource?.version !== 1 || recoverySource.native_sha256 !== nativeSha256
      : recoverySource !== undefined)) fail("source_recovery_binding_mismatch");
  const spent = attempts?.attempts.find(item => item.attempt === sourceClaim.attempt);
  const attemptOwner = spent?.handoff ?? spent;
  if (!launch || launch.status !== "completed" || launch.runId !== options.sourceRunId ||
    launch.headSha !== options.headSha || options.inputSha256 !== frozenInput ||
    launch.inputSha256 !== frozenInput || !equalClaim(launch, sourceClaim) ||
    launch.reportJsonSha256 !== latest.terminal.reportSha256 ||
    launch.successfulReviews !== health.successfulSeats.length ||
    launch.totalReviews !== health.policy.seatCount ||
    stableStringify(launch.reviewerHealth) !== stableStringify(expectedHealth) ||
    attempts?.attemptsUsed !== sourceClaim.attempt || !spent || attemptOwner?.pid !== launch.pid ||
    (attemptOwner.processIdentity !== undefined || launch.processIdentity !== undefined) &&
      !isDeepStrictEqual(attemptOwner.processIdentity, launch.processIdentity) ||
    state.rounds.some(round => round.round === requiredRound)) fail("source_not_current");
  if (latest.kind === "successor") {
    const parent = lineage.runs.at(-2)!.inspected;
    if (launch.recovery?.operationId !== inspected.operation!.operationId ||
      launch.recovery.sourceRunId !== parent.runId ||
      stableStringify(launch.recovery.originalNativeClaim) !== stableStringify(root) ||
      stableStringify(launch.recovery.sourceNativeClaim) !== stableStringify({
        attempt: parent.nativeClaim!.attempt, round: parent.nativeClaim!.round,
      })) fail("source_not_current");
  }
  if (health.conclusive) return "already_quorate";
  const capturedBytes = (await latest.journal.readBindings())["captured-inputs"];
  if (capturedBytes === undefined || capturedBytes !== inspected.captured.bytes) fail("source_capture_missing");
  return {
    journal: latest.journal,
    capturedBytes,
    sourceReportSha256: latest.terminal.reportSha256,
    sourceCheckpointSha256: latest.proof.digest,
    capturedInputsSha256: inspected.captured.digest,
    originalNativeClaim: root,
    sourceNativeClaim: sourceClaim,
    policy: health.policy,
    attempts: [...lineage.attempts],
    ...(state.version === 3 ? { nativeSha256 } : {}),
  };
}

/**
 * Proof-bearing native recovery launch. It accepts no caller-provided health or
 * authorization flag: the source journal, terminal artifact and native state
 * are revalidated while the existing target lock is held.
 */
export async function guardReviewerRecoveryLaunch(
  input: ReviewerRecoveryLaunchOptions,
): Promise<ReviewerRecoveryLaunchResult> {
  // Copy every mutable caller-owned value before the first await, including the
  // callback: later caller mutation cannot redirect a spent native claim.
  const snapshot = {
    gitCommonDir: input?.gitCommonDir,
    target: input?.target,
    sourceRunId: input?.sourceRunId,
    successorRunId: input?.successorRunId,
    operationId: input?.operationId,
    headSha: input?.headSha,
    inputSha256: input?.inputSha256,
    startedAtMs: input?.startedAtMs,
    expiresAtMs: input?.expiresAtMs,
    maxAdditionalCalls: input?.maxAdditionalCalls,
    maxAttemptsPerCell: input?.maxAttemptsPerCell,
    maxAttempts: input?.maxAttempts,
    nowMs: input?.nowMs,
    beforeClaim: input?.beforeClaim,
    onClaim: input?.onClaim,
    run: input?.run,
  };
  if (
    typeof snapshot.gitCommonDir !== "string" ||
    typeof snapshot.target !== "string" ||
    typeof snapshot.sourceRunId !== "string" ||
    typeof snapshot.successorRunId !== "string" ||
    typeof snapshot.operationId !== "string" ||
    typeof snapshot.headSha !== "string" ||
    typeof snapshot.inputSha256 !== "string" ||
    typeof snapshot.run !== "function" ||
    (snapshot.nowMs !== undefined && typeof snapshot.nowMs !== "function") ||
    (snapshot.beforeClaim !== undefined && typeof snapshot.beforeClaim !== "function") ||
    (snapshot.onClaim !== undefined && typeof snapshot.onClaim !== "function")
  )
    fail("invalid_input");
  const options: ReviewerRecoveryLaunchOptions = {
    ...snapshot,
    target: snapshot.target.trim(),
    gitCommonDir: await realpath(resolve(snapshot.gitCommonDir)),
  };
  if (
    !options.target ||
    !/^[a-f0-9]{40}$/.test(options.headSha) ||
    !/^[a-f0-9]{64}$/.test(options.inputSha256)
  )
    fail("invalid_input");
  let source: Source | "already_quorate" | undefined;
  let operation: RecoveryOperation | undefined;
  let operationBytes: string | undefined;
  let failure: unknown;
  let claim: ConvergeAttemptClaim;
  let ownerIdentity: ProcessIdentity;
  try { ownerIdentity = await captureCurrentProcessIdentity(); }
  catch { fail('owner_unverifiable'); }
  try {
    claim = await claimConvergeAttempt({
      gitCommonDir: options.gitCommonDir,
      target: options.target,
      maxAttempts: options.maxAttempts,
      beforeClaim: async () => {
        const native = await loadConvergeRunStateEvidence(options.gitCommonDir, options.target);
        const state = native?.state ?? initialConvergeRunState(options.target);
        const attempts = await previewConvergeAttemptState(
          options.gitCommonDir,
          options.target,
        );
        validateRoundCap(state.roundCap);
        if (
          state.rounds.some(
            (item) => !Number.isSafeInteger(item.round) || item.round < 1,
          )
        )
          fail("invalid_round_state");
        const requiredRound =
          state.rounds.reduce((last, item) => Math.max(last, item.round), 0) +
          1;
        if (requiredRound > state.roundCap) fail("round_cap");
        source = await loadSource(options, state, native?.sha256, attempts, requiredRound);
        if (source === "already_quorate") throw new AlreadyQuorate();
        if (attempts?.attemptsUsed !== source.sourceNativeClaim.attempt)
          fail("native_attempt_mismatch");
        operation = createRecoveryOperation({
          operationId: options.operationId,
          successorRunId: options.successorRunId,
          sourceRunId: options.sourceRunId,
          sourceReportSha256: source.sourceReportSha256,
          sourceCheckpointSha256: source.sourceCheckpointSha256,
          capturedInputsSha256: source.capturedInputsSha256,
          planDigest: source.journal.getPlan().digest,
          target: options.target,
          originalNativeClaim: source.originalNativeClaim,
          successorNativeClaim: {
            attempt: source.sourceNativeClaim.attempt + 1,
            round: requiredRound,
          },
          startedAtMs: options.startedAtMs,
          expiresAtMs: options.expiresAtMs,
          maxAdditionalCalls: options.maxAdditionalCalls,
          maxAttemptsPerCell: options.maxAttemptsPerCell,
        });
        operationBytes = encodeRecoveryOperation(operation);
        assertOperationLive(operation, options);
        const sourcePreview = previewReviewerRecovery(
          checkpointRecoveryCells(source.journal.getPlan()),
          source.attempts,
          source.policy,
          {
            maxAttemptsPerCell: operation.maxAttemptsPerCell,
            maxAdditionalCalls: operation.maxAdditionalCalls,
            additionalCallsUsed: 0,
            remainingMs: remainingRecoveryBudget(
              operation,
              operationNow(options),
            ).remainingMs,
          },
        );
        if (sourcePreview.nextAction !== "retry_missing_assignments")
          fail("source_not_actionable");
        await options.beforeClaim?.(Object.freeze({ operation, operationBytes }));
        assertOperationLive(operation, options);
      },
      afterClaim: async (claim, ownership) => {
        const native = await loadConvergeRunStateEvidence(
          options.gitCommonDir,
          options.target,
        );
        const state = native?.state;
        if (!state || !source || source === "already_quorate")
          fail("source_not_current");
        if (state.version === 3 && (!source.nativeSha256 || native.sha256 !== source.nativeSha256))
          fail("source_not_current");
        const requiredRound = source.sourceNativeClaim.round;
        if (
          !operation || operationBytes === undefined ||
          operation.successorNativeClaim?.attempt !== claim.attempt ||
          operation.successorNativeClaim.round !== requiredRound
        )
          fail("claim_mismatch");
        const pendingLaunch = {
          status: "pending",
          runId: options.successorRunId,
          attempt: claim.attempt,
          round: requiredRound,
          headSha: options.headSha,
          inputSha256: options.inputSha256,
          startedAt: new Date().toISOString(),
          pid: process.pid,
          processIdentity: ownerIdentity,
          recovery: {
            operationId: operation.operationId,
            sourceRunId: options.sourceRunId,
            originalNativeClaim: source.originalNativeClaim,
            sourceNativeClaim: source.sourceNativeClaim,
          },
        } as const;
        if (state.version === 3) {
          await recordConvergeAttemptLaunch(options.gitCommonDir, options.target, pendingLaunch, ownership);
        } else {
          state.lastLaunch = pendingLaunch;
          await writeState(options.gitCommonDir, state, ownership);
        }
        try {
          const journal = await CheckpointJournal.create({
            commonDir: options.gitCommonDir,
            namespace: options.successorRunId,
            plan: source.journal.getPlan(),
            ownership,
          });
          await journal.bind(
            "captured-inputs",
            source.capturedBytes,
            ownership,
          );
          await journal.bind(
            "source",
            stableStringify({
              run_id: options.sourceRunId,
              report_sha256: source.sourceReportSha256,
              checkpoint_sha256: source.sourceCheckpointSha256,
            }),
            ownership,
          );
          await journal.bind(
            "operation",
            operationBytes,
            ownership,
          );
          await options.onClaim?.(claim);
          await options.run({ journal, operation, claim, ownership });
          const successorState = await journal.read();
          const terminal = await journal.readTerminalReport();
          if (!successorState.finalized || !terminal)
            fail("successor_terminal_missing");
          const successorProof = await exportCheckpointProof(journal);
          await assertSuccessorAttempts(source, journal, operation);
          const completedLineage = await loadReviewerLineage({ commonDir: options.gitCommonDir,
            target: options.target, runId: options.successorRunId });
          const inspected = completedLineage.latest.inspected;
          const health = inspected.artifact.health;
          if (
            inspected.proof.digest !== successorProof.digest ||
            inspected.operation?.operationId !== operation.operationId ||
            inspected.operation?.successorNativeClaim?.attempt !==
              claim.attempt ||
            inspected.operation.successorNativeClaim.round !== requiredRound
          )
            fail("successor_proof_mismatch");
          const completedLaunch = {
            ...pendingLaunch,
            status: "completed",
            runId: options.successorRunId,
            reportJsonSha256: terminal.reportSha256,
            successfulReviews: health.successfulSeats.length,
            totalReviews: health.policy.seatCount,
            deliveryPending: false,
            hardFailure: false,
            reviewerHealth: {
              version: 1,
              policy: health.policy,
              successfulSeats: health.successfulSeats.length,
            },
          } as const;
          if (state.version === 3) {
            await recordConvergeAttemptLaunch(options.gitCommonDir, options.target, completedLaunch, ownership);
          } else {
            state.lastLaunch = completedLaunch;
          }
        } catch (error) {
          const failedLaunch = { ...pendingLaunch, status: "failed" as const };
          if (state.version === 3) {
            await recordConvergeAttemptLaunch(options.gitCommonDir, options.target, failedLaunch, ownership);
          } else {
            state.lastLaunch = failedLaunch;
          }
          failure = error;
        }
        if (state.version !== 3) {
          state.updatedAt = new Date().toISOString();
          await writeState(options.gitCommonDir, state, ownership);
        }
      },
    });
  } catch (error) {
    if (error instanceof AlreadyQuorate)
      return { kind: "already_quorate", sourceRunId: options.sourceRunId };
    throw error;
  }
  if (failure) throw failure;
  return { kind: "claimed", claim, operation: operation! };
}

export type ReviewerRecoveryResumeOptions = Pick<ReviewerRecoveryLaunchOptions,
  "gitCommonDir" | "target" | "successorRunId" | "headSha" | "inputSha256" | "nowMs" | "run"> & {
    /** Exact saved descriptor is validated before this callback or any resume mutation. */
    beforeResume?: (value: BoundRecoveryOperation) => Promise<void>;
  };
export interface ReviewerRecoveryResumeResult {
  kind: "resumed";
  claim: ConvergeAttemptClaim;
  operation: RecoveryOperation;
  reusedTerminal: boolean;
}

async function requireDeadOwner(identity: ProcessIdentity | undefined): Promise<void> {
  if (!identity) fail('resume_owner_unverifiable');
  const status = await inspectProcessIdentity(identity);
  if (status === 'unverifiable') fail('resume_owner_unverifiable');
  if (status === 'alive') fail('resume_owner_alive');
}

/**
 * Reopen only the exact fully-bound, already-spent successor. Partial binding
 * gaps remain explicit refusals. The target lock serializes resumes, while a
 * separate owner marker preserves the original claim PID and absolute bounds.
 */
export async function guardReviewerRecoveryResume(input: ReviewerRecoveryResumeOptions): Promise<ReviewerRecoveryResumeResult> {
  const snapshot = { gitCommonDir: input?.gitCommonDir, target: input?.target,
    successorRunId: input?.successorRunId, headSha: input?.headSha,
    inputSha256: input?.inputSha256, nowMs: input?.nowMs, run: input?.run, beforeResume: input?.beforeResume };
  if (typeof snapshot.gitCommonDir !== "string" || typeof snapshot.target !== "string" || !snapshot.target.trim() ||
    typeof snapshot.successorRunId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(snapshot.successorRunId) ||
    !/^[a-f0-9]{40}$/.test(snapshot.headSha ?? "") || !/^[a-f0-9]{64}$/.test(snapshot.inputSha256 ?? "") ||
    typeof snapshot.run !== "function" || snapshot.nowMs !== undefined && typeof snapshot.nowMs !== "function" ||
    snapshot.beforeResume !== undefined && typeof snapshot.beforeResume !== "function") fail("invalid_resume_input");
  const options = { ...snapshot, target: snapshot.target.trim(), gitCommonDir: await realpath(resolve(snapshot.gitCommonDir)) };
  return withNativeTarget(options.gitCommonDir, options.target, async ownership => {
    const [native, attempts] = await Promise.all([
      loadConvergeRunStateEvidence(options.gitCommonDir, options.target),
      previewConvergeAttemptState(options.gitCommonDir, options.target),
    ]);
    const state = native?.state;
    const { assertReviewCyclePair } = await import('./fresh-review.js');
    await assertReviewCyclePair(options.gitCommonDir, options.target, state?.cycle);
    const launch = state?.version === 3 ? attempts?.lastLaunch : state?.lastLaunch;
    const recovery = launch?.recovery;
    if (!state || !launch || !recovery || launch.runId !== options.successorRunId || !recovery.operationId) fail("resume_missing_launch");
    if (launch.headSha !== options.headSha || launch.inputSha256 !== options.inputSha256) fail("resume_input_mismatch");
    const spent = attempts?.attempts.find(item => item.attempt === launch.attempt);
    const attemptOwner = spent?.handoff ?? spent;
    if (!attempts || !spent || attemptOwner?.pid !== launch.pid || attempts.attemptsUsed !== launch.attempt ||
      (attemptOwner.processIdentity !== undefined || launch.processIdentity !== undefined) &&
        !isDeepStrictEqual(attemptOwner.processIdentity, launch.processIdentity)) fail("resume_claim_mismatch");
    validateRoundCap(state.roundCap);
    if (state.rounds.some(item => !Number.isSafeInteger(item.round) || item.round < 1)) fail("invalid_round_state");
    const maxRound = state.rounds.reduce((last, item) => Math.max(last, item.round), 0);
    const admitted = state.rounds.find(item => item.round === launch.round);
    if (launch.round > state.roundCap || (admitted
      ? admitted.runId !== options.successorRunId || maxRound !== launch.round || launch.status !== "completed"
      : maxRound + 1 !== launch.round)) fail("resume_round_mismatch");
    if (launch.status === "pending") await requireDeadOwner(recovery.resume?.phase === "running"
      ? recovery.resume.processIdentity : launch.processIdentity);
    else if (recovery.resume?.phase === "running") await requireDeadOwner(recovery.resume.processIdentity);

    const readJournal = await CheckpointJournal.inspectRead(checkpointPath(options.gitCommonDir, options.target, options.successorRunId));
    requireReviewerLaneBinding(readJournal.getPlan());
    const bindings = await readJournal.readBindings();
    if (!bindings.operation || !bindings.source || !bindings["captured-inputs"] || bindings.launch !== undefined) fail("resume_partial_binding");
    const operation = decodeRecoveryOperation(bindings.operation);
    if (operation.operationId !== recovery.operationId || operation.successorRunId !== options.successorRunId ||
      operation.target !== options.target || !operation.successorNativeClaim || !equalClaim(operation.successorNativeClaim, launch) ||
      operation.sourceRunId !== recovery.sourceRunId || !equalClaim(operation.originalNativeClaim, recovery.originalNativeClaim)) fail("resume_operation_mismatch");
    const lineage = await loadReviewerLineage({ commonDir: options.gitCommonDir, target: options.target, runId: operation.sourceRunId });
    const latest = lineage.latest, inspected = latest.inspected, root = lineage.runs[0]!.inspected.launch!.originalNativeClaim;
    const sourceClaim = inspected.nativeClaim;
    if (!sourceClaim || sourceClaim.attempt === undefined || sourceClaim.round === undefined ||
      !equalClaim({ attempt: sourceClaim.attempt, round: sourceClaim.round }, recovery.sourceNativeClaim) ||
      sourceClaim.attempt + 1 !== launch.attempt || sourceClaim.round !== launch.round || !equalClaim(root, operation.originalNativeClaim) ||
      inspected.artifact.health.conclusive) fail("resume_source_mismatch");
    let ancestorAttempt = root.attempt - 1;
    for (const entry of lineage.runs) {
      const ancestor = entry.inspected.nativeClaim;
      if (!ancestor || ancestor.attempt !== ancestorAttempt + 1 || ancestor.round !== launch.round ||
        !attempts.attempts.some(item => item.attempt === ancestor.attempt)) fail("resume_ancestor_claim_mismatch");
      ancestorAttempt = ancestor.attempt;
    }
    if (lineage.plan.headSha !== options.headSha || readJournal.getPlan().digest !== lineage.plan.digest ||
      operation.planDigest !== lineage.plan.digest || operation.sourceReportSha256 !== latest.terminal.reportSha256 ||
      operation.sourceCheckpointSha256 !== latest.proof.digest || operation.capturedInputsSha256 !== inspected.captured.digest ||
      bindings["captured-inputs"] !== inspected.captured.bytes ||
      bindings.source !== stableStringify({ run_id: operation.sourceRunId,
        report_sha256: latest.terminal.reportSha256, checkpoint_sha256: latest.proof.digest }) ||
      options.inputSha256 !== retainedLaunchInputSha256(inspected.captured.digest, inspected.assembly.run)) fail("resume_source_mismatch");
    const source: Source = { journal: latest.journal, capturedBytes: inspected.captured.bytes,
      sourceReportSha256: latest.terminal.reportSha256, sourceCheckpointSha256: latest.proof.digest,
      capturedInputsSha256: inspected.captured.digest, originalNativeClaim: root,
      sourceNativeClaim: { attempt: sourceClaim.attempt, round: sourceClaim.round },
      policy: inspected.artifact.health.policy, attempts: [...lineage.attempts] };
    const claim: ConvergeAttemptClaim = { target: options.target, attempt: launch.attempt,
      attemptsUsed: attempts.attemptsUsed, cap: attempts.cap, stateFile: convergeAttemptStatePath(options.gitCommonDir, options.target) };
    const sourceRecovery = inspected.assembly.run.converge?.recovery_source;
    if (inspected.assembly.run.cycleId !== state.cycle?.id ||
      (state.version === 3
        ? sourceRecovery?.version !== 1 || sourceRecovery.native_sha256 !== native!.sha256
        : sourceRecovery !== undefined)) fail("resume_source_recovery_binding_mismatch");
    const priorTerminal = await readJournal.readTerminalReport();
    if (launch.status === "completed" && !priorTerminal) fail("resume_terminal_missing");
    const priorState = await readJournal.read();
    const budget = remainingRecoveryBudget(operation, (options.nowMs ?? Date.now)());
    const beforeIntents = stableStringify(priorState.records.filter(record => record.type === "intent"));
    const beforeVerifierIntents = budget.remainingMs === 0
      ? stableStringify((await readJournal.readVerification())?.intents ?? []) : undefined;

    const persistLaunch = async (expected: typeof launch, next: typeof launch) => {
      if (state.version === 3) {
        await recordConvergeAttemptRecoveryResume(options.gitCommonDir, options.target, {
          expected, next, nativeSha256: native!.sha256, ...(state.cycle ? { cycleId: state.cycle.id } : {}),
        }, ownership);
        return;
      }
      if (!isDeepStrictEqual(state.lastLaunch, expected)) fail('resume_stale_launch');
      state.lastLaunch = next;
      state.updatedAt = new Date().toISOString();
      await writeState(options.gitCommonDir, state, ownership);
    };

    const finish = async (journal: CheckpointJournal) => {
      const completed = await loadReviewerLineage({ commonDir: options.gitCommonDir, target: options.target, runId: options.successorRunId });
      const terminal = completed.latest.terminal, proof = completed.latest.proof, final = completed.latest.inspected;
      if (proof.bindings.operation !== bindings.operation || final.operation?.operationId !== operation.operationId ||
        completed.runs.length !== lineage.runs.length + 1 ||
        completed.runs.slice(0, -1).some((entry, index) => entry.terminal.reportSha256 !== lineage.runs[index]!.terminal.reportSha256 ||
          entry.proof.digest !== lineage.runs[index]!.proof.digest)) fail("resume_terminal_mismatch");
      await assertSuccessorAttempts(source, journal, operation);
      if (budget.remainingMs === 0 && (
        stableStringify((await journal.read()).records.filter(record => record.type === "intent")) !== beforeIntents ||
        stableStringify((await journal.readVerification())?.intents ?? []) !== beforeVerifierIntents
      )) fail("resume_expired_dispatch");
      const health = final.artifact.health;
      return { reportJsonSha256: terminal.reportSha256, successfulReviews: health.successfulSeats.length,
        totalReviews: health.policy.seatCount,
        reviewerHealth: { version: 1 as const, policy: health.policy, successfulSeats: health.successfulSeats.length } };
    };
    if (launch.status === "completed") {
      const completion = await finish(readJournal);
      if (Object.entries(completion).some(([key, value]) => stableStringify(launch[key as keyof typeof launch]) !== stableStringify(value))) fail("resume_completed_mismatch");
      return { kind: "resumed", claim, operation, reusedTerminal: true };
    }

    // Expired work may seal/reconstruct its local terminal without a live
    // credential. It cannot authorize new reviewer or verifier dispatch.
    if (!priorTerminal && budget.remainingMs > 0) {
      await options.beforeResume?.(Object.freeze({ operation, operationBytes: bindings.operation! }));
      if (remainingRecoveryBudget(operation, (options.nowMs ?? Date.now)()).remainingMs === 0) {
        fail("resume_expired_dispatch");
      }
    }
    // Health describes completed evidence only; the immutable report and claims
    // remain bound above, and finish derives health again from the saved lineage.
    let currentIdentity: ProcessIdentity;
    try { currentIdentity = await captureCurrentProcessIdentity(); }
    catch { fail('resume_owner_unverifiable'); }
    const mutableLaunch = { ...launch };
    delete mutableLaunch.reviewerHealth;
    const persistedLaunch = { ...mutableLaunch, status: "pending" as const, recovery: { ...recovery,
      resume: { pid: process.pid, processIdentity: currentIdentity, phase: "running" as const } } };
    await persistLaunch(launch, persistedLaunch);
    try {
      const journal = await CheckpointJournal.openWrite({ commonDir: options.gitCommonDir, namespace: options.successorRunId,
        plan: lineage.plan, ownership });
      if (!priorTerminal) await options.run({ journal, operation, claim, ownership });
      const completion = await finish(journal);
      const completedLaunch = { ...launch, ...completion, status: "completed" as const,
        deliveryPending: launch.deliveryPending ?? false,
        hardFailure: launch.hardFailure ?? false, recovery: { ...recovery,
          resume: { pid: process.pid, processIdentity: currentIdentity, phase: "finished" as const } } };
      await persistLaunch(persistedLaunch, completedLaunch);
      return { kind: "resumed", claim, operation, reusedTerminal: priorTerminal !== undefined };
    } catch (error) {
      const failedLaunch = { ...mutableLaunch, status: "failed" as const, recovery: { ...recovery,
        resume: { pid: process.pid, processIdentity: currentIdentity, phase: "finished" as const } } };
      await persistLaunch(persistedLaunch, failedLaunch);
      throw error;
    }
  });
}
