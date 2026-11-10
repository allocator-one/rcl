import { loadConvergeAttemptState } from './attempt-budget.js';
import type { GuardedLaunchState } from './launch-record.js';
import { inspectProcessIdentity } from './process-identity.js';
import { loadConvergeRunState, type ConvergeRunState } from './run-state.js';
import { withNativeTarget } from './target-ownership.js';
import { convergeTargetCandidates, isUnsupportedConvergeTargetForm, recordedReferenceKeys, UnsupportedConvergeTargetForm } from './target-forms.js';

/**
 * Whether a converge round is still being worked on (RCL-232).
 *
 * A guarded review holds the native target lock from preflight until its
 * terminal record is written, so a held lock means a live review process,
 * including a resumed council whose record still names its exited original
 * claimant. A pending record with a free lock means the launching process is
 * gone: nothing will ever finish that round, and a caller must not wait on it.
 */
export type RoundLivenessStatus = 'running' | 'dead' | 'not_launched' | 'completed' | 'failed' | 'idle';

/** What the caller does next: keep waiting, resume the dead launch, launch the round, read the report, or inspect. */
export type RoundLivenessAction = 'wait' | 'resume' | 'launch' | 'process_report' | 'inspect' | 'none';

export interface RoundLiveness {
  /** The native target key the answer was read from. */
  target: string;
  /** What the caller named, when that was a pull request reference standing for `target`. */
  requestedTarget?: string;
  status: RoundLivenessStatus;
  action: RoundLivenessAction;
  message: string;
  /** The completed launch's round is already admitted by `converge-report`. */
  admitted?: boolean;
  launch?: {
    status: GuardedLaunchState['status'];
    attempt: number;
    round: number;
    headSha: string;
    startedAt: string;
    pid: number;
    runId?: string;
    reportPath?: string;
    exitCode?: number;
  };
}

export interface RoundLivenessOptions {
  gitCommonDir: string;
  target: string;
  /** The head the caller expects a round for; a latest launch at another head is reported as not launched. */
  headSha?: string;
  /** How long to try for the target lock before reading a holder as a live review. */
  lockTimeoutMs?: number;
}

export interface RoundOutcomeWaitOptions extends RoundLivenessOptions {
  timeoutMs: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_WAIT_INTERVAL_MS = 30_000;

/** Exit code for `rcl converge-status`: 6 when the round is abandoned and nothing will finish it. */
export function roundLivenessExitCode(liveness: RoundLiveness): 0 | 6 {
  return liveness.status === 'dead' || liveness.status === 'not_launched' ? 6 : 0;
}

function lastLaunchOf(state: ConvergeRunState | undefined, attemptsLaunch: GuardedLaunchState | undefined): GuardedLaunchState | undefined {
  return state?.version === 3 ? attemptsLaunch : state?.lastLaunch ?? attemptsLaunch;
}

async function readLaunch(gitCommonDir: string, target: string) {
  const state = await loadConvergeRunState(gitCommonDir, target);
  const attempts = await loadConvergeAttemptState(gitCommonDir, target);
  return { state, launch: lastLaunchOf(state, attempts?.lastLaunch) };
}

function describeLaunch(launch: GuardedLaunchState): NonNullable<RoundLiveness['launch']> {
  return {
    status: launch.status, attempt: launch.attempt, round: launch.round, headSha: launch.headSha,
    startedAt: launch.startedAt, pid: launch.pid,
    ...(launch.runId ? { runId: launch.runId } : {}),
    ...(launch.reportPath ? { reportPath: launch.reportPath } : {}),
    ...(launch.exitCode !== undefined ? { exitCode: launch.exitCode } : {}),
  };
}

function label(launch: GuardedLaunchState): string {
  return `attempt ${launch.attempt}, round ${launch.round} at ${launch.headSha.slice(0, 12)}`;
}

function isLocked(error: unknown): boolean {
  return error instanceof Error && error.message === 'recovery_run_locked';
}

async function settledLiveness(target: string, headSha: string | undefined,
  state: ConvergeRunState | undefined, launch: GuardedLaunchState | undefined): Promise<RoundLiveness> {
  if (!launch || (headSha !== undefined && launch.headSha !== headSha)) {
    if (headSha === undefined) {
      return { target, status: 'idle', action: 'none', message: 'No guarded launch is recorded for this target.' };
    }
    return { target, status: 'not_launched', action: 'launch',
      ...(launch ? { launch: describeLaunch(launch) } : {}),
      message: `No guarded launch reached head ${headSha.slice(0, 12)}, and no review process holds the target. ` +
        'Nothing is reviewing this head: launch the round.' };
  }
  const described = describeLaunch(launch);
  if (launch.status === 'pending') {
    // The lock is free, so no guarded review owns the target. A recorded
    // process that is provably the same live process is still finishing.
    const identity = launch.recovery?.resume?.processIdentity ?? launch.processIdentity;
    if (identity && await inspectProcessIdentity(identity).catch(() => 'unverifiable' as const) === 'alive') {
      return { target, status: 'running', action: 'wait', launch: described,
        message: `The launching process for ${label(launch)} is still alive (pid ${identity.pid}).` };
    }
    return { target, status: 'dead', action: 'resume', launch: described,
      message: `The process that launched ${label(launch)} exited without a terminal record, and no review process holds the target. ` +
        'Nothing will finish this round: rerun the same guarded review command, which resumes a journaled council without ' +
        'spending an attempt, or recover the launch if rcl refuses with dispatch_unknown.' };
  }
  if (launch.status === 'failed') {
    return { target, status: 'failed', action: 'inspect', launch: described,
      message: `The launch for ${label(launch)} failed${launch.exitCode !== undefined ? ` with exit ${launch.exitCode}` : ''}. ` +
        'Inspect its log and report before any retry.' };
  }
  const admitted = state?.rounds.some(round => round.runId !== undefined && round.runId === launch.runId) ?? false;
  return { target, status: 'completed', action: admitted ? 'none' : 'process_report', admitted, launch: described,
    message: admitted
      ? `The report for ${label(launch)} is admitted.`
      : `The launch for ${label(launch)} completed${launch.reportPath ? ` with report ${launch.reportPath}` : ''}; ` +
        'it awaits converge-report.' };
}

/** The launch (or a held lock) the answer rests on; `idle` and a miss at the head are answers about nothing. */
function recordedAt(liveness: RoundLiveness): string | undefined {
  if (liveness.launch) return liveness.launch.startedAt;
  return liveness.status === 'running' ? '￿' : undefined;
}

/**
 * Classify the target's latest round without changing native state, attempts, or reports.
 *
 * A pull request named as `owner/repo#N` or by URL also reads the other keys
 * its rounds launch under (`<repo>-<N>`, `owner/repo#N`), and a `<repo>-<N>`
 * slug also reads an `owner/repo#N` key the repository recorded; the key with
 * the latest record answers, and `requestedTarget` says what the caller asked
 * (RCL-235).
 */
export async function inspectRoundLiveness(options: RoundLivenessOptions): Promise<RoundLiveness> {
  const { key, aliases: derived, owner } = convergeTargetCandidates(options.target);
  const literal = await inspectTargetLiveness({ ...options, target: key });
  // A key that is not a pull request reference and holds a round is a free-form key that answers for itself
  // (`rcl-7` is not `owner/rcl#7`). Otherwise a failed listing or read is unknown state, never a miss and never a
  // reason to trust the key that was found, so it throws.
  // A pull request reference looks its recorded keys up through its slug, which names the repository and number
  // without the casing of the owner or repository the caller typed.
  const discovered = derived.length === 0 && recordedAt(literal) !== undefined ? []
    : await recordedReferenceKeys(options.gitCommonDir, derived[0] ?? key, owner);
  const aliases = [...new Set([...derived, ...discovered])].filter(alias => alias !== key);
  const answers = [literal, ...await Promise.all(aliases.map(alias => inspectTargetLiveness({ ...options, target: alias })))];
  const recorded = answers.filter(answer => recordedAt(answer) !== undefined)
    .sort((a, b) => recordedAt(b)!.localeCompare(recordedAt(a)!));
  if (recorded.length === 0 && isUnsupportedConvergeTargetForm(key)) throw new UnsupportedConvergeTargetForm(key);
  const answer = recorded[0] ?? answers.at(derived.length > 0 ? 1 : 0)!;
  return answer.target === key ? answer : { ...answer, requestedTarget: key };
}

async function inspectTargetLiveness(options: RoundLivenessOptions): Promise<RoundLiveness> {
  const target = options.target.trim();
  try {
    return await withNativeTarget(options.gitCommonDir, target, async () => {
      const { state, launch } = await readLaunch(options.gitCommonDir, target);
      return settledLiveness(target, options.headSha, state, launch);
    }, { lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS });
  } catch (error) {
    if (!isLocked(error)) throw error;
  }
  // A live guarded review owns the target; describe its launch once it is recorded.
  const { launch } = await readLaunch(options.gitCommonDir, target).catch(() => ({ launch: undefined }));
  const current = launch?.status === 'pending' && (options.headSha === undefined || launch.headSha === options.headSha);
  return { target, status: 'running', action: 'wait', ...(current ? { launch: describeLaunch(launch) } : {}),
    message: current ? `A review process holds the target and is working on ${label(launch)}.`
      : 'A review process holds the target and has not yet recorded its launch.' };
}

/** Poll until the round is no longer running or the timeout passes; a dead round returns at once. */
export async function waitForRoundOutcome(options: RoundOutcomeWaitOptions): Promise<RoundLiveness> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const interval = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const liveness = await inspectRoundLiveness(options);
    if (liveness.status !== 'running' || now() >= deadline) return liveness;
    await sleep(Math.max(0, Math.min(interval, deadline - now())));
  }
}
