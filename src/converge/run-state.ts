import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ownedNativeTargetCommonDir, withNativeTarget, withOwnedNativeOperation, type NativeTargetOwnership } from './target-ownership.js';
import { gapManifest, validateRoundGapAudit, type RoundGapEntry } from './round-gap-schema.js';
import { syncNativeDirectory, writeNativeStateExclusive } from './native-lock.js';
import { checkDarwinLockACL } from '../evidence/original-run/lock-path.js';
import * as lockScope from '../evidence/original-run/lock-scope.js';
import type { ConsensusFinding } from '../consensus/types.js';
import type { GuardedLaunchState } from './launch-guard.js';
import { DEFAULT_SEVERITY_ORDER } from '../config/defaults.js';
import {
  availableFindingKey,
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
const REPORT_IDENTITY = /^report:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{16}(?![\s\S])/;
const REPORT_IDENTITY_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{16}/i;

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
  /** Digest of claim text for conservative matching without retaining prose. */
  claimTextSha256?: string;
  /** Absent in old state: treat it as legacy and never trust its digest for modern matching. */
  identityOrigin?: 'modern' | 'legacy';
  /** Exact report key makes a retry of the immutable source report idempotent. */
  sourceReportIdentity?: string;
  severity: string;
  models: string[];
  firstRound: number;
  lastRound: number;
  verdict?: FindingVerdict;
  verdictReason?: string;
  verdictRound?: number;
  /** Head reviewed by the round that recorded a fixed verdict. Absent in legacy state. */
  verdictHeadSha?: string;
  /**
   * Severity at the moment the verdict was recorded (RCL-30). A dismissal is
   * terminal on that evidence; only escalation past it re-gates. Absent on
   * pre-2.1.1 states — the retained `severity` is frozen before new sightings.
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
  /** `runId` is the report's `run.id` (rcl ≥ 3.0), which converge-verdict sends with every verdict. */
  rounds: Array<{
    round: number;
    counts: RoundCounts;
    runId?: string;
    /** Exact reviewed head, retained once the report is admitted. */
    headSha?: string;
    /** Strongest sighting per identity in this round, including for delayed verdicts. Absent in legacy state. */
    severities?: Record<string, ConsensusFinding['severity']>;
  }>;
  findings: Record<string, FindingEntry>;
  updatedAt: string;
  lastLaunch?: GuardedLaunchState;
  /** Additive local audit only; entries never stand for an admitted round. */
  roundGapAudit?: { version: 1; entries: RoundGapEntry[] };
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

export function initialConvergeRunState(target: string): ConvergeRunState {
  return { version: STATE_VERSION, target, roundCap: DEFAULT_CONVERGE_ROUND_CAP,
    rounds: [], findings: {}, updatedAt: new Date().toISOString() };
}

async function readState(
  gitCommonDir: string,
  target: string
): Promise<ConvergeRunState | undefined> {
  return (await loadConvergeRunStateEvidence(gitCommonDir, target))?.state;
}

/** Read-only native evidence: state and the digest of the same bytes, without re-encoding or persisting it. */
export async function loadConvergeRunStateEvidence(
  gitCommonDir: string,
  target: string
): Promise<{ state: ConvergeRunState; sha256: string } | undefined> {
  const path = convergeRunStatePath(gitCommonDir, target);
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new ConvergeRunStateError(`Could not read converge run state: ${path}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
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
  validateRoundGapAudit(state as ConvergeRunState);
  return { state: state as ConvergeRunState, sha256: createHash('sha256').update(raw).digest('hex') };
}

/** Persist only under live explicit target authority; started writes drain before release. */
export function writeState(gitCommonDir: string, state: ConvergeRunState, ownership: NativeTargetOwnership): Promise<void> {
  return withOwnedNativeOperation(ownership, gitCommonDir, state.target, () => writeStateOwned(gitCommonDir, state));
}

async function writeStateOwned(gitCommonDir: string, state: ConvergeRunState): Promise<void> {
  // Callers pass the immutable directory bound to target ownership; resolving
  // it here normalizes platform aliases without consulting a mutable caller path.
  gitCommonDir = await realpath(resolve(gitCommonDir));
  const path = convergeRunStatePath(gitCommonDir, state.target);
  const stateDir = join(gitCommonDir, STATE_DIR);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(stateDir), uid = process.geteuid?.();
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      (process.platform !== 'win32' && (uid === undefined || directory.uid !== uid || (directory.mode & 0o022) !== 0))) {
    throw new Error('unsafe_converge_state_directory');
  }
  if (process.platform === 'darwin') checkDarwinLockACL(await lockScope.lockSystemCommand('/bin/ls', ['-lde', stateDir]));
  await syncNativeDirectory(gitCommonDir);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeNativeStateExclusive(temp, state);
    await rename(temp, path);
    await syncNativeDirectory(stateDir);
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

/** The run id recorded for a round, when its report carried one. */
export function roundRunId(state: ConvergeRunState | undefined, round: number): string | undefined {
  return state?.rounds.find((r) => r.round === round)?.runId;
}

/**
 * Gating reason for a finding, tolerating legacy reports without RCL-23
 * annotations. Shared with the CLI so classification and display agree.
 */
export function findingGatingReason(f: { severity: string; gating?: { reason: string } }): string {
  if (f.gating) return f.gating.reason;
  return f.severity === 'critical' || f.severity === 'important' ? 'legacy-blocking' : 'none';
}

/** The part of a classified finding that must survive report-key deduplication. */
export interface ReportIdentityMapping {
  identity: string;
  status: FindingStatus;
  suppressReason?: string;
  finding: { identity?: string };
}

/** Refuse ambiguous legacy report keys before persisting or publishing classifications. */
export function validateReportIdentityMappings(findings: readonly ReportIdentityMapping[]): void {
  const seen = new Map<string, ReportIdentityMapping>();
  for (const f of findings) {
    const key = f.finding.identity?.trim() || f.identity;
    const previous = seen.get(key);
    if (previous && (previous.identity !== f.identity || previous.status !== f.status ||
        (previous.suppressReason || undefined) !== (f.suppressReason || undefined))) {
      throw new ConvergeRunStateError(
        `Report identity ${key} has conflicting classifications; preserve the report for supported finding-ref recovery.`
      );
    }
    seen.set(key, f);
  }
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
export interface ProcessRoundOptions {
  gitCommonDir: string;
  target: string;
  round: number;
  findings: ConsensusFinding[];
  maxRounds?: number;
  lineWindow?: number;
  /** The report's own run id, kept so verdicts can be bound to the round's run. */
  runId?: string;
  reportSha256?: string;
  headSha?: string;
  ownership?: NativeTargetOwnership;
}

export async function processRoundReport(options: ProcessRoundOptions): Promise<RoundReport> {
  const { target } = validateRoundReportInput(options);
  return options.ownership
    ? withOwnedNativeOperation(options.ownership, options.gitCommonDir, target, ownership => processRoundReportOwned(options, ownership))
    : withNativeTarget(options.gitCommonDir, target, ownership => processRoundReportOwned(options, ownership));
}

function validateRoundReportInput(options: ProcessRoundOptions): { target: string; runId?: string } {
  const target = options.target.trim();
  if (!target) throw new ConvergeRunStateError('Convergence target must not be empty.');
  // A blank id is no binding at all; only a real one is persisted.
  const runId = options.runId?.trim() || undefined;
  if (!Number.isSafeInteger(options.round) || options.round < 1) {
    throw new ConvergeRunStateError('round must be a positive integer.');
  }
  if (options.findings.some((finding) => !DEFAULT_SEVERITY_ORDER.includes(finding.severity))) {
    throw new ConvergeRunStateError('Invalid finding severity: expected critical, important, minor, or nitpick.');
  }
  if (options.findings.some((finding) => typeof finding.title !== 'string' || typeof finding.description !== 'string')) {
    throw new ConvergeRunStateError('Invalid finding text: title and description must be strings.');
  }
  if (options.findings.some((finding) => finding.identity !== undefined && typeof finding.identity !== 'string')) {
    throw new ConvergeRunStateError('Invalid finding identity: expected a string when present.');
  }
  if (options.findings.some((finding) => {
    const identity = finding.identity;
    return typeof identity === 'string' && looksLikeReportIdentity(identity) && !REPORT_IDENTITY.test(identity);
  })) {
    throw new ConvergeRunStateError('Invalid report identity; refusing legacy matching for a malformed report key.');
  }
  const reportIdentities = options.findings
    .map((finding) => finding.identity)
    .filter((identity): identity is string => typeof identity === 'string')
    .filter(identity => REPORT_IDENTITY.test(identity));
  if (new Set(reportIdentities).size !== reportIdentities.length) {
    throw new ConvergeRunStateError('Duplicate report identity; each modern report claim must be independently addressable.');
  }
  return { target, runId };
}

function looksLikeReportIdentity(identity: string): boolean {
  const normalized = identity.normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[\u0435\u03b5]/gu, 'e')
    .replace(/[\u043e\u03bf]/gu, 'o')
    .replace(/[\u0440\u03c1]/gu, 'p')
    .replace(/[\u0442\u03c4]/gu, 't');
  const prefix = normalized.split(':', 1)[0].trim();
  return prefix === 'report' || (prefix === 'reprot' && REPORT_IDENTITY_SHAPE.test(normalized));
}

function claimTextSha256(finding: ConsensusFinding): string {
  const canonicalText = (text: string) => text.normalize('NFC').replace(/\r\n?/g, '\n');
  return createHash('sha256')
    .update(JSON.stringify([canonicalText(finding.title), canonicalText(finding.description)]))
    .digest('hex');
}

async function processRoundReportOwned(options: ProcessRoundOptions, ownership: NativeTargetOwnership): Promise<RoundReport> {
  const { target, runId } = validateRoundReportInput(options);
  const gitCommonDir = await ownedNativeTargetCommonDir(ownership, options.gitCommonDir, target);
  const lineWindow = options.lineWindow ?? DEFAULT_LINE_WINDOW;

  const state: ConvergeRunState = (await readState(gitCommonDir, target)) ?? initialConvergeRunState(target);
  const currentLaunch = state.lastLaunch;
  if (currentLaunch?.status === 'completed' && currentLaunch.round === options.round && currentLaunch.runId !== undefined) {
    if (runId !== currentLaunch.runId) {
      throw new ConvergeRunStateError(`Round ${options.round} report run does not match its admitted launch.`);
    }
    if (currentLaunch.successfulReviews !== undefined && currentLaunch.totalReviews !== undefined &&
        currentLaunch.successfulReviews < Math.max(2, Math.ceil(2 * currentLaunch.totalReviews / 3))) {
      throw new ConvergeRunStateError(`Round ${options.round} report is inconclusive; reviewer quorum was not met.`);
    }
  }
  const gapEntries = state.roundGapAudit?.entries ?? [];
  if (gapEntries.some(entry => gapManifest(entry).gapRound === options.round)) throw new ConvergeRunStateError('round_gap_requires_explicit_original_evidence_recovery');
  for (const entry of gapEntries.filter(e => gapManifest(e).admittingRound === options.round)) {
    const m = gapManifest(entry);
    if (m.runId !== runId || m.reportSha256 !== options.reportSha256) throw new ConvergeRunStateError('round_gap_original_report_mismatch');
    const { verifyRoundGapReceipt } = await import('./round-gap.js');
    const original = await verifyRoundGapReceipt(gitCommonDir, entry);
    if (!isDeepStrictEqual(original.findings, options.findings)) throw new ConvergeRunStateError('round_gap_original_report_mismatch');
  }
  if (options.maxRounds !== undefined) {
    state.roundCap = validateRoundCap(options.maxRounds);
  }
  if (options.round > state.roundCap || options.round > HARD_CONVERGE_ROUND_CAP) {
    // Persist a tightened/extended cap even when this round is refused.
    if (options.maxRounds !== undefined) await writeState(gitCommonDir, state, ownership);
    throw new ConvergeRoundCapError(target, options.round, state.roundCap);
  }
  // Rounds advance contiguously: the current round may be re-processed (the
  // skill allows bounded re-runs), the next round may start, and nothing
  // else — reusing old numbers or skipping ahead would let a loop dodge the
  // cap's intent. A state with no recorded rounds adopts whatever round the
  // resumed ledger is on (pre-upgrade runs have history the state lacks).
  const maxRecorded = state.rounds.reduce((max, r) => Math.max(max, r.round), 0);
  const gaps = Array.from({ length: Math.max(0, options.round - maxRecorded - 1) }, (_, i) => maxRecorded + i + 1);
  const admittedThroughGap = gaps.length === 1 && gaps.every(gapRound => gapEntries.some(entry => {
    const m = gapManifest(entry);
    return m.gapRound === gapRound && m.admittingRound === options.round && m.runId === runId && m.reportSha256 === options.reportSha256;
  }));
  if (maxRecorded > 0 && (options.round < maxRecorded || (options.round > maxRecorded + 1 && !admittedThroughGap))) {
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
  const occupied = new Set(Object.keys(state.findings));
  const counts: RoundCounts = { new: 0, repeat: 0, suppressed: 0, regating: 0 };
  const annotated: AnnotatedRoundFinding[] = [];
  const severities: Record<string, ConsensusFinding['severity']> = {};
  // A modern report has already deduplicated findings and allocated a key for
  // each sighting. Two different report keys may point at the same lines while
  // describing different claims; one native identity cannot carry both verdicts.
  const claimedThisRound = new Map<string, string>();
  const hasModernReportIdentity = options.findings.some((finding) => REPORT_IDENTITY.test(finding.identity ?? ''));

  const indexedFindings = options.findings.map((finding, findingIndex) => ({ finding, findingIndex }));
  // Modern reservations are allocated first, so mixed input order cannot lend
  // a modern claim a legacy entry. Keep the caller's report order in output.
  indexedFindings.sort(({ finding: left }, { finding: right }) =>
    Number(REPORT_IDENTITY.test(right.identity ?? '')) - Number(REPORT_IDENTITY.test(left.identity ?? '')));
  const pending = new Map<number, AnnotatedRoundFinding>();
  for (const { findingIndex, finding } of indexedFindings) {
    const reportIdentity = REPORT_IDENTITY.test(finding.identity ?? '')
      ? finding.identity
      : undefined;
    // A mixed report cannot safely coalesce a legacy sighting with a modern
    // one. Reserve every mixed-report entry, while preserving legacy-only
    // coalescing for callers predating report identities.
    const claimToken = reportIdentity ?? (hasModernReportIdentity ? `legacy:${findingIndex}` : undefined);
    const textDigest = claimTextSha256(finding);
    const candidates = entries.filter((entry) => {
      const claimedBy = claimedThisRound.get(entry.key);

      if (claimedBy !== undefined && claimedBy !== claimToken) {
        return false;
      }
      const storedDigest = state.findings[entry.key]?.claimTextSha256;
      const origin = state.findings[entry.key]?.identityOrigin;
      if (reportIdentity !== undefined) {
        return origin === 'modern' &&
          (state.findings[entry.key]?.sourceReportIdentity === reportIdentity || storedDigest === textDigest);
      }
      return origin !== 'modern';
    });
    // A digest is only a conservative continuity check, never a claim key.
    // When historical modern claims have the same digest and location, there
    // is no evidence that this sighting belongs to either one. Allocate a new
    // identity instead of lending either historical verdict to it.
    const matchingCandidates = candidates.filter(candidate =>
      matchFinding(finding, [candidate], lineWindow) !== undefined
    );
    const exactSource = reportIdentity === undefined
      ? []
      : matchingCandidates.filter(candidate => state.findings[candidate.key]?.sourceReportIdentity === reportIdentity);
    const matched = reportIdentity === undefined
      ? matchFinding(finding, candidates, lineWindow)
      : exactSource.length === 1
        ? exactSource[0]
        : matchingCandidates.length === 1 ? matchingCandidates[0] : undefined;

    if (!matched) {
      const key = availableFindingKey(finding, occupied);
      occupied.add(key);
      const created: FindingEntry = {
        key,
        file: finding.file,
        category: finding.category,
        startLine: finding.startLine,
        endLine: finding.endLine,
        title: finding.title,
        claimTextSha256: textDigest,
        identityOrigin: reportIdentity ? 'modern' : 'legacy',
        ...(reportIdentity ? { sourceReportIdentity: reportIdentity } : {}),
        severity: finding.severity,
        models: [...finding.consensus.models],
        firstRound: options.round,
        lastRound: options.round,
      };
      state.findings[key] = created;
      severities[key] = finding.severity;
      entries.push(created);
      if (claimToken) claimedThisRound.set(key, claimToken);
      counts.new++;
      pending.set(findingIndex, { identity: key, status: 'new', finding });
      continue;
    }

    const entry = state.findings[matched.key]!;
    if (claimToken) claimedThisRound.set(entry.key, claimToken);
    // Freeze a legacy verdict's implicit severity before updating sightings;
    // later reports must not reinterpret that dismissal as critical.
    const severityAtVerdict = entry.verdictSeverity ?? entry.severity;
    if (entry.verdict !== undefined && entry.verdictSeverity === undefined) {
      entry.verdictSeverity = severityAtVerdict;
    }
    entry.lastRound = Math.max(entry.lastRound, options.round);
    entry.models = [...new Set([...entry.models, ...finding.consensus.models])];
    // Track the latest sighting's span: fixes shift lines
    // between rounds, and matching against a stale first-seen span would
    // decay round over round.
    entry.startLine = finding.startLine;
    entry.endLine = finding.endLine;
    const priorSeverity = severities[entry.key];
    if (priorSeverity === undefined ||
        DEFAULT_SEVERITY_ORDER.indexOf(finding.severity) < DEFAULT_SEVERITY_ORDER.indexOf(priorSeverity)) {
      severities[entry.key] = finding.severity;
    }

    let status: FindingStatus;
    let suppressReason: string | undefined;
    if (entry.firstRound === options.round) {
      // A re-run of the round that first recorded this finding — it is this
      // round's own NEW finding being reprocessed, not a cross-round repeat.
      counts.new++;
      pending.set(findingIndex, { identity: entry.key, status: 'new', finding });
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
    pending.set(findingIndex, {
      identity: entry.key,
      status,
      ...(suppressReason ? { suppressReason } : {}),
      finding,
    });
  }

  annotated.push(...options.findings.map((_, index) => pending.get(index)!));

  validateReportIdentityMappings(annotated);
  for (const [key, severity] of Object.entries(severities)) {
    state.findings[key]!.severity = severity;
  }

  // Re-processing a round without a report id (a legacy or mismatched
  // report) must not erase the binding an earlier pass persisted.
  const boundRunId = runId ?? state.rounds.find((r) => r.round === options.round)?.runId;
  const existingRound = state.rounds.find((entry) => entry.round === options.round);
  if (options.headSha !== undefined && state.lastLaunch?.round === options.round &&
      state.lastLaunch.headSha !== undefined && options.headSha !== state.lastLaunch.headSha) {
    throw new ConvergeRunStateError(`Round ${options.round} report head conflicts with its admitted launch.`);
  }
  if (options.headSha !== undefined && existingRound?.headSha !== undefined && options.headSha !== existingRound.headSha) {
    throw new ConvergeRunStateError(`Round ${options.round} head conflicts with its admitted launch.`);
  }
  const roundHeadSha = options.headSha ?? existingRound?.headSha ??
    (state.lastLaunch?.round === options.round ? state.lastLaunch.headSha : undefined);
  state.rounds = [
    ...state.rounds.filter((r) => r.round !== options.round),
    { round: options.round, counts, severities, ...(boundRunId !== undefined ? { runId: boundRunId } : {}),
      ...(roundHeadSha !== undefined ? { headSha: roundHeadSha } : {}) },
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
  await writeState(gitCommonDir, state, ownership);

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
  /** Fixed-round heads retained for a guarded retry; absent for legacy verdicts. */
  fixedHeadShas?: string[];
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
export interface RecordVerdictsOptions {
  gitCommonDir: string;
  target: string;
  round: number;
  verdicts: Array<{ key: string; verdict: FindingVerdict; reason?: string }>;
  ownership?: NativeTargetOwnership;
}

export async function recordVerdicts(options: RecordVerdictsOptions): Promise<RecordVerdictsResult> {
  return options.ownership
    ? withOwnedNativeOperation(options.ownership, options.gitCommonDir, options.target, ownership => recordVerdictsOwned(options, ownership))
    : withNativeTarget(options.gitCommonDir, options.target, ownership => recordVerdictsOwned(options, ownership));
}

async function recordVerdictsOwned(options: RecordVerdictsOptions, ownership: NativeTargetOwnership): Promise<RecordVerdictsResult> {
  const target = options.target.trim();
  const gitCommonDir = await ownedNativeTargetCommonDir(ownership, options.gitCommonDir, target);
  const state = await readState(gitCommonDir, target);
  if (!state) {
    throw new ConvergeRunStateError(
      `No converge run state for ${target} — run converge-report before recording verdicts.`
    );
  }
  const reviewedRound = state.rounds.find((r) => r.round === options.round);
  if (!reviewedRound) {
    throw new ConvergeRunStateError(`Round ${options.round} is not recorded for ${target}.`);
  }
  const updated: FindingEntry[] = [];
  const severities = reviewedRound.severities;
  const verdictHeadSha = reviewedRound.headSha;
  for (const { key, verdict, reason } of options.verdicts) {
    const entry = state.findings[key];
    if (!entry) {
      throw new ConvergeRunStateError(`Unknown finding key "${key}" for target ${target}.`);
    }
    if (severities !== undefined && severities[key] === undefined) {
      throw new ConvergeRunStateError(`Finding "${key}" was not sighted in round ${options.round}.`);
    }
    // Emit delayed evidence without replacing a newer round's active verdict.
    const recorded = entry.verdictRound !== undefined && entry.verdictRound > options.round
      ? { ...entry, verdictReason: undefined }
      : entry;
    recorded.verdict = verdict;
    recorded.verdictRound = options.round;
    recorded.verdictSeverity = severities?.[key] ?? entry.severity;
    if (verdict === 'fixed' && verdictHeadSha !== undefined) recorded.verdictHeadSha = verdictHeadSha;
    else delete recorded.verdictHeadSha;
    if (reason !== undefined) recorded.verdictReason = reason;
    else if (verdict === 'fixed') delete recorded.verdictReason;
    updated.push(recorded);
  }
  state.updatedAt = new Date().toISOString();
  await writeState(gitCommonDir, state, ownership);

  const resolution = resolveRoundResolution(state, options.round);
  return { entries: updated, ...(resolution ? { resolution } : {}) };
}

export function resolveRoundResolution(state: ConvergeRunState, round: number): RoundResolution | undefined {
  if (state.lastAnnotations && state.lastAnnotations.round === round) {
    const actionable = state.lastAnnotations.identities.filter(
      (a) => (a.status === 'new' || a.status === 'regating') && a.gating !== 'none'
    );
    const unresolved = actionable
      .filter((a) => {
        const entry = state.findings[a.identity];
        return !entry || entry.verdict === undefined || entry.verdictRound !== round;
      })
      .map((a) => a.identity);
    const fixedThisRound = Object.values(state.findings).filter(
      (e) => e.verdict === 'fixed' && e.verdictRound === round
    ).length;
    const fixedHeadShas = [...new Set(Object.values(state.findings)
      .filter((e) => e.verdict === 'fixed' && e.verdictRound === round)
      .map((e) => e.verdictHeadSha)
      .filter((headSha): headSha is string => headSha !== undefined))];
    return {
      round,
      actionable: actionable.length,
      unresolved,
      fixedThisRound,
      fixedHeadShas,
      status:
        unresolved.length > 0
          ? 'unresolved'
          : fixedThisRound > 0
            ? 'fixes-pending-fresh-round'
            : 'converged-dismissal-only',
    };
  }
}
