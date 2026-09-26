import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  claimConvergeAttempt,
  previewConvergeAttemptState,
  type ConvergeAttemptClaim,
  type ConvergeAttemptState,
} from "./attempt-budget.js";
import {
  initialConvergeRunState,
  loadConvergeRunState,
  validateRoundCap,
  writeState,
  type ConvergeRunState,
} from "./run-state.js";
import {
  CheckpointJournal,
  checkpointPath,
  exportCheckpointProof,
} from "../dispatch/checkpoint.js";
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
  type RecoveryOperation,
} from "../dispatch/recovery-operation.js";
import { inspectReviewerArtifact } from "../report/reviewer-artifact.js";
import { retainedLaunchInputSha256 } from "./retained-report.js";
import { stableStringify } from "../report/run-header.js";
import type { NativeTargetOwnership } from "./target-ownership.js";

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
        plan.cells,
        settled,
        source.policy,
        {
          maxAttemptsPerCell: budget.maxAttemptsPerCell,
          maxAdditionalCalls: budget.maxAdditionalCalls,
          additionalCallsUsed: ownIntents,
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
  previewReviewerRecovery(plan.cells, settled, source.policy, {
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
  attempts: ConvergeAttemptState | undefined,
  requiredRound: number,
): Promise<Source | "already_quorate"> {
  const journal = await CheckpointJournal.inspectRead(
    checkpointPath(options.gitCommonDir, options.target, options.sourceRunId),
  );
  const plan = journal.getPlan();
  const sourceState = await journal.read();
  if (
    plan.target !== options.target ||
    plan.headSha !== options.headSha ||
    !sourceState.finalized
  )
    fail("source_mismatch");
  const terminal = await journal.readTerminalReport();
  if (!terminal) fail("source_terminal_missing");
  const inspected = inspectReviewerArtifact(terminal.reviewerArtifactBytes, {
    expectedReportBytes: terminal.reportBytes,
    expectedRunId: options.sourceRunId,
    expectedTarget: options.target,
    expectedPlan: plan,
  });
  const proof = await exportCheckpointProof(journal);
  if (
    inspected.proof.digest !== proof.digest ||
    inspected.reportSha256 !== terminal.reportSha256 ||
    inspected.captured.plan.digest !== plan.digest ||
    !inspected.nativeClaim
  )
    fail("source_proof_mismatch");
  // This helper deliberately owns only original-source recovery. A successor
  // needs the whole proof-bound ancestor history, which this bounded path does
  // not yet load; refusing it is safer than silently losing prior attempts.
  if (inspected.operation) fail("successor_source_unsupported");
  const root = inspected.launch?.originalNativeClaim;
  const source = inspected.nativeClaim;
  const sourceAttempt = source?.attempt,
    sourceRound = source?.round;
  if (
    !root ||
    !source ||
    typeof sourceAttempt !== "number" ||
    typeof sourceRound !== "number" ||
    !Number.isSafeInteger(sourceAttempt) ||
    !Number.isSafeInteger(sourceRound) ||
    sourceAttempt < 1 ||
    sourceRound < 1 ||
    root.round !== requiredRound ||
    sourceRound !== requiredRound
  )
    fail("source_round_mismatch");
  const sourceClaim = { attempt: sourceAttempt, round: sourceRound };
  const launch = state.lastLaunch;
  const frozenInput = retainedLaunchInputSha256(
    inspected.captured.digest,
    inspected.assembly.run,
  );
  const health = inspected.artifact.health;
  const expectedHealth = {
    version: 1,
    policy: health.policy,
    successfulSeats: health.successfulSeats.length,
  };
  const spent = attempts?.attempts.find(
    (item) => item.attempt === sourceClaim.attempt,
  );
  if (
    !launch ||
    launch.status !== "completed" ||
    launch.runId !== options.sourceRunId ||
    launch.headSha !== options.headSha ||
    options.inputSha256 !== frozenInput ||
    launch.inputSha256 !== frozenInput ||
    !equalClaim(launch, sourceClaim) ||
    launch.reportJsonSha256 !== terminal.reportSha256 ||
    launch.successfulReviews !== health.successfulSeats.length ||
    launch.totalReviews !== health.policy.seatCount ||
    stableStringify(launch.reviewerHealth) !==
      stableStringify(expectedHealth) ||
    attempts?.attemptsUsed !== sourceClaim.attempt ||
    !spent ||
    spent.pid !== launch.pid ||
    state.rounds.some((round) => round.round === requiredRound)
  ) {
    fail("source_not_current");
  }
  if (health.conclusive) return "already_quorate";
  const capturedBytes = proof.bindings["captured-inputs"];
  if (capturedBytes === undefined || capturedBytes !== inspected.captured.bytes)
    fail("source_capture_missing");
  return {
    journal,
    capturedBytes,
    sourceReportSha256: terminal.reportSha256,
    sourceCheckpointSha256: proof.digest,
    capturedInputsSha256: inspected.captured.digest,
    originalNativeClaim: root,
    sourceNativeClaim: sourceClaim,
    policy: health.policy,
    attempts: recoveryAttemptsFromCheckpoint(sourceState),
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
    (snapshot.nowMs !== undefined && typeof snapshot.nowMs !== "function")
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
  let failure: unknown;
  let claim: ConvergeAttemptClaim;
  try {
    claim = await claimConvergeAttempt({
      gitCommonDir: options.gitCommonDir,
      target: options.target,
      maxAttempts: options.maxAttempts,
      beforeClaim: async () => {
        const state =
          (await loadConvergeRunState(options.gitCommonDir, options.target)) ??
          initialConvergeRunState(options.target);
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
        source = await loadSource(options, state, attempts, requiredRound);
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
        assertOperationLive(operation, options);
        const sourcePreview = previewReviewerRecovery(
          source.journal.getPlan().cells,
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
      },
      afterClaim: async (claim, ownership) => {
        const state = await loadConvergeRunState(
          options.gitCommonDir,
          options.target,
        );
        if (!state || !source || source === "already_quorate")
          fail("source_not_current");
        const requiredRound = source.sourceNativeClaim.round;
        if (
          !operation ||
          operation.successorNativeClaim?.attempt !== claim.attempt ||
          operation.successorNativeClaim.round !== requiredRound
        )
          fail("claim_mismatch");
        state.lastLaunch = {
          status: "pending",
          attempt: claim.attempt,
          round: requiredRound,
          headSha: options.headSha,
          inputSha256: options.inputSha256,
          startedAt: new Date().toISOString(),
          pid: process.pid,
          recovery: {
            sourceRunId: options.sourceRunId,
            originalNativeClaim: source.originalNativeClaim,
            sourceNativeClaim: source.sourceNativeClaim,
          },
        };
        await writeState(options.gitCommonDir, state, ownership);
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
            encodeRecoveryOperation(operation),
            ownership,
          );
          await options.run({ journal, operation, claim, ownership });
          const successorState = await journal.read();
          const terminal = await journal.readTerminalReport();
          if (!successorState.finalized || !terminal)
            fail("successor_terminal_missing");
          const successorProof = await exportCheckpointProof(journal);
          const inspected = inspectReviewerArtifact(
            terminal.reviewerArtifactBytes,
            {
              expectedReportBytes: terminal.reportBytes,
              expectedRunId: options.successorRunId,
              expectedTarget: options.target,
              expectedPlan: journal.getPlan(),
            },
          );
          const health = inspected.artifact.health;
          if (
            inspected.proof.digest !== successorProof.digest ||
            inspected.operation?.operationId !== operation.operationId ||
            inspected.operation?.successorNativeClaim?.attempt !==
              claim.attempt ||
            inspected.operation.successorNativeClaim.round !== requiredRound
          )
            fail("successor_proof_mismatch");
          await assertSuccessorAttempts(source, journal, operation);
          state.lastLaunch = {
            ...state.lastLaunch,
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
          };
        } catch (error) {
          state.lastLaunch = { ...state.lastLaunch, status: "failed" };
          failure = error;
        }
        state.updatedAt = new Date().toISOString();
        await writeState(options.gitCommonDir, state, ownership);
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
