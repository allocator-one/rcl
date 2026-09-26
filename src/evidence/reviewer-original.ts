import { retainedPaidCutoff } from './retained-time-budget.js';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_MAX_RETRIES } from '../config/defaults.js';
import { guardReviewLaunch, type GuardedLaunchOptions, type PreparedOriginalLaunch } from '../converge/launch-guard.js';
import { loadConvergeAttemptState, type ConvergeAttemptClaim } from '../converge/attempt-budget.js';
import { loadConvergeRunState } from '../converge/run-state.js';
import { retainedLaunchInputSha256 } from '../converge/retained-report.js';
import type { NativeTargetOwnership } from '../converge/target-ownership.js';
import { decodeCapturedInputs, type CapturedReviewerInputs } from '../dispatch/captured-inputs.js';
import { bindOriginalCouncil } from '../dispatch/original-execution.js';
import { assertOriginalLaunchBudget, type OriginalLaunch } from '../dispatch/original-launch.js';
import type { CheckpointJournal } from '../dispatch/checkpoint.js';
import type { CompletedReviewInput } from '../report/assembly.js';
import { configDigest, diffDigest, sha256Hex } from '../report/run-header.js';
import { parseRepoName } from '../resolver/github.js';
import type { Diff } from '../resolver/types.js';
import { abortSignalWithTimeout } from '../telemetry/abort-signal.js';
import { AttestedReviewerDelivery } from '../telemetry/attested-reviewer-delivery.js';
import { parseAttestedExpiry } from '../telemetry/attested-retry.js';
import type { Attestation } from '../telemetry/attest.js';
import type { HarnessCredential } from '../telemetry/credentials.js';
import { HarnessSink } from '../telemetry/sink.js';

export type RetainedOriginalRun = Omit<CompletedReviewInput['run'], 'id' | 'converge'> & { id: string };
export type RetainedOriginalAccess =
  | { kind: 'local' }
  | { kind: 'asserted'; credential: HarnessCredential; fetchImpl?: typeof fetch }
  | { kind: 'protected'; attestation: Attestation; fetchImpl?: typeof fetch };
export interface RetainedOriginalSession {
  prepared: PreparedOriginalLaunch;
  launch: OriginalLaunch;
  captured: CapturedReviewerInputs;
  journal: CheckpointJournal;
  ownership: NativeTargetOwnership;
  run: RetainedOriginalRun & { converge: { target: string; attempt: number; round: number } };
  signal: AbortSignal;
  executionExpiresAtMs: number;
  /** Only the protected lane; retain this transient coordinator for delivery. */
  delivery?: AttestedReviewerDelivery;
}
export interface RetainedOriginalOptions {
  guard: Pick<GuardedLaunchOptions, 'gitCommonDir' | 'target' | 'round' | 'maxAttempts' | 'maxRounds' | 'intent' | 'retryReason'>;
  captured: CapturedReviewerInputs;
  run: RetainedOriginalRun;
  diff: Diff;
  /** Independently resolved effective comparison base; never the observed upstream tip. */
  effectiveMergeBaseSha: string;
  bounds: Pick<OriginalLaunch, 'startedAtMs' | 'expiresAtMs' | 'maxPhysicalCalls' | 'maxAttemptsPerCell'>;
  access: RetainedOriginalAccess;
  /** A continuation must retain its native ledger. A genuine first original may initialize it. */
  requireExistingNativeState?: boolean;
  signal?: AbortSignal;
  validate: GuardedLaunchOptions['validate'];
  onClaim?: GuardedLaunchOptions['onClaim'];
  beforeClaim?: (prepared: PreparedOriginalLaunch) => Promise<void>;
  execute: (session: RetainedOriginalSession) => ReturnType<GuardedLaunchOptions['run']>;
}
function refuse(reason: string): never { throw new Error(`retained_original_${reason}`); }

function assertBindings(captured: CapturedReviewerInputs, run: RetainedOriginalRun, diff: Diff, target: string, mergeBase: string): void {
  const plan = captured.plan, aggregation = captured.aggregation;
  if (!aggregation || !isDeepStrictEqual(captured.config.thresholds, aggregation.thresholds) ||
    captured.config.output?.belowThresholdAppendix !== aggregation.belowThresholdAppendix) refuse('aggregation_mismatch');
  const repo = run.target.repo && parseRepoName(run.target.repo);
  const pr = run.target.prNumber;
  if (!repo || !Number.isSafeInteger(pr) || pr! < 1 || !['patch', 'pr'].includes(run.target.kind)) refuse('target_mismatch');
  const prTarget = `${repo.owner}/${repo.repo}#${pr}`.toLowerCase();
  const planPr = /^[^/\s]+\/[^/#\s]+#[1-9]\d*$/.test(plan.target);
  if (target !== plan.target || planPr && prTarget !== plan.target.toLowerCase() ||
    run.target.headSha !== plan.headSha || mergeBase !== plan.mergeBaseSha ||
    diffDigest(diff.files) !== plan.patchSha256 || configDigest(captured.config) !== plan.configSha256) refuse('target_mismatch');
  if (run.target.kind === 'patch' && run.target.baseSha !== mergeBase) refuse('base_mismatch');
  if (run.target.kind === 'pr' && (!diff.metadata || diff.source !== 'github' ||
    diff.metadata.headSha !== plan.headSha || diff.metadata.mergeBaseSha !== mergeBase ||
    diff.metadata.baseSha !== run.target.baseSha ||
    `${diff.metadata.owner}/${diff.metadata.repo}#${diff.metadata.number}`.toLowerCase() !== prTarget)) refuse('source_mismatch');
  const roster = run.roster.filter(seat => seat.lane === 'blocking' || seat.lane === 'secondary')
    .map(seat => ({ model: seat.model, role: seat.role, route: seat.provider }));
  if (!isDeepStrictEqual(roster, plan.roster.map(({ model, role, route }) => ({ model, role, route })))) refuse('roster_mismatch');
  if ((run.spec?.sha256 ?? sha256Hex('')) !== plan.specSha256) refuse('spec_mismatch');
  const context = JSON.parse(captured.contextBytes) as Array<{ label: string; sha256: string }>;
  if (!isDeepStrictEqual(run.contextFiles ?? [], context.map(doc => ({ path: doc.label, sha256: doc.sha256 })))) refuse('context_mismatch');
  if (!(run.startedAt instanceof Date) || !Number.isFinite(run.startedAt.getTime())) refuse('started_at');
}

/**
 * Bind original retained work to the normal owned guard's actual numeric claim.
 * Local mode establishes no server capability. Asserted/protected preflight uses
 * the supplied current credential; protected is an internal integration API,
 * not permission to combine the public --guarded-converge and --attest flags.
 * This creates no source grants, restores no missing ledger and enables no async
 * physical accounting. Callers retain responsibility for final artifact delivery.
 */
export async function guardRetainedOriginal(input: RetainedOriginalOptions): Promise<ConvergeAttemptClaim> {
  if (!['local', 'asserted', 'protected'].includes(input.access.kind)) refuse('credential_lane');
  const { validate, onClaim, beforeClaim, execute } = input;
  const originalAttestation = input.access.kind === 'protected' ? input.access.attestation : undefined;
  const captured = decodeCapturedInputs(input.captured.bytes, input.captured.plan);
  if (!isDeepStrictEqual(captured, input.captured)) refuse('capture_mismatch');
  const run = structuredClone(input.run), diff = structuredClone(input.diff), guard = { ...input.guard };
  const bounds = { ...input.bounds }, continuation = input.requireExistingNativeState === true;
  const access = input.access.kind === 'local' ? input.access : { ...input.access,
    ...(input.access.kind === 'asserted' ? { credential: structuredClone(input.access.credential) } : { attestation: structuredClone(input.access.attestation) }) } as RetainedOriginalAccess;
  assertBindings(captured, run, diff, guard.target, input.effectiveMergeBaseSha);
  if (access.kind === 'protected') {
    if (access.attestation.runId !== run.id || run.target.kind !== 'pr') refuse('protected_binding');
    const expiry = parseAttestedExpiry(access.attestation.expiresAt);
    if (expiry === undefined) refuse('credential_expiry');
    bounds.expiresAtMs = Math.min(bounds.expiresAtMs, expiry);
  }
  if (access.kind === 'asserted' && (access.credential.source === 'attest' || access.credential.token.startsWith('rbc_'))) refuse('credential_lane');
  assertOriginalLaunchBudget(bounds.expiresAtMs - bounds.startedAtMs, bounds.maxPhysicalCalls, bounds.maxAttemptsPerCell);
  const perCell = (captured.config.maxRetries ?? DEFAULT_MAX_RETRIES) + 1;
  if (bounds.maxAttemptsPerCell > perCell || bounds.maxPhysicalCalls > captured.plan.cells.length * perCell) refuse('retry_bounds');
  const executionExpiresAtMs = retainedPaidCutoff(bounds);
  const remaining = executionExpiresAtMs - Date.now();
  if (remaining <= 0 || Date.now() < bounds.startedAtMs) refuse('deadline');
  const lease = abortSignalWithTimeout(input.signal, remaining);
  let delivery: AttestedReviewerDelivery | undefined;
  const active = () => { lease.signal.throwIfAborted(); if (Date.now() >= executionExpiresAtMs || Date.now() < bounds.startedAtMs) refuse('deadline'); };
  try {
    active();
    return await guardReviewLaunch({ ...guard, headSha: captured.plan.headSha,
      inputSha256: retainedLaunchInputSha256(captured.digest, run),
      validate: async () => {
        active();
        if (continuation && (!(await loadConvergeAttemptState(guard.gitCommonDir, guard.target)) ||
          !(await loadConvergeRunState(guard.gitCommonDir, guard.target)))) refuse('native_state_missing');
        await validate(); active();
      },
      originalLaunch: { input: { ...bounds, runId: run.id, capturedInputsSha256: captured.digest, planDigest: captured.plan.digest },
        beforeClaim: async prepared => {
          active();
          if (access.kind === 'protected') {
            if (!isDeepStrictEqual(originalAttestation, access.attestation)) refuse('credential_changed');
            delivery = new AttestedReviewerDelivery(originalAttestation!, { kind: 'original', rclVersion: run.rclVersion,
              operationBytes: prepared.launchBytes, fetchImpl: access.fetchImpl });
            await delivery.checkOriginal({ signal: lease.signal });
          } else if (access.kind === 'asserted') {
            const sink = new HarnessSink({ credential: access.credential, rclVersion: run.rclVersion, fetchImpl: access.fetchImpl });
            if ((await sink.checkReviewerRecovery({ signal: lease.signal })).kind !== 'ok') refuse('capability_unavailable');
          }
          active(); await beforeClaim?.(prepared); active();
        } },
      onClaim,
      run: async (converge, ownership, prepared) => {
        if (!prepared || converge.attempt === undefined || converge.round === undefined) refuse('claim_missing');
        active();
        const journal = await bindOriginalCouncil({ commonDir: guard.gitCommonDir, ownership, captured, launch: prepared.launch });
        if ((await journal.readBindings()).launch !== prepared.launchBytes) refuse('launch_mismatch');
        active();
        return execute({ prepared, launch: prepared.launch, captured, journal, ownership,
          run: { ...run, converge: { target: converge.target, attempt: converge.attempt, round: converge.round } }, signal: lease.signal, executionExpiresAtMs,
          ...(delivery ? { delivery } : {}) });
      },
    });
  } finally { lease.dispose(); }
}
