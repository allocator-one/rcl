import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ConsensusFinding } from '../consensus/types.js';
import {
  stableFindingKey,
  matchFinding,
  type IdentityEntry,
} from './finding-identity.js';

/**
 * Per-converge-run state (RCL-24): the machine-enforced round cap and the
 * cross-round finding ledger (identity, verdicts, suppression). Lives next
 * to the attempt budget in the repository's common git dir — durable across
 * sessions, repo-scoped, not world-writable. The converge target lock
 * serializes writers per target at the workflow level.
 */

export const DEFAULT_CONVERGE_ROUND_CAP = 3;
export const HARD_CONVERGE_ROUND_CAP = 5;
export const MIN_CONVERGE_ROUNDS = 2;

const STATE_VERSION = 1;
const STATE_DIR = 'rcl-converge-runs';
const DEFAULT_LINE_WINDOW = 5;

export class ConvergeRoundCapError extends Error {
  readonly code = 'RCL_CONVERGE_ROUND_CAP';

  constructor(
    readonly target: string,
    readonly round: number,
    readonly cap: number
  ) {
    super(
      round > HARD_CONVERGE_ROUND_CAP
        ? `Round ${round} for ${target} exceeds the hard cap of ${HARD_CONVERGE_ROUND_CAP} rounds — no override exists. ` +
          'Rounds past 5 are noise-sampling, not review (RCL-21).'
        : `Round ${round} for ${target} exceeds the configured cap of ${cap} rounds. ` +
          `An explicit --max-rounds (up to ${HARD_CONVERGE_ROUND_CAP}) may extend it.`
    );
    this.name = 'ConvergeRoundCapError';
  }
}

export class ConvergeRunStateError extends Error {
  readonly code = 'RCL_CONVERGE_RUN_STATE';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConvergeRunStateError';
  }
}

export function validateRoundCap(maxRounds: number): number {
  if (
    !Number.isSafeInteger(maxRounds) ||
    maxRounds < MIN_CONVERGE_ROUNDS ||
    maxRounds > HARD_CONVERGE_ROUND_CAP
  ) {
    throw new ConvergeRunStateError(
      `--max-rounds must be an integer between ${MIN_CONVERGE_ROUNDS} and ${HARD_CONVERGE_ROUND_CAP} ` +
        `(a fix pass deserves one re-review; rounds past ${HARD_CONVERGE_ROUND_CAP} are noise-sampling).`
    );
  }
  return maxRounds;
}

export type FindingVerdict = 'fixed' | 'dismissed';

export interface FindingEntry {
  key: string;
  file: string;
  category: string;
  startLine: number;
  endLine: number;
  title: string;
  severity: string;
  models: string[];
  firstRound: number;
  lastRound: number;
  verdict?: FindingVerdict;
  verdictReason?: string;
  verdictRound?: number;
}

export interface RoundCounts {
  new: number;
  repeat: number;
  suppressed: number;
  regating: number;
}

export interface ConvergeRunState {
  version: typeof STATE_VERSION;
  target: string;
  roundCap: number;
  rounds: Array<{ round: number; counts: RoundCounts }>;
  findings: Record<string, FindingEntry>;
  updatedAt: string;
}

export type FindingStatus = 'new' | 'repeat' | 'suppressed' | 'regating';

export interface AnnotatedRoundFinding {
  identity: string;
  status: FindingStatus;
  suppressReason?: string;
  finding: ConsensusFinding;
}

export interface RoundReport {
  roundCap: number;
  counts: RoundCounts;
  findings: AnnotatedRoundFinding[];
}

function stateBaseName(target: string): string {
  const slug = target.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const digest = createHash('sha256').update(target).digest('hex').slice(0, 16);
  return `${slug || 'target'}-${digest}`;
}

export function convergeRunStatePath(gitCommonDir: string, target: string): string {
  return join(resolve(gitCommonDir), STATE_DIR, `${stateBaseName(target)}.json`);
}

async function readState(
  gitCommonDir: string,
  target: string
): Promise<ConvergeRunState | undefined> {
  const path = convergeRunStatePath(gitCommonDir, target);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new ConvergeRunStateError(`Could not read converge run state: ${path}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConvergeRunStateError(
      `Invalid JSON in converge run state ${path}; refusing to reset cross-round identity.`,
      { cause: err }
    );
  }
  const state = parsed as Partial<ConvergeRunState>;
  if (
    state.version !== STATE_VERSION ||
    state.target !== target ||
    !Number.isSafeInteger(state.roundCap) ||
    !Array.isArray(state.rounds) ||
    typeof state.findings !== 'object' ||
    state.findings === null
  ) {
    throw new ConvergeRunStateError(
      `Invalid converge run state in ${path}; refusing to reset cross-round identity.`
    );
  }
  return state as ConvergeRunState;
}

async function writeState(gitCommonDir: string, state: ConvergeRunState): Promise<void> {
  const path = convergeRunStatePath(gitCommonDir, state.target);
  await mkdir(join(resolve(gitCommonDir), STATE_DIR), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function loadConvergeRunState(
  gitCommonDir: string,
  target: string
): Promise<ConvergeRunState | undefined> {
  return readState(gitCommonDir, target.trim());
}

function isCorroborated(finding: ConsensusFinding): boolean {
  return finding.severity === 'critical' || finding.consensus.models.length >= 2;
}

/**
 * Dedupe one round's findings against every prior round of this run,
 * enforce the round cap, and persist the updated identity ledger.
 *
 * Suppression rule: a finding DISMISSED in an earlier round cannot re-gate
 * later on the same evidence — it is 'suppressed' unless it returns with new
 * corroboration (≥2 models or critical severity), which makes it 'regating'
 * and puts it back in front of triage.
 */
export async function processRoundReport(options: {
  gitCommonDir: string;
  target: string;
  round: number;
  findings: ConsensusFinding[];
  maxRounds?: number;
  lineWindow?: number;
}): Promise<RoundReport> {
  const target = options.target.trim();
  if (!target) throw new ConvergeRunStateError('Convergence target must not be empty.');
  if (!Number.isSafeInteger(options.round) || options.round < 1) {
    throw new ConvergeRunStateError('round must be a positive integer.');
  }
  const lineWindow = options.lineWindow ?? DEFAULT_LINE_WINDOW;

  const state: ConvergeRunState = (await readState(options.gitCommonDir, target)) ?? {
    version: STATE_VERSION,
    target,
    roundCap: DEFAULT_CONVERGE_ROUND_CAP,
    rounds: [],
    findings: {},
    updatedAt: new Date().toISOString(),
  };
  if (options.maxRounds !== undefined) {
    state.roundCap = validateRoundCap(options.maxRounds);
  }
  if (options.round > state.roundCap || options.round > HARD_CONVERGE_ROUND_CAP) {
    // Persist a tightened/extended cap even when this round is refused.
    if (options.maxRounds !== undefined) await writeState(options.gitCommonDir, state);
    throw new ConvergeRoundCapError(target, options.round, state.roundCap);
  }

  const entries: IdentityEntry[] = Object.values(state.findings);
  const counts: RoundCounts = { new: 0, repeat: 0, suppressed: 0, regating: 0 };
  const annotated: AnnotatedRoundFinding[] = [];

  for (const finding of options.findings) {
    const matched =
      matchFinding(finding, entries, lineWindow) ??
      // Bucket-key fallback: same file+category+anchor bucket is the same
      // neighborhood even when the persisted span doesn't overlap.
      (state.findings[stableFindingKey(finding)] as IdentityEntry | undefined);

    if (!matched) {
      let key = stableFindingKey(finding);
      // A different location can share a bucket key only after the overlap
      // and bucket fallbacks both missed — disambiguate rather than merge.
      while (state.findings[key]) {
        key = createHash('sha256').update(`${key}+`).digest('hex').slice(0, 16);
      }
      state.findings[key] = {
        key,
        file: finding.file,
        category: finding.category,
        startLine: finding.startLine,
        endLine: finding.endLine,
        title: finding.title,
        severity: finding.severity,
        models: [...finding.consensus.models],
        firstRound: options.round,
        lastRound: options.round,
      };
      counts.new++;
      annotated.push({ identity: key, status: 'new', finding });
      continue;
    }

    const entry = state.findings[matched.key]!;
    entry.lastRound = options.round;
    entry.models = [...new Set([...entry.models, ...finding.consensus.models])];

    let status: FindingStatus;
    let suppressReason: string | undefined;
    if (entry.verdict === 'dismissed') {
      if (isCorroborated(finding)) {
        status = 'regating';
        counts.regating++;
      } else {
        status = 'suppressed';
        counts.suppressed++;
        suppressReason =
          `dismissed in round ${entry.verdictRound}` +
          (entry.verdictReason ? ` (${entry.verdictReason})` : '') +
          ' — re-gating requires new corroboration (≥2 models or critical)';
      }
    } else {
      status = 'repeat';
      counts.repeat++;
    }
    annotated.push({
      identity: entry.key,
      status,
      ...(suppressReason ? { suppressReason } : {}),
      finding,
    });
  }

  state.rounds = [
    ...state.rounds.filter((r) => r.round !== options.round),
    { round: options.round, counts },
  ].sort((a, b) => a.round - b.round);
  state.updatedAt = new Date().toISOString();
  await writeState(options.gitCommonDir, state);

  return { roundCap: state.roundCap, counts, findings: annotated };
}

/** Record triage verdicts for this run's findings (feeds suppression and RCL-27). */
export async function recordVerdicts(options: {
  gitCommonDir: string;
  target: string;
  round: number;
  verdicts: Array<{ key: string; verdict: FindingVerdict; reason?: string }>;
}): Promise<void> {
  const target = options.target.trim();
  const state = await readState(options.gitCommonDir, target);
  if (!state) {
    throw new ConvergeRunStateError(
      `No converge run state for ${target} — run converge-report before recording verdicts.`
    );
  }
  for (const { key, verdict, reason } of options.verdicts) {
    const entry = state.findings[key];
    if (!entry) {
      throw new ConvergeRunStateError(`Unknown finding key "${key}" for target ${target}.`);
    }
    entry.verdict = verdict;
    entry.verdictRound = options.round;
    if (reason !== undefined) entry.verdictReason = reason;
  }
  state.updatedAt = new Date().toISOString();
  await writeState(options.gitCommonDir, state);
}
