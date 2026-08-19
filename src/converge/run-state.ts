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

export const DEFAULT_CONVERGE_ROUND_CAP = 15;
export const HARD_CONVERGE_ROUND_CAP = 99;
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
          `A target still not converged after ${HARD_CONVERGE_ROUND_CAP} rounds needs human review, not more sampling (RCL-29).`
        : `Round ${round} for ${target} exceeds the configured cap of ${cap} rounds — ask the user whether to continue. ` +
          `With explicit approval, an explicit --max-rounds (up to ${HARD_CONVERGE_ROUND_CAP}) extends it.`
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
        `(the loop runs until convergence, asking at ${DEFAULT_CONVERGE_ROUND_CAP} rounds by default; ` +
        `past ${HARD_CONVERGE_ROUND_CAP} rounds a human takes over).`
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
  /**
   * Severity at the moment the verdict was recorded (RCL-30). A dismissal is
   * terminal on that evidence; only escalation past it re-gates. Absent on
   * pre-2.1.1 states — the first-seen `severity` stands in.
   */
  verdictSeverity?: string;
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
  /**
   * The most recent round's classified identities (RCL-30), so
   * `converge-verdict` can decide the round's resolution — in particular
   * whether a dismissal-only round converges — without re-reading the report.
   * Replaced whenever a round is processed; absent on pre-2.1.1 states.
   */
  lastAnnotations?: {
    round: number;
    identities: Array<{ identity: string; status: FindingStatus; gating: string }>;
  };
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

/**
 * Gating reason for a finding, tolerating legacy reports without RCL-23
 * annotations. Shared with the CLI so classification and display agree.
 */
export function findingGatingReason(f: { severity: string; gating?: { reason: string } }): string {
  if (f.gating) return f.gating.reason;
  return f.severity === 'critical' || f.severity === 'important' ? 'legacy-blocking' : 'none';
}

/**
 * Dedupe one round's findings against every prior round of this run,
 * enforce the round cap, and persist the updated identity ledger.
 *
 * Suppression rule (RCL-30): a dismissal is terminal on its evidence. A
 * finding DISMISSED in an earlier round stays 'suppressed' no matter how many
 * models raise it again — identity matching is location-anchored, so a claim
 * about different code is a new identity, not a repeat sighting. The one
 * re-gate trigger is escalation: a sighting turned critical after a
 * non-critical dismissal is 'regating' and goes back in front of triage.
 * (Before 2.1.1 fresh ≥2-model corroboration also re-gated; on large diffs
 * that reopened popular false positives every round — see allocator-one#7774,
 * 24 rounds.)
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
  // Rounds advance contiguously: the current round may be re-processed (the
  // skill allows bounded re-runs), the next round may start, and nothing
  // else — reusing old numbers or skipping ahead would let a loop dodge the
  // cap's intent. A state with no recorded rounds adopts whatever round the
  // resumed ledger is on (pre-upgrade runs have history the state lacks).
  const maxRecorded = state.rounds.reduce((max, r) => Math.max(max, r.round), 0);
  if (maxRecorded > 0 && (options.round < maxRecorded || options.round > maxRecorded + 1)) {
    throw new ConvergeRunStateError(
      `Round ${options.round} for ${target} is out of order: recorded rounds reach ` +
        `${maxRecorded}; only round ${maxRecorded} (re-run) or ${maxRecorded + 1} is accepted.`
    );
  }

  // Live list: entries created earlier in THIS round must be matchable by
  // later findings of the same report, or near-duplicates in one report
  // would split into separate identities. Matching is overlap-only — a
  // bucket-key shortcut would merge non-overlapping findings that merely
  // share a 10-line neighborhood.
  const entries: IdentityEntry[] = Object.values(state.findings);
  const counts: RoundCounts = { new: 0, repeat: 0, suppressed: 0, regating: 0 };
  const annotated: AnnotatedRoundFinding[] = [];

  for (const finding of options.findings) {
    const matched = matchFinding(finding, entries, lineWindow);

    if (!matched) {
      let key = stableFindingKey(finding);
      // A different location can share a bucket key only after the overlap
      // and bucket fallbacks both missed — disambiguate rather than merge.
      while (state.findings[key]) {
        key = createHash('sha256').update(`${key}+`).digest('hex').slice(0, 16);
      }
      const created: FindingEntry = {
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
      state.findings[key] = created;
      entries.push(created);
      counts.new++;
      annotated.push({ identity: key, status: 'new', finding });
      continue;
    }

    const entry = state.findings[matched.key]!;
    // Capture the evidence the verdict reasoned about before this sighting
    // overwrites it (pre-2.1.1 entries lack verdictSeverity; the first-seen
    // severity stands in).
    const severityAtVerdict = entry.verdictSeverity ?? entry.severity;
    entry.lastRound = Math.max(entry.lastRound, options.round);
    entry.models = [...new Set([...entry.models, ...finding.consensus.models])];
    // Track the latest sighting's span and severity: fixes shift lines
    // between rounds, and matching against a stale first-seen span would
    // decay round over round.
    entry.startLine = finding.startLine;
    entry.endLine = finding.endLine;
    entry.severity = finding.severity;

    let status: FindingStatus;
    let suppressReason: string | undefined;
    if (entry.firstRound === options.round) {
      // A re-run of the round that first recorded this finding — it is this
      // round's own NEW finding being reprocessed, not a cross-round repeat.
      counts.new++;
      annotated.push({ identity: entry.key, status: 'new', finding });
      continue;
    }
    if (entry.verdict === 'dismissed') {
      if (finding.severity === 'critical' && severityAtVerdict !== 'critical') {
        status = 'regating';
        counts.regating++;
      } else {
        status = 'suppressed';
        counts.suppressed++;
        suppressReason =
          `dismissed in round ${entry.verdictRound}` +
          (entry.verdictReason ? ` (${entry.verdictReason})` : '') +
          ' — a dismissal is terminal on its evidence; re-gating requires escalation to critical (RCL-30)';
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
  state.lastAnnotations = {
    round: options.round,
    identities: annotated.map((a) => ({
      identity: a.identity,
      status: a.status,
      gating: findingGatingReason(a.finding),
    })),
  };
  state.updatedAt = new Date().toISOString();
  await writeState(options.gitCommonDir, state);

  return { roundCap: state.roundCap, counts, findings: annotated };
}

/**
 * Resolution of one evidence round after triage (RCL-30). A round whose
 * gating identities were all dismissed — nothing fixed, so the reviewed
 * patch is unchanged — CONVERGES on the spot; no confirmation round exists
 * that could say anything new about the same code.
 */
export interface RoundResolution {
  round: number;
  /** Gating identities this round put in front of triage (new + regating, gating ≠ none). */
  actionable: number;
  /** Actionable identities still lacking a verdict recorded for this round. */
  unresolved: string[];
  /** Identities recorded fixed this round (any status — every fix changes the patch). */
  fixedThisRound: number;
  status: 'converged-dismissal-only' | 'fixes-pending-fresh-round' | 'unresolved';
}

export interface RecordVerdictsResult {
  entries: FindingEntry[];
  /**
   * Present only when the verdicts belong to the most recently processed
   * round; verdicts recorded against older rounds make no resolution claim.
   */
  resolution?: RoundResolution;
}

/**
 * Record triage verdicts for this run's findings (feeds suppression and
 * RCL-27's cross-run precision history). Returns the updated entries so the
 * caller can append them to the global model-stats store, plus the round's
 * resolution when it can be decided.
 */
export async function recordVerdicts(options: {
  gitCommonDir: string;
  target: string;
  round: number;
  verdicts: Array<{ key: string; verdict: FindingVerdict; reason?: string }>;
}): Promise<RecordVerdictsResult> {
  const target = options.target.trim();
  const state = await readState(options.gitCommonDir, target);
  if (!state) {
    throw new ConvergeRunStateError(
      `No converge run state for ${target} — run converge-report before recording verdicts.`
    );
  }
  const updated: FindingEntry[] = [];
  for (const { key, verdict, reason } of options.verdicts) {
    const entry = state.findings[key];
    if (!entry) {
      throw new ConvergeRunStateError(`Unknown finding key "${key}" for target ${target}.`);
    }
    entry.verdict = verdict;
    entry.verdictRound = options.round;
    entry.verdictSeverity = entry.severity;
    if (reason !== undefined) entry.verdictReason = reason;
    updated.push(entry);
  }
  state.updatedAt = new Date().toISOString();
  await writeState(options.gitCommonDir, state);

  let resolution: RoundResolution | undefined;
  if (state.lastAnnotations && state.lastAnnotations.round === options.round) {
    const actionable = state.lastAnnotations.identities.filter(
      (a) => (a.status === 'new' || a.status === 'regating') && a.gating !== 'none'
    );
    const unresolved = actionable
      .filter((a) => {
        const entry = state.findings[a.identity];
        return !entry || entry.verdict === undefined || entry.verdictRound !== options.round;
      })
      .map((a) => a.identity);
    const fixedThisRound = Object.values(state.findings).filter(
      (e) => e.verdict === 'fixed' && e.verdictRound === options.round
    ).length;
    resolution = {
      round: options.round,
      actionable: actionable.length,
      unresolved,
      fixedThisRound,
      status:
        unresolved.length > 0
          ? 'unresolved'
          : fixedThisRound > 0
            ? 'fixes-pending-fresh-round'
            : 'converged-dismissal-only',
    };
  }
  return { entries: updated, ...(resolution ? { resolution } : {}) };
}
