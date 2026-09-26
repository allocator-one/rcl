import { mkdtemp, rm, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { guardReviewerRecoveryLaunch, guardReviewerRecoveryResume } from "../../src/converge/recovery-launch.js";
import { loadConvergeAttemptState } from "../../src/converge/attempt-budget.js";
import { guardReviewLaunch } from "../../src/converge/launch-guard.js";
import { loadConvergeRunState, convergeRunStatePath } from "../../src/converge/run-state.js";
import { recoverCapturedAssignments, recoveryAttemptsFromCheckpoint } from "../../src/dispatch/recovery.js";
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
import { applyReviewerRecovery, resumeReviewerRecovery } from "../../src/evidence/reviewer-recovery.js";
import { processReviewerRoundReport } from "../../src/converge/retained-report.js";
import { loadReviewerLineage } from "../../src/evidence/reviewer-lineage.js";

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

async function sealed(successes: number, failure: SourceFailure = "timeout", seats = 17,
  extra: { gatingMode?: 'all-findings' | 'verified-consensus'; supplementalAsync?: ReturnType<typeof captureSupplementalAsync> } = {}) {
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
    aggregation: { name: "consensus", version: 2 },
  });
  const roster = Array.from({ length: seats }, (_, index) => ({
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
    algorithm: { name: "consensus", version: 2 },
    diffSha256: plan.patchSha256,
    roleMap: new Map([["general", role]]),
    thresholds: config.thresholds,
    gating: {
      mode: extra.gatingMode ?? "all-findings",
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
            maxPhysicalCalls: seats,
            maxAttemptsPerCell: 1,
          }),
        ),
        ownership,
      );
      for (let index = 0; index < seats; index++) {
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
        supplementalAsync: extra.supplementalAsync ?? captureSupplementalAsync([], 0),
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
        totalReviews: seats,
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
      sources: source.assembly.projection.proofs.map((item: any) => ({ runId: item.runId, proof: item.proof })),
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

function coordinator(fixture: Fixture) {
  const startedAtMs = Date.now();
  const called = vi.fn(async (model: string, role: string) => ({
    model, role, provider: 'fake', status: 'success' as const, durationMs: 1, findings: [],
  }));
  const preflight = vi.fn(async () => {});
  return { called, preflight, input: {
    commonDir: fixture.dir, target, sourceRunId: fixture.id,
    successorRunId: '22222222-2222-4222-8222-222222222222',
    operationId: '33333333-3333-4333-8333-333333333333',
    currentHeadSha: head, freshCaptureBytes: fixture.captured.bytes,
    currentRunBindings: { target: fixture.run.target, roster: fixture.run.roster, spec: fixture.run.spec },
    rclVersion: 'test-successor', runner: { kind: 'agent' as const },
    startedAtMs, expiresAtMs: startedAtMs + 60_000, maxAdditionalCalls: 1, maxAttemptsPerCell: 2,
    preflight, adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }),
    onLateAuditError: vi.fn(),
  } };
}

describe('retained reviewer recovery coordinator', () => {
  it('composes one missing call into immutable terminal evidence before separate native intake', async () => {
    const fixture = await sealed(1, 'timeout', 3), options = coordinator(fixture);
    const result = await applyReviewerRecovery(options.input);
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('Expected completed recovery');
    expect(options.called).toHaveBeenCalledTimes(1);
    expect(options.called.mock.calls[0]![0]).toBe('m1');
    expect(options.preflight).toHaveBeenCalledTimes(1);
    expect(options.preflight.mock.invocationCallOrder[0]).toBeLessThan(options.called.mock.invocationCallOrder[0]!);
    expect(result.health).toMatchObject({ conclusive: true, successfulSeats: ['s0', 's1'] });
    const combined = await loadReviewerLineage({ commonDir: await realpath(fixture.dir), target, runId: options.input.successorRunId });
    expect(combined.runs[0]!.terminal).toEqual(fixture.sourceTerminal);
    expect(combined.latest.terminal.reportBytes).toBe(result.terminal.reportBytes);
    expect(combined.latest.inspected.artifact.newPhysicalAttempts).toHaveLength(1);
    expect(JSON.parse(result.terminal.reportBytes)).toMatchObject({
      run: { id: options.input.successorRunId, rcl_version: 'test-successor', reviewer_evidence: { kind: 'supplemented' } },
      findings: [expect.objectContaining({ id: 'f' })],
    });
    expect((await runState(fixture))!.rounds).toEqual([]);
    const admitted = await processReviewerRoundReport({ gitCommonDir: fixture.dir, target, round: 1,
      currentHeadSha: head, reportBytes: result.terminal.reportBytes });
    expect(admitted).toMatchObject({ counts: { new: 1 }, findings: [{ status: 'new', finding: { id: 'f' } }] });
    expect((await runState(fixture))!.rounds).toMatchObject([{ runId: options.input.successorRunId }]);
  });

  it('refuses unsupported server or owner preflight without spending a native attempt', async () => {
    const fixture = await sealed(1, 'timeout', 3), options = coordinator(fixture);
    options.preflight.mockRejectedValueOnce(new Error('server_recovery_unsupported'));
    await expect(applyReviewerRecovery(options.input)).rejects.toThrow('server_recovery_unsupported');
    expect(options.called).not.toHaveBeenCalled();
    expect(await state(fixture)).toMatchObject({ attemptsUsed: 1 });
  });

  it.each(['head', 'roster', 'spec'])('refuses fresh %s drift before preflight or calls', async field => {
    const fixture = await sealed(1, 'timeout', 3), options = coordinator(fixture);
    const input = structuredClone({ currentRunBindings: options.input.currentRunBindings });
    if (field === 'roster') input.currentRunBindings.roster[0].model = 'changed';
    if (field === 'spec') input.currentRunBindings.spec.sha256 = 'f'.repeat(64);
    await expect(applyReviewerRecovery({ ...options.input, ...input,
      currentHeadSha: field === 'head' ? 'c'.repeat(40) : head })).rejects.toThrow('reviewer_recovery_input_mismatch');
    expect(options.preflight).not.toHaveBeenCalled();
    expect(options.called).not.toHaveBeenCalled();
    expect(await state(fixture)).toMatchObject({ attemptsUsed: 1 });
  });

  it('resumes a durable result after expiry without another call or budget renewal', async () => {
    const fixture = await sealed(1, 'timeout', 3), options = coordinator(fixture);
    await expect(applyReviewerRecovery({ ...options.input,
      onPhysicalReviewComplete: () => { throw new Error('crash_after_durable_result'); },
    })).rejects.toThrow('crash_after_durable_result');
    const spent = await state(fixture), prior = await runState(fixture);
    options.called.mockClear();
    const resumed = await resumeReviewerRecovery({ ...options.input, nowMs: () => options.input.expiresAtMs + 1 });
    expect(resumed.health.conclusive).toBe(true);
    expect(options.called).not.toHaveBeenCalled();
    expect(await state(fixture)).toEqual(spent);
    expect((await runState(fixture))!.lastLaunch!.pid).toBe(prior!.lastLaunch!.pid);
    expect(resumed.operation.expiresAtMs).toBe(options.input.expiresAtMs);
    expect(resumed.operation.maxAdditionalCalls).toBe(1);
  });

  it('finishes a sealed checkpoint after aggregation interruption with zero provider calls', async () => {
    const fixture = await sealed(1, 'timeout', 3), options = coordinator(fixture);
    await expect(applyReviewerRecovery({ ...options.input, onStage: (stage: string) => {
      if (stage === 'assembling the terminal report') throw new Error('aggregation_interrupted');
    } })).rejects.toThrow('aggregation_interrupted');
    options.called.mockClear();
    const resumed = await resumeReviewerRecovery(options.input);
    expect(resumed.health.conclusive).toBe(true);
    expect(options.called).not.toHaveBeenCalled();
    expect(await state(fixture)).toMatchObject({ attemptsUsed: 2 });
  });

  it('replays completed recovery byte-for-byte with no native writes or provider calls', async () => {
    const fixture = await sealed(1, 'timeout', 3), options = coordinator(fixture);
    const first = await applyReviewerRecovery(options.input);
    if (first.kind !== 'completed') throw new Error('Expected completed recovery');
    const native = await runState(fixture), spent = await state(fixture);
    options.called.mockClear();
    const replay = await resumeReviewerRecovery(options.input);
    expect(replay.reusedTerminal).toBe(true);
    expect(replay.terminal).toEqual(first.terminal);
    expect(options.called).not.toHaveBeenCalled();
    expect(await runState(fixture)).toEqual(native);
    expect(await state(fixture)).toEqual(spent);
  });

  it('refuses an unjournaled verifier before preflight, a new claim or provider calls', async () => {
    const fixture = await sealed(1, 'timeout', 3, { gatingMode: 'verified-consensus' }), options = coordinator(fixture);
    await expect(applyReviewerRecovery(options.input)).rejects.toThrow('reviewer_recovery_verifier_retention_required');
    expect(options.preflight).not.toHaveBeenCalled();
    expect(options.called).not.toHaveBeenCalled();
    expect(await state(fixture)).toMatchObject({ attemptsUsed: 1 });
  });

  it('preserves the frozen async snapshot and never counts it as a blocking seat', async () => {
    const bonus = { model: 'bonus', role: 'general', provider: 'fake', status: 'success', durationMs: 1, async: true,
      findings: [{ id: 'async-f', file: 'bonus.ts', startLine: 2, endLine: 2, severity: 'critical',
        category: 'correctness', title: 'Retained async observation', description: 'original async result' }] };
    const supplementalAsync = captureSupplementalAsync([JSON.stringify(bonus)], 1);
    const fixture = await sealed(1, 'timeout', 3, { supplementalAsync }), options = coordinator(fixture);
    const result = await applyReviewerRecovery(options.input);
    if (result.kind !== 'completed') throw new Error('Expected completed recovery');
    const lineage = await loadReviewerLineage({ commonDir: await realpath(fixture.dir), target, runId: options.input.successorRunId });
    expect(lineage.latest.inspected.supplementalAsync.bytes).toBe(supplementalAsync.bytes);
    expect(result.health.successfulSeats).toEqual(['s0', 's1']);
    expect(options.called).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.terminal.reportBytes).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'f' }), expect.objectContaining({ id: 'async-f', severity: 'critical' }),
    ]));
  });

  it('makes no calls or native changes when the source already meets quorum', async () => {
    const fixture = await sealed(2, 'timeout', 3), options = coordinator(fixture);
    const before = await state(fixture), native = await runState(fixture);
    expect(await applyReviewerRecovery(options.input)).toEqual({ kind: 'already_quorate', sourceRunId: fixture.id });
    expect(options.called).not.toHaveBeenCalled();
    expect(await state(fixture)).toEqual(before);
    expect(await runState(fixture)).toEqual(native);
  });

  it('snapshots operation bounds and fresh inputs before awaiting owner preflight', async () => {
    const fixture = await sealed(1, 'timeout', 3), options = coordinator(fixture);
    const expiry = options.input.expiresAtMs;
    options.preflight.mockImplementationOnce(async () => {
      options.input.maxAdditionalCalls = 99;
      options.input.expiresAtMs += 99_000;
      options.input.sourceRunId = '44444444-4444-4444-8444-444444444444';
      options.input.currentRunBindings.roster[0].model = 'changed during preflight';
    });
    const result = await applyReviewerRecovery(options.input);
    if (result.kind !== 'completed') throw new Error('Expected completed recovery');
    expect(result.operation).toMatchObject({ maxAdditionalCalls: 1, expiresAtMs: expiry, sourceRunId: fixture.id });
    expect(options.called).toHaveBeenCalledTimes(1);
  });

  it('keeps an unknown paid outcome spent and inconclusive instead of reissuing the call', async () => {
    const fixture = await sealed(1, 'timeout', 3), options = coordinator(fixture);
    const guardOptions = opts(fixture, {
      startedAtMs: options.input.startedAtMs, expiresAtMs: options.input.expiresAtMs,
      nowMs: () => options.input.startedAtMs + 1,
      run: async ({ journal, ownership }: any) => {
        await journal.recordIntent('s1:0', { id: 'unknown-outcome', kind: 'paid' }, ownership);
        throw new Error('interrupted after paid intent');
      },
    });
    await expect(guardReviewerRecoveryLaunch(guardOptions)).rejects.toThrow('interrupted after paid intent');
    const result = await resumeReviewerRecovery(options.input);
    expect(options.called).not.toHaveBeenCalled();
    expect(result.health).toMatchObject({ conclusive: false, successfulSeats: ['s0'] });
    expect(await state(fixture)).toMatchObject({ attemptsUsed: 2 });
    await expect(processReviewerRoundReport({ gitCommonDir: fixture.dir, target, round: 1,
      currentHeadSha: head, reportBytes: result.terminal.reportBytes })).rejects.toThrow('supplemented_report_inconclusive_health');
    expect((await runState(fixture))!.rounds).toEqual([]);
  });
});

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



  it("already-quorate source spends nothing", async () => {
    const fixture = await sealed(12);
    const value: any = opts(fixture);
    await expect(guardReviewerRecoveryLaunch(value)).resolves.toMatchObject({
      kind: "already_quorate",
    });
    expect(await state(fixture)).toMatchObject({ attemptsUsed: 1 });
  });
});


function resumeOptions(value: ReturnType<typeof opts>) {
  return { gitCommonDir: value.gitCommonDir, target: value.target, successorRunId: value.successorRunId,
    headSha: value.headSha, inputSha256: value.inputSha256, nowMs: value.nowMs, run: value.run };
}

describe('same-operation guarded reviewer recovery resume', () => {
  it('revalidates a completed terminal and returns without a new claim or callback', async () => {
    const fixture = await sealed(1, 'timeout', 3), value: any = opts(fixture);
    value.run = async (context: any) => { await sealSuccessor(fixture, context, [{ cell: 's1:0' }]); };
    await guardReviewerRecoveryLaunch(value);
    const attempts = await state(fixture), native = await runState(fixture);
    const resume = { ...resumeOptions(value), run: vi.fn() };
    const result = await guardReviewerRecoveryResume(resume);
    expect(result).toMatchObject({ kind: 'resumed', reusedTerminal: true, claim: { attempt: 2, cap: 3 } });
    expect(resume.run).not.toHaveBeenCalled();
    expect(await state(fixture)).toEqual(attempts);
    expect(await runState(fixture)).toEqual(native);
  });

  it('resumes failure before dispatch with the same claim and immutable original PID', async () => {
    const fixture = await sealed(1, 'timeout', 3), value: any = opts(fixture);
    value.run = async () => { throw new Error('interrupted before dispatch'); };
    await expect(guardReviewerRecoveryLaunch(value)).rejects.toThrow('interrupted before dispatch');
    const attempts = await state(fixture), before = await runState(fixture);
    const resume = { ...resumeOptions(value), run: vi.fn(async (context: any) => {
      expect(context.claim).toMatchObject({ attempt: 2, cap: 3 });
      expect(context.claim.stateFile).not.toBe('');
      await sealSuccessor(fixture, context, [{ cell: 's1:0' }]);
    }) };
    await expect(guardReviewerRecoveryResume(resume)).resolves.toMatchObject({ kind: 'resumed', reusedTerminal: false });
    expect(resume.run).toHaveBeenCalledTimes(1);
    expect(await state(fixture)).toEqual(attempts);
    expect(await runState(fixture)).toMatchObject({ lastLaunch: { status: 'completed',
      pid: before!.lastLaunch!.pid, successfulReviews: 2, totalReviews: 3,
      recovery: { resume: { pid: process.pid, phase: 'finished' } } } });
  });

  it('repairs completion after terminal retention without calling the callback again', async () => {
    const fixture = await sealed(1, 'timeout', 3), value: any = opts(fixture);
    value.run = async (context: any) => {
      await sealSuccessor(fixture, context, [{ cell: 's1:0' }]);
      throw new Error('interrupted after terminal');
    };
    await expect(guardReviewerRecoveryLaunch(value)).rejects.toThrow('interrupted after terminal');
    const attempts = await state(fixture);
    const resume = { ...resumeOptions(value), nowMs: () => clock + 600_000, run: vi.fn() };
    await expect(guardReviewerRecoveryResume(resume)).resolves.toMatchObject({ kind: 'resumed', reusedTerminal: true });
    expect(resume.run).not.toHaveBeenCalled();
    expect(await state(fixture)).toEqual(attempts);
    expect(await runState(fixture)).toMatchObject({ lastLaunch: { status: 'completed', successfulReviews: 2 } });
  });

  it('serializes two resumes and completes one callback without double spending', async () => {
    const fixture = await sealed(1, 'timeout', 3), value: any = opts(fixture);
    value.run = async () => { throw new Error('interrupted'); };
    await expect(guardReviewerRecoveryLaunch(value)).rejects.toThrow('interrupted');
    const resume = { ...resumeOptions(value), run: vi.fn(async (context: any) => {
      await sealSuccessor(fixture, context, [{ cell: 's1:0' }]);
    }) };
    const results = await Promise.allSettled([guardReviewerRecoveryResume(resume), guardReviewerRecoveryResume(resume)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(resume.run).toHaveBeenCalledTimes(1);
    expect(await state(fixture)).toMatchObject({ attemptsUsed: 2, cap: 3 });
  });

  it('refuses head or full input drift before reopening a spent operation', async () => {
    const fixture = await sealed(1, 'timeout', 3), value: any = opts(fixture);
    value.run = async () => { throw new Error('interrupted'); };
    await expect(guardReviewerRecoveryLaunch(value)).rejects.toThrow('interrupted');
    const attempts = await state(fixture), native = await runState(fixture), run = vi.fn();
    await expect(guardReviewerRecoveryResume({ ...resumeOptions(value), headSha: 'c'.repeat(40), run })).rejects.toThrow('recovery_launch_resume_input_mismatch');
    await expect(guardReviewerRecoveryResume({ ...resumeOptions(value), inputSha256: 'c'.repeat(64), run })).rejects.toThrow('recovery_launch_resume_input_mismatch');
    expect(run).not.toHaveBeenCalled();
    expect(await state(fixture)).toEqual(attempts);
    expect(await runState(fixture)).toEqual(native);
  });

  it('retains a durable success across interruption and finishes after expiry without another provider call', async () => {
    const fixture = await sealed(1, 'timeout', 3), value: any = opts(fixture);
    value.run = async (context: any) => {
      const attempt = { id: 'durable-before-crash', kind: 'paid' as const };
      await context.journal.recordIntent('s1:0', attempt, context.ownership);
      await context.journal.recordResult('s1:0', attempt, { kind: 'success', chunk: 0,
        reviewBytes: JSON.stringify(review(1, 'success')) }, context.ownership);
      throw new Error('interrupted after durable result');
    };
    await expect(guardReviewerRecoveryLaunch(value)).rejects.toThrow('interrupted after durable result');
    const attempts = await state(fixture), provider = vi.fn();
    const resume = { ...resumeOptions(value), nowMs: () => clock + 600_000, run: async (context: any) => {
      const result = await recoverCapturedAssignments({ commonDir: fixture.dir, ownership: context.ownership,
        journal: context.journal, operation: context.operation, expectedPlan: fixture.plan,
        sourceAttempts: recoveryAttemptsFromCheckpoint(fixture.sourceProof.state), nowMs: () => clock + 600_000,
        adapterFactory: provider });
      expect(result.preview.successfulSeats).toBe(2);
      expect(result.newAttempts).toBe(1);
      await sealSuccessor(fixture, context, []);
    } };
    await expect(guardReviewerRecoveryResume(resume)).resolves.toMatchObject({ kind: 'resumed' });
    expect(provider).not.toHaveBeenCalled();
    expect(await state(fixture)).toEqual(attempts);
    expect(await runState(fixture)).toMatchObject({ lastLaunch: { status: 'completed', successfulReviews: 2 } });
  });

  it('keeps an interrupted provider intent uncertain and spent instead of issuing it again', async () => {
    const fixture = await sealed(1, 'timeout', 3), value: any = opts(fixture);
    value.run = async (context: any) => {
      await context.journal.recordIntent('s1:0', { id: 'unknown-before-crash', kind: 'paid' }, context.ownership);
      throw new Error('interrupted with unknown outcome');
    };
    await expect(guardReviewerRecoveryLaunch(value)).rejects.toThrow('interrupted with unknown outcome');
    const attempts = await state(fixture), provider = vi.fn();
    await guardReviewerRecoveryResume({ ...resumeOptions(value), run: async (context: any) => {
      const result = await recoverCapturedAssignments({ commonDir: fixture.dir, ownership: context.ownership,
        journal: context.journal, operation: context.operation, expectedPlan: fixture.plan,
        sourceAttempts: recoveryAttemptsFromCheckpoint(fixture.sourceProof.state), nowMs: value.nowMs, adapterFactory: provider });
      expect(result.newAttempts).toBe(1);
      expect(result.preview.successfulSeats).toBe(1);
      expect((await context.journal.read()).uncertain).toHaveLength(1);
      await sealSuccessor(fixture, context, []);
    } });
    expect(provider).not.toHaveBeenCalled();
    expect(await state(fixture)).toEqual(attempts);
    expect(await runState(fixture)).toMatchObject({ lastLaunch: { status: 'completed', successfulReviews: 1 } });
  });

  it.each(['alive', 'unverifiable', 'dead'] as const)('handles a pending %s owner conservatively', async kind => {
    const fixture = await sealed(1, 'timeout', 3), value: any = opts(fixture);
    value.run = async () => { throw new Error('interrupted'); };
    await expect(guardReviewerRecoveryLaunch(value)).rejects.toThrow('interrupted');
    const path = convergeRunStatePath(fixture.dir, target), native = JSON.parse(await readFile(path, 'utf8'));
    native.lastLaunch.status = 'pending';
    await writeFile(path, JSON.stringify(native));
    const before = await state(fixture), run = vi.fn(async (context: any) => { await sealSuccessor(fixture, context, [{ cell: 's1:0' }]); });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (kind === 'alive') return true;
      throw Object.assign(new Error('pid probe'), { code: kind === 'dead' ? 'ESRCH' : 'EPERM' });
    });
    try {
      if (kind === 'dead') {
        await expect(guardReviewerRecoveryResume({ ...resumeOptions(value), run })).resolves.toMatchObject({ kind: 'resumed' });
        expect(run).toHaveBeenCalledTimes(1);
      } else {
        await expect(guardReviewerRecoveryResume({ ...resumeOptions(value), run })).rejects.toThrow(
          kind === 'alive' ? 'recovery_launch_resume_owner_alive' : 'recovery_launch_resume_owner_unverifiable');
        expect(run).not.toHaveBeenCalled();
        expect(await runState(fixture)).toEqual(native);
      }
      expect(await state(fixture)).toEqual(before);
    } finally { kill.mockRestore(); }
  });
});
