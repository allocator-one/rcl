import { readStable } from '../telemetry/recovery/files.js';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ownedNativeTargetCommonDir, withOwnedNativeOperation, withNativeTarget, type NativeTargetOwnership } from './target-ownership.js';
import { syncNativeDirectory, writeNativeStateExclusive } from './native-lock.js';
import { serializeRecoveryDocument } from '../evidence/original-run/journal.js';
import { effectivePendingIdentities, validateNativeRecoveryState, type NativeRecoveryMetadata } from './recovery-state.js';
import { recoveryProjectionFreshness, type RecoveryProjectionFreshness } from '../evidence/claim-recovery/validation/current-projection.js';
import { bindRoundEvidence, processSemanticRound, validateSemanticState, verifyRoundBinding, type ReportBinding, type SemanticSighting } from './semantic-state.js';
import type { ClaimDescriptor } from '../consensus/claim-identity.js';
import type { ConsensusFinding, ReviewResult } from '../consensus/types.js';
import { gapManifest, validateRoundGapAudit, type RoundGapEntry } from './round-gap-schema.js';
import { checkDarwinLockACL } from '../evidence/original-run/lock-path.js';
import * as lockScope from '../evidence/original-run/lock-scope.js';
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
   * pre-2.1.1 states — the retained `severity` is frozen before new sightings.
   */
  verdictSeverity?: string;
  claimDescriptor?: ClaimDescriptor;
  pendingRound?: number;
}

export interface RoundCounts {
  new: number;
  repeat: number;
  suppressed: number;
  regating: number;
}

export interface ConvergeRunState {
  version: 1 | 2 | 3;
  recovery?: NativeRecoveryMetadata;
  sightings?: SemanticSighting[];
  migration?: { sourceSha256: string; snapshotPath: string; migratedAt: string };
  target: string;
  roundCap: number;
  /** `runId` is the report's `run.id` (rcl ≥ 3.0), which converge-verdict sends with every verdict. */
  rounds: Array<{
    round: number;
    counts: RoundCounts;
    runId?: string;
    reportBinding?: ReportBinding;
    /** Strongest sighting per identity in this round, including for delayed verdicts. Absent in legacy state. */
    severities?: Record<string, ConsensusFinding['severity']>;
  }>;
  findings: Record<string, FindingEntry>;
  updatedAt: string;
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
  sighting?: SemanticSighting;
}

export interface RoundReport {
  roundCap: number;
  counts: RoundCounts;
  actionableIdentities?: string[];
  recoveryProjection?: RecoveryProjectionFreshness;
  /** Validated semantic round binding; callers must not publish its local sourcePath. */
  reportBinding?: ReportBinding;
  classificationVersion?: 1;
  /** Migrated obligations have no invented semantic sighting or report ref. */
  legacyPendingIdentities?: string[];
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
  const state = parsed as Partial<ConvergeRunState> | null;
  if (
    !state || typeof state !== 'object' ||
    (state.version !== 1 && state.version !== 2 && state.version !== 3) ||
    state.target !== target ||
    !Number.isSafeInteger(state.roundCap) ||
    !Array.isArray(state.rounds) ||
    typeof state.findings !== 'object' ||
    state.findings === null || Array.isArray(state.findings)
  ) {
    throw new ConvergeRunStateError(
      `Invalid converge run state in ${path}; refusing to reset cross-round identity.`
    );
  }
  if (state.version === 2) await validateSemanticState(state as ConvergeRunState, gitCommonDir);
  if (state.version === 3) {
    const canonical = await readStable(path, 64 * 1024 * 1024);
    if (!canonical.raw.equals(raw)) throw new ConvergeRunStateError('Native recovery state changed during validation.');
    await validateNativeRecoveryState(state as ConvergeRunState, gitCommonDir, raw);
  }
  validateRoundGapAudit(state as ConvergeRunState);
  return { state: state as ConvergeRunState, sha256: createHash('sha256').update(raw).digest('hex') };
}

/** Persist only under live explicit target authority; started writes drain before release. */
export function writeState(gitCommonDir: string, state: ConvergeRunState, ownership: NativeTargetOwnership): Promise<void> {
  return withOwnedNativeOperation(ownership, gitCommonDir, state.target, () => writeStateOwned(gitCommonDir, state));
}

async function validateOrdinaryNextState(gitCommonDir: string, state: ConvergeRunState, bytes: string): Promise<void> {
  if (state.version === 2) await validateSemanticState(state, gitCommonDir);
  if (state.version === 3) await validateNativeRecoveryState(state, gitCommonDir, Buffer.from(bytes));
}

/** Exact ordinary CAS for retained transitions; strict recovery apply remains separate. */
export function writeStateIfUnchanged(gitCommonDir: string, sourceSha256: string,
  next: ConvergeRunState, ownership: NativeTargetOwnership): Promise<'written' | 'already-written'> {
  const bytes = serializeRecoveryDocument(next);
  const state = JSON.parse(bytes) as ConvergeRunState;
  const afterSha256 = createHash('sha256').update(bytes).digest('hex');
  return withOwnedNativeOperation(ownership, gitCommonDir, state.target, async () => {
    if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new ConvergeRunStateError('Invalid retained native source digest.');
    await validateOrdinaryNextState(gitCommonDir, state, bytes);
    const current = await loadConvergeRunStateEvidence(gitCommonDir, state.target);
    if (current?.sha256 === afterSha256) {
      const commonDir = await realpath(resolve(gitCommonDir)); const stateDir = join(commonDir, STATE_DIR);
      if (await realpath(stateDir) !== stateDir) throw new Error('symlink_directory');
      const path = convergeRunStatePath(commonDir, state.target);
      const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        if (!(await handle.stat()).isFile() || createHash('sha256').update(await handle.readFile()).digest('hex') !== afterSha256) {
          throw new ConvergeRunStateError('Native state changed during retained transition readback.');
        }
        await handle.sync();
      } finally { await handle.close(); }
      await syncNativeDirectory(stateDir); await syncNativeDirectory(commonDir);
      return 'already-written';
    }
    if (current?.sha256 !== sourceSha256) throw new ConvergeRunStateError('Native state changed after this transition was prepared.');
    await writeStateOwned(gitCommonDir, state);
    return 'written';
  });
}

async function writeStateOwned(gitCommonDir: string, state: ConvergeRunState): Promise<void> {
  // The caller uses the immutable directory captured by target ownership.
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
  sighting?: SemanticSighting;
}

/** Refuse ambiguous legacy report keys before persisting or publishing classifications. */
export function validateReportIdentityMappings(findings: readonly ReportIdentityMapping[]): void {
  const seen = new Map<string, ReportIdentityMapping>();
  for (const f of findings) {
    const key = f.finding.identity?.trim() || f.identity;
    const previous = seen.get(key);
    if (previous && (previous.sighting || f.sighting)) throw new ConvergeRunStateError(`Duplicate described report identity ${key}.`);
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
 * Process an original report through semantic v2 matching, or preserve the
 * explicit descriptor-less legacy path. Described claims never fall back to
 * location-only verdict inheritance; v1 state first requires migration.
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
  evidence?: { reportJson: string };
  reportSha256?: string;
  /** The CLI keeps target ownership through its dependent event publication. */
  ownership?: NativeTargetOwnership;
}

/** Validate immutable caller input before even creating target-coordination files. */
export function validateRoundReportInput(options: ProcessRoundOptions) {
  const target = options.target.trim();
  if (!target) throw new ConvergeRunStateError('Convergence target must not be empty.');
  const runId = options.runId?.trim() || undefined;
  if (!Number.isSafeInteger(options.round) || options.round < 1) throw new ConvergeRunStateError('round must be a positive integer.');
  if (options.findings.some(finding => !DEFAULT_SEVERITY_ORDER.includes(finding.severity))) {
    throw new ConvergeRunStateError('Invalid finding severity: expected critical, important, minor, or nitpick.');
  }
  const binding = options.evidence ? bindRoundEvidence(options) : undefined;
  const gating = binding ? (JSON.parse(options.evidence!.reportJson) as ReviewResult).run?.gating : undefined;
  if (gating && Object.hasOwn(gating, 'bound_classification_protocol')) {
    if (gating.bound_classification_protocol !== 1) throw new ConvergeRunStateError('Unsupported bound classification protocol.');
    if (options.findings.some(finding => finding.claimDescriptor === undefined)) {
      throw new ConvergeRunStateError('Declared bound classifications require semantic claim descriptors before native admission.');
    }
  }
  return { target, runId, binding, gating };
}

export async function processRoundReport(options: ProcessRoundOptions): Promise<RoundReport> {
  validateRoundReportInput(options);
  if (options.ownership) {
    return withOwnedNativeOperation(options.ownership, options.gitCommonDir, options.target,
      ownership => processRoundReportOwned(options, ownership));
  }
  return withNativeTarget(options.gitCommonDir, options.target, ownership => processRoundReportOwned(options, ownership));
}

async function processRoundReportOwned(options: ProcessRoundOptions, ownership: NativeTargetOwnership): Promise<RoundReport> {
  const gitCommonDir = await ownedNativeTargetCommonDir(ownership, options.gitCommonDir, options.target);
  options = { ...options, gitCommonDir };
  const { target, runId, binding, gating } = validateRoundReportInput(options);
  const observed = await readState(gitCommonDir, target);
  if (observed?.version === 3) {
    if (!binding || gating?.bound_classification_protocol !== 1) {
      throw new ConvergeRunStateError('Recovered-v3 continuation requires a marked immutable original report.');
    }
    return processSemanticRound(options, binding, ownership);
  }
  if (observed?.version === 2 || options.findings.some(f => f.claimDescriptor !== undefined) || gating?.bound_classification_protocol !== undefined) {
    throw new ConvergeRunStateError('Semantic continuation requires a validated recovered-v3 target.');
  }
  const lineWindow = options.lineWindow ?? DEFAULT_LINE_WINDOW;

  const state: ConvergeRunState = observed ?? {
    version: STATE_VERSION,
    target,
    roundCap: DEFAULT_CONVERGE_ROUND_CAP,
    rounds: [],
    findings: {},
    updatedAt: new Date().toISOString(),
  };
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

  for (const finding of options.findings) {
    const matched = matchFinding(finding, entries, lineWindow);

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
        severity: finding.severity,
        models: [...finding.consensus.models],
        firstRound: options.round,
        lastRound: options.round,
      };
      state.findings[key] = created;
      severities[key] = finding.severity;
      entries.push(created);
      counts.new++;
      annotated.push({ identity: key, status: 'new', finding });
      continue;
    }

    const entry = state.findings[matched.key]!;
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

  validateReportIdentityMappings(annotated);
  for (const [key, severity] of Object.entries(severities)) {
    state.findings[key]!.severity = severity;
  }

  // Re-processing a round without a report id (a legacy or mismatched
  // report) must not erase the binding an earlier pass persisted.
  const boundRunId = runId ?? state.rounds.find((r) => r.round === options.round)?.runId;
  state.rounds = [
    ...state.rounds.filter((r) => r.round !== options.round),
    { round: options.round, counts, severities, ...(boundRunId !== undefined ? { runId: boundRunId } : {}) },
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
  status: 'converged-dismissal-only' | 'fixes-pending-fresh-round' | 'unresolved';
  recoveryProjection?: RecoveryProjectionFreshness;
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
  requireVerifiedBinding?: boolean;
  /** Hold the ordinary command's precision/event writes under this same target. */
  ownership?: NativeTargetOwnership;
}

export async function recordVerdicts(options: RecordVerdictsOptions): Promise<RecordVerdictsResult> {
  if (options.ownership) {
    return withOwnedNativeOperation(options.ownership, options.gitCommonDir, options.target,
      ownership => recordVerdictsOwned(options, ownership));
  }
  return withNativeTarget(options.gitCommonDir, options.target, ownership => recordVerdictsOwned(options, ownership));
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
  if (state.version === 3) {
    const reviewed = state.rounds.find(r => r.round === options.round);
    if (reviewed?.reportBinding) await verifyRoundBinding(reviewed.reportBinding, target, options.round, reviewed.runId!);
    const prepared = prepareVerdicts(state, { ...options, recordedAt: new Date().toISOString() });
    await writeState(gitCommonDir, prepared.state, ownership);
    return prepared.result;
  }
  if (state.version === 2) throw new ConvergeRunStateError('Semantic verdicts require supported recovery of this target first.');
  const reviewedRound = state.rounds.find((r) => r.round === options.round);
  if (!reviewedRound) {
    throw new ConvergeRunStateError(`Round ${options.round} is not recorded for ${target}.`);
  }
  const updated: FindingEntry[] = [];
  const severities = reviewedRound.severities;
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
    if (reason !== undefined) recorded.verdictReason = reason;
    updated.push(recorded);
  }
  state.updatedAt = new Date().toISOString();
  await writeState(gitCommonDir, state, ownership);

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

/** Pure ordinary verdict projection for retained persistence before any write. */
export function prepareVerdicts(
  source: ConvergeRunState,
  options: Omit<RecordVerdictsOptions, 'gitCommonDir' | 'ownership' | 'requireVerifiedBinding'> & {
    recordedAt: string;
  }
): { state: ConvergeRunState; result: RecordVerdictsResult } {
  const target = options.target.trim();
  if (!target || source.target !== target || ![1, 2, 3].includes(source.version)) {
    throw new ConvergeRunStateError('Native verdict preparation target or version conflict.');
  }
  if (!Number.isFinite(Date.parse(options.recordedAt))) {
    throw new ConvergeRunStateError('Invalid retained verdict timestamp.');
  }

  const state = structuredClone(source);
  const reviewedRound = state.rounds.find((round) => round.round === options.round);
  if (!reviewedRound) {
    throw new ConvergeRunStateError(`Round ${options.round} is not recorded for ${target}.`);
  }

  const pendingBeforeTriage = effectivePendingIdentities(state);
  const updated: FindingEntry[] = [];
  const severities = reviewedRound.severities;

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
    const verdictSeverity = severities?.[key] ?? entry.severity;
    if (
      recorded === entry &&
      entry.pendingRound !== undefined &&
      verdictClearsPending(state, key, entry.pendingRound, options.round, verdictSeverity)
    ) {
      delete entry.pendingRound;
    }
    recorded.verdict = verdict;
    recorded.verdictRound = options.round;
    recorded.verdictSeverity = verdictSeverity;
    if (reason !== undefined) recorded.verdictReason = reason;
    updated.push(recorded);
  }

  state.updatedAt = options.recordedAt;

  let resolution: RoundResolution | undefined;
  if (state.lastAnnotations && state.lastAnnotations.round === options.round) {
    const actionable = state.lastAnnotations.identities.filter(
      (identity) => (identity.status === 'new' || identity.status === 'regating') && identity.gating !== 'none'
    );
    // An untriaged earlier claim remains an obligation even if this report
    // calls it repeat or does not contain it. A zero-new round cannot erase it.
    const unresolved = [...new Set([
      ...effectivePendingIdentities(state),
      ...actionable
        .filter((identity) => {
          const entry = state.findings[identity.identity];
          return !entry || entry.verdict === undefined || entry.verdictRound !== options.round;
        })
        .map((identity) => identity.identity),
    ])].sort();
    const fixedThisRound = Object.values(state.findings).filter(
      (entry) => entry.verdict === 'fixed' && entry.verdictRound === options.round
    ).length;
    resolution = {
      round: options.round,
      actionable: new Set([
        ...actionable.map((identity) => identity.identity),
        ...pendingBeforeTriage,
        ...unresolved,
      ]).size,
      unresolved,
      fixedThisRound,
      ...(recoveryProjectionFreshness(state) ? { recoveryProjection: recoveryProjectionFreshness(state) } : {}),
      status:
        unresolved.length > 0
          ? 'unresolved'
          : fixedThisRound > 0
            ? 'fixes-pending-fresh-round'
            : 'converged-dismissal-only',
    };
  }

  return { state, result: { entries: updated, ...(resolution ? { resolution } : {}) } };
}

/** A nongating followup cannot lower the severity needed for a critical pending source. */
export function verdictClearsPending(state: ConvergeRunState, key: string, pendingRound: number,
  verdictRound: number, verdictSeverity: string | undefined): boolean {
  // Match the pinned pure validator: legacy rounds can lack a severity ledger.
  // Their retained entry remains the conservative evidence for critical triage.
  const severity = state.rounds.find(round => round.round === pendingRound)?.severities?.[key] ?? state.findings[key]?.severity;
  return verdictRound >= pendingRound && (severity !== 'critical' || verdictSeverity === 'critical');
}
