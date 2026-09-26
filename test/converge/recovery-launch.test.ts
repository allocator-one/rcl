import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { guardReviewerRecoveryLaunch } from "../../src/converge/recovery-launch.js";
import { loadConvergeAttemptState } from "../../src/converge/attempt-budget.js";
import { guardReviewLaunch } from "../../src/converge/launch-guard.js";
import { loadConvergeRunState } from "../../src/converge/run-state.js";
import {
  CheckpointJournal,
  exportCheckpointProof,
  freezeCheckpointPlan,
} from "../../src/dispatch/checkpoint.js";
import { captureReviewerInputs } from "../../src/dispatch/captured-inputs.js";
import {
  createOriginalLaunch,
  encodeOriginalLaunch,
} from "../../src/dispatch/original-launch.js";
import { captureAggregationInputs } from "../../src/report/aggregation-inputs.js";
import { captureSupplementalAsync } from "../../src/report/supplemental-async.js";
import { projectCheckpointReport } from "../../src/report/checkpoint-projection.js";
import { assembleCheckpointReview } from "../../src/report/checkpoint-assembly.js";
import {
  inspectReviewerArtifact,
  serializeReviewerArtifact,
} from "../../src/report/reviewer-artifact.js";
import { retainedLaunchInputSha256 } from "../../src/converge/retained-report.js";
import {
  configDigest,
  diffDigest,
  sha256Hex,
  stableStringify,
} from "../../src/report/run-header.js";
import { sanitizeForDelivery } from "../../src/telemetry/envelope.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const target = "allocator-one/rcl#105";
const head = "a".repeat(40);
const role = {
  name: "general",
  systemPrompt: "s",
  focus: [],
  description: "d",
  isSpecialized: false,
};
const clock = 1_800_000_000_000;

type SourceFailure = "timeout" | "permanent" | "unclassified" | "uncertain";
type Fixture = Awaited<ReturnType<typeof sealed>>;
type Action = { cell: string; status?: "success" | "error"; error?: string };

function review(
  index: number,
  status: "success" | "timeout" | "error",
  error?: string,
): object {
  return {
    model: `m${index}`,
    role: "general",
    provider: "fake",
    status,
    durationMs: 1,
    ...(error ? { error } : {}),
    findings:
      index === 0
        ? [
            {
              id: "f",
              file: "a.ts",
              startLine: 1,
              endLine: 1,
              severity: "important",
              category: "correctness",
              title: "t",
              description: "d",
            },
          ]
        : [],
  };
}

async function sealed(successes: number, failure: SourceFailure = "timeout") {
  const dir = await mkdtemp(join(tmpdir(), "rcl-recovery-"));
  roots.push(dir);
  const diff: any = {
    source: "local",
    files: [
      {
        filename: "a.ts",
        status: "modified",
        patch: "@@\n+x",
        additions: 1,
        deletions: 0,
        language: "typescript",
      },
    ],
  };
  const config: any = {
    quorumFraction: 2 / 3,
    thresholds: {
      minConsensusScore: 0,
      minConfidence: 0,
      dedupeLineWindow: 5,
      jaccardThreshold: 0.3,
    },
    output: { belowThresholdAppendix: true },
  };
  const patch = stableStringify(
    diff.files.map((file: any) => ({
      filename: file.filename,
      status: file.status,
      previousFilename: null,
      patch: file.patch,
      additions: file.additions,
      deletions: file.deletions,
      blobSha: null,
    })),
  );
  const tools = stableStringify({
    parser: { name: "findings-json", version: 1 },
    aggregation: { name: "consensus", version: 1 },
  });
  const roster = Array.from({ length: 17 }, (_, index) => ({
    seat: `s${index}`,
    model: `m${index}`,
    role: "general",
    route: "fake",
  }));
  const plan = freezeCheckpointPlan({
    target,
    headSha: head,
    mergeBaseSha: "b".repeat(40),
    patchSha256: diffDigest(diff.files),
    configSha256: configDigest(config),
    specSha256: sha256Hex("s"),
    contextSha256: sha256Hex("[]"),
    toolsSha256: sha256Hex(tools),
    parser: { name: "findings-json", version: 1 },
    roster,
    chunks: [{ index: 0, total: 1, digest: sha256Hex("chunk") }],
    prompts: roster.map((seat) => ({
      seat: seat.seat,
      chunk: 0,
      systemSha256: sha256Hex("sys"),
      userSha256: sha256Hex("u"),
    })),
  });
  const aggregation = captureAggregationInputs({
    algorithm: { name: "consensus", version: 1 },
    diffSha256: plan.patchSha256,
    roleMap: new Map([["general", role]]),
    thresholds: config.thresholds,
    gating: {
      mode: "all-findings",
      minModels: 2,
      verificationTimeoutMs: 100,
      verificationPassTimeoutMs: 100,
    },
    belowThresholdAppendix: true,
  });
  const captured = captureReviewerInputs({
    plan,
    policy: { version: 1, fraction: 2 / 3 },
    patchBytes: patch,
    configBytes: stableStringify(config),
    specBytes: "s",
    contextBytes: "[]",
    toolsBytes: tools,
    chunkBytes: ["chunk"],
    assignments: plan.cells.map((cell) => ({
      model: cell.model,
      provider: cell.route,
      role,
    })),
    prompts: plan.cells.map(() => ({ systemPrompt: "sys", userPrompt: "u" })),
    aggregation,
  });
  const id = "11111111-1111-4111-8111-111111111111";
  const run: any = {
    id,
    rclVersion: "x",
    command: "review",
    target: {
      kind: "patch",
      repo: "allocator-one/rcl",
      prNumber: 105,
      headSha: head,
      baseSha: plan.mergeBaseSha,
    },
    roster: roster.map((seat) => ({
      model: seat.model,
      role: seat.role,
      provider: seat.route,
      lane: "blocking",
    })),
    spec: { source: "flag", sha256: plan.specSha256 },
    contextFiles: [],
    runner: { kind: "agent" },
    startedAt: new Date(1000),
    converge: { target, round: 1, attempt: 1 },
  };
  let sourceProof: any;
  let sourceTerminal: any;
  await guardReviewLaunch({
    gitCommonDir: dir,
    target,
    headSha: head,
    inputSha256: retainedLaunchInputSha256(captured.digest, run),
    maxAttempts: 3,
    validate: async () => {},
    run: async (_, ownership) => {
      const journal = await CheckpointJournal.create({
        commonDir: dir,
        namespace: id,
        plan,
        ownership,
      });
      await journal.bind("captured-inputs", captured.bytes, ownership);
      await journal.bind(
        "launch",
        encodeOriginalLaunch(
          createOriginalLaunch({
            runId: id,
            target,
            originalNativeClaim: { attempt: 1, round: 1 },
            capturedInputsSha256: captured.digest,
            planDigest: plan.digest,
            startedAtMs: clock,
            expiresAtMs: clock + 60_000,
            maxPhysicalCalls: 17,
            maxAttemptsPerCell: 1,
          }),
        ),
        ownership,
      );
      for (let index = 0; index < 17; index++) {
        const attempt = { id: `a${index}`, kind: "paid" as const };
        await journal.recordIntent(`s${index}:0`, attempt, ownership);
        if (index < successes) {
          await journal.recordResult(
            `s${index}:0`,
            attempt,
            {
              kind: "success",
              chunk: 0,
              reviewBytes: JSON.stringify(review(index, "success")),
            },
            ownership,
          );
        } else if (failure !== "uncertain") {
          const outcome =
            failure === "timeout"
              ? review(index, "timeout", "timeout")
              : failure === "permanent"
                ? review(index, "error", "401 authentication")
                : review(index, "error", "opaque");
          await journal.recordResult(
            `s${index}:0`,
            attempt,
            {
              kind: "failure",
              chunk: 0,
              reviewBytes: JSON.stringify(outcome),
              possiblyBilled: true,
            },
            ownership,
          );
        }
      }
      await journal.finalize(ownership);
      const proof = await exportCheckpointProof(journal);
      const assembly: any = {
        projection: projectCheckpointReport({
          sources: [],
          successor: { runId: id, proof },
          policy: captured.policy,
        }),
        supplementalAsync: captureSupplementalAsync([], 0),
        diff,
        startTime: 1,
        run,
      };
      const report = await assembleCheckpointReview(assembly);
      const reportBytes = JSON.stringify(sanitizeForDelivery(report.report));
      await journal.retainTerminalReport(
        {
          reportBytes,
          reviewerArtifactBytes: serializeReviewerArtifact({
            assembly,
            reportBytes,
            representation: { version: 1, parseFailures: false },
          }).bytes,
        },
        ownership,
      );
      sourceProof = proof;
      sourceTerminal = await journal.readTerminalReport();
      return {
        runId: id,
        reportJsonSha256: sha256Hex(reportBytes),
        successfulReviews: successes,
        totalReviews: 17,
        deliveryPending: false,
        hardFailure: true,
        reviewerHealth: {
          version: 1,
          policy: assembly.projection.health.policy,
          successfulSeats: successes,
        },
      };
    },
  });
  return { dir, plan, captured, id, sourceProof, sourceTerminal, run };
}

function opts(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    gitCommonDir: fixture.dir,
    target,
    sourceRunId: fixture.id,
    successorRunId: "22222222-2222-4222-8222-222222222222",
    operationId: "33333333-3333-4333-8333-333333333333",
    headSha: head,
    inputSha256: retainedLaunchInputSha256(
      fixture.captured.digest,
      fixture.run,
    ),
    startedAtMs: clock + 1,
    expiresAtMs: clock + 60_000,
    maxAdditionalCalls: 1,
    maxAttemptsPerCell: 2,
    nowMs: () => clock + 2,
    run: vi.fn(),
    ...overrides,
  };
}

async function sealSuccessor(
  fixture: Fixture,
  value: any,
  actions: readonly Action[],
  options: { intentsFirst?: boolean } = {},
) {
  const source = inspectReviewerArtifact(
    fixture.sourceTerminal.reviewerArtifactBytes,
    {
      expectedReportBytes: fixture.sourceTerminal.reportBytes,
      expectedRunId: fixture.id,
      expectedTarget: target,
      expectedPlan: fixture.plan,
    },
  );
  const prepared = actions.map((action, index) => ({
    action,
    index: Number(action.cell.slice(1, action.cell.indexOf(":"))),
    attempt: { id: `new-${index}`, kind: "paid" as const },
  }));
  for (const item of prepared) {
    await value.journal.recordIntent(
      item.action.cell,
      item.attempt,
      value.ownership,
    );
    if (!options.intentsFirst) await recordResult(item);
  }
  if (options.intentsFirst) {
    for (const item of prepared) await recordResult(item);
  }

  async function recordResult(item: (typeof prepared)[number]) {
    const { action, attempt, index } = item;
    const outcome = review(index, action.status ?? "success", action.error);
    await value.journal.recordResult(
      action.cell,
      attempt,
      action.status === "success" || action.status === undefined
        ? { kind: "success", chunk: 0, reviewBytes: JSON.stringify(outcome) }
        : {
            kind: "failure",
            chunk: 0,
            reviewBytes: JSON.stringify(outcome),
            possiblyBilled: true,
          },
      value.ownership,
    );
  }
  await value.journal.finalize(value.ownership);
  const proof = await exportCheckpointProof(value.journal);
  const run = {
    ...source.assembly.run,
    id: value.operation.successorRunId,
    converge: { target, round: 1, attempt: value.claim.attempt },
  };
  const assembly: any = {
    ...source.assembly,
    projection: projectCheckpointReport({
      sources: [{ runId: fixture.id, proof: fixture.sourceProof }],
      successor: { runId: value.operation.successorRunId, proof },
      policy: fixture.captured.policy,
    }),
    run,
  };
  const report = await assembleCheckpointReview(assembly);
  const reportBytes = JSON.stringify(sanitizeForDelivery(report.report));
  await value.journal.retainTerminalReport(
    {
      reportBytes,
      reviewerArtifactBytes: serializeReviewerArtifact({
        assembly,
        reportBytes,
        representation: { version: 1, parseFailures: false },
      }).bytes,
    },
    value.ownership,
  );
  return {
    health: assembly.projection.health,
    findings: report.report.findings,
  };
}

async function state(fixture: Fixture) {
  return loadConvergeAttemptState(fixture.dir, target);
}

async function runState(fixture: Fixture) {
  return loadConvergeRunState(fixture.dir, target);
}

describe("proof-bearing reviewer recovery launch", () => {
  it("refuses missing legacy capture before a new native attempt or callback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rcl-recovery-"));
    roots.push(dir);
    const value: any = {
      gitCommonDir: dir,
      target,
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      successorRunId: "22222222-2222-4222-8222-222222222222",
      operationId: "33333333-3333-4333-8333-333333333333",
      headSha: head,
      inputSha256: "b".repeat(64),
      startedAtMs: clock,
      expiresAtMs: clock + 1,
      maxAdditionalCalls: 1,
      maxAttemptsPerCell: 1,
      run: vi.fn(),
    };
    await expect(guardReviewerRecoveryLaunch(value)).rejects.toThrow();
    expect(value.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(dir, target)).toBeUndefined();
  });

  it("claims and seals one 12/17 successor at the same unadmitted round", async () => {
    const fixture = await sealed(11);
    const value: any = opts(fixture);
    let combined: any;
    value.run = vi.fn(async (context: any) => {
      combined = await sealSuccessor(fixture, context, [{ cell: "s11:0" }]);
    });
    const result: any = await guardReviewerRecoveryLaunch(value);
    expect(result).toMatchObject({ kind: "claimed", claim: { attempt: 2 } });
    expect(result.operation.successorNativeClaim).toEqual({
      attempt: 2,
      round: 1,
    });
    expect(combined.health.successfulSeats).toHaveLength(12);
    expect(combined.health.policy).toMatchObject({ seatCount: 17 });
    expect(combined.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "f" })]),
    );
    await expect(guardReviewerRecoveryLaunch(value)).rejects.toThrow(
      "recovery_launch_source_not_current",
    );
    expect(await state(fixture)).toMatchObject({ attemptsUsed: 2 });
    expect(value.run).toHaveBeenCalledTimes(1);
  });

  it("refuses an expired persisted operation before a new native claim or callback", async () => {
    const fixture = await sealed(11);
    const value: any = opts(fixture, { nowMs: () => clock + 60_000 });
    await expect(guardReviewerRecoveryLaunch(value)).rejects.toThrow(
      "recovery_launch_operation_expired",
    );
    expect(await state(fixture)).toMatchObject({ attemptsUsed: 1 });
    expect(value.run).not.toHaveBeenCalled();
  });

  it("does not complete when the sealed successor exceeds maxAdditionalCalls", async () => {
    const fixture = await sealed(11);
    const value: any = opts(fixture);
    value.run = async (context: any) => {
      await sealSuccessor(fixture, context, [
        { cell: "s11:0" },
        { cell: "s12:0" },
      ]);
    };
    await expect(guardReviewerRecoveryLaunch(value)).rejects.toThrow(
      "recovery_launch_successor_additional_call_limit",
    );
    expect(await state(fixture)).toMatchObject({ attemptsUsed: 2 });
    expect(await runState(fixture)).toMatchObject({
      lastLaunch: { status: "failed" },
    });
  });

  it("refuses an exhausted cumulative per-cell cap before a new attempt", async () => {
    const fixture = await sealed(11);
    const value: any = opts(fixture, { maxAttemptsPerCell: 1 });
    await expect(guardReviewerRecoveryLaunch(value)).rejects.toThrow(
      "recovery_launch_source_not_actionable",
    );
    expect(await state(fixture)).toMatchObject({ attemptsUsed: 1 });
    expect(value.run).not.toHaveBeenCalled();
  });

  it("does not complete when callback retries a retained success", async () => {
    const fixture = await sealed(11);
    const value: any = opts(fixture);
    value.run = async (context: any) => {
      await sealSuccessor(fixture, context, [{ cell: "s0:0" }]);
    };
    await expect(guardReviewerRecoveryLaunch(value)).rejects.toThrow(
      "checkpoint_projection_success_resampled",
    );
    expect(await state(fixture)).toMatchObject({ attemptsUsed: 2 });
    expect(await runState(fixture)).toMatchObject({
      lastLaunch: { status: "failed" },
    });
  });

  it.each(["permanent", "unclassified", "uncertain"] as const)(
    "refuses a %s-only source before a new native claim",
    async (failure) => {
      const fixture = await sealed(11, failure);
      const value: any = opts(fixture);
      await expect(guardReviewerRecoveryLaunch(value)).rejects.toThrow(
        "recovery_launch_source_not_actionable",
      );
      expect(await state(fixture)).toMatchObject({ attemptsUsed: 1 });
      expect(value.run).not.toHaveBeenCalled();
    },
  );

  it("accepts two durable intents recorded before either result reaches quorum", async () => {
    const fixture = await sealed(11);
    const value: any = opts(fixture, { maxAdditionalCalls: 2 });
    let combined: any;
    value.run = async (context: any) => {
      combined = await sealSuccessor(
        fixture,
        context,
        [{ cell: "s11:0" }, { cell: "s12:0" }],
        { intentsFirst: true },
      );
    };
    await expect(guardReviewerRecoveryLaunch(value)).resolves.toMatchObject({
      kind: "claimed",
      claim: { attempt: 2 },
    });
    expect(combined.health.successfulSeats).toHaveLength(13);
  });

  it("does not relabel on-time sealed work as expired after callback readback", async () => {
    const fixture = await sealed(11);
    let now = clock + 2;
    const value: any = opts(fixture, { nowMs: () => now });
    value.run = async (context: any) => {
      await sealSuccessor(fixture, context, [{ cell: "s11:0" }]);
      now = clock + 60_000;
    };
    await expect(guardReviewerRecoveryLaunch(value)).resolves.toMatchObject({
      kind: "claimed",
      claim: { attempt: 2 },
    });
    expect(await runState(fixture)).toMatchObject({
      lastLaunch: { status: "completed" },
    });
  });

  it("refuses a successor-of-successor source before claiming", async () => {
    const fixture = await sealed(11);
    const first: any = opts(fixture);
    first.run = async (context: any) => {
      await sealSuccessor(fixture, context, [{ cell: "s11:0" }]);
    };
    await guardReviewerRecoveryLaunch(first);
    const second: any = opts(fixture, {
      sourceRunId: first.successorRunId,
      successorRunId: "44444444-4444-4444-8444-444444444444",
      operationId: "55555555-5555-4555-8555-555555555555",
    });
    await expect(guardReviewerRecoveryLaunch(second)).rejects.toThrow(
      "recovery_launch_successor_source_unsupported",
    );
    expect(await state(fixture)).toMatchObject({ attemptsUsed: 2 });
    expect(second.run).not.toHaveBeenCalled();
  });

  it("already-quorate source spends nothing", async () => {
    const fixture = await sealed(12);
    const value: any = opts(fixture);
    await expect(guardReviewerRecoveryLaunch(value)).resolves.toMatchObject({
      kind: "already_quorate",
    });
    expect(await state(fixture)).toMatchObject({ attemptsUsed: 1 });
  });
});
