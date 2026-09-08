import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { stableFindingKey } from '../consensus/finding-identity.js';
import type { ConsensusFinding, ModelReview } from '../consensus/types.js';
import { matchBulletToFindings, type LedgerBullet } from '../models/seed.js';
import type { RosterEntry, RunHeader } from '../report/run-header.js';
import { UUID_NAMESPACE_RCL_BACKFILL, uuidv5 } from '../report/uuid.js';
import { declareArtifacts, type ArtifactBytes, type RunEnvelope, type WireCall, type WireFinding } from './envelope.js';
import { deliverable, type WireEvent } from './events.js';
import { scrubDeep, scrubIdentifier, scrubSecrets, scrubText } from './scrub.js';
import { describeOutcome, type HarnessSink } from './sink.js';
import { getRun } from '../evidence/reads.js';

/**
 * `rcl telemetry backfill` (epic IO-12475, sections 8.9–8.10; RCL-38): the
 * reports and converge ledgers a machine kept before evidence existed become
 * day-one history on Harness. Each pre-3.0 report (`rcl-report-*.json`, no
 * `run` header) gets a synthesized header — target `patch` bound to the
 * repository named on the command line, the report bytes as the only digest
 * there is, `provenance: backfill`, a runner claim naming this command — and
 * an id that is a UUIDv5 of `(host, repo, sha256 of the report bytes)`, so
 * the same corpus posted twice is `existing` twice and adds nothing. Ledger
 * bullets matched to the round's findings become `verdicts_recorded` events
 * with ids derived the same way.
 */

export interface BackfillBuildOptions {
  dir: string;
  repo: string;
  host: string;
  rclVersion: string;
}

export interface BackfillRun {
  file: string;
  envelope: RunEnvelope;
  artifacts: ArtifactBytes;
  events: WireEvent[];
}

export interface BackfillBuild {
  runs: BackfillRun[];
  skipped: Array<{ file: string; reason: string }>;
  ledgersScanned: number;
  bulletsMatched: number;
  bulletsUnmatched: number;
}

interface RawReview {
  model?: unknown;
  role?: unknown;
  provider?: unknown;
  durationMs?: unknown;
  status?: unknown;
}

interface RawFinding {
  id?: unknown;
  file?: unknown;
  startLine?: unknown;
  endLine?: unknown;
  severity?: unknown;
  category?: unknown;
  title?: unknown;
  description?: unknown;
  suggestedFix?: unknown;
  consensus?: { models?: unknown } & Record<string, unknown>;
  gating?: { reason?: unknown; verification?: { verdict?: unknown } };
}

interface RawReport {
  run?: unknown;
  reviews?: unknown;
  findings?: unknown;
  belowThresholdFindings?: unknown;
  stats?: Record<string, unknown>;
}

const SEVERITIES = new Set(['critical', 'important', 'minor']);
const STATUSES = new Set(['success', 'timeout', 'error', 'parse_failed', 'canceled']);
// Ledgers were written by hand: any bullet marker, any case for the verdict.
const BULLET_RE = /^[-*+]\s*\[(?:[a-z]+\/)?(fixed|dismissed)\]\s*(.*)$/i;
const ROUND_RE = /^##\s+Round\s+(\d+)\b.*?report:?\s+(\S+\.json)/i;
/** A report cannot have run longer than a week; anything past it is not a duration. */
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
/** rcl did not exist before 2020; a file time outside [then, tomorrow] is not a finishing time. */
const MIN_MTIME_MS = Date.UTC(2020, 0, 1);

/**
 * Read one file as the recovered artifact it claims to be: opened without
 * following a symlink, required to be a regular file, bytes and mtime taken
 * from the same handle so the id (from the bytes) and the timing (from the
 * mtime) describe one version of it.
 */
async function readRegular(path: string): Promise<{ bytes: string; mtime: Date }> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('not a regular file');
    return { bytes: await handle.readFile('utf8'), mtime: info.mtime };
  } finally {
    await handle.close();
  }
}

function reason(err: unknown): string {
  const code = (err as { code?: string }).code;
  if (code === 'ELOOP') return 'is a symbolic link';
  return err instanceof Error ? err.message : String(err);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Text bound for a Postgres column: NUL and the other C0 controls (except
 * tab, newline, carriage return) become spaces before the scrubber sees them
 * — a recovered report may carry a `\\u0000` a live run never could.
 */
function textField(value: unknown, max?: number): string {
  const cleaned = str(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  return max === undefined ? scrubText(cleaned) : scrubText(cleaned, max);
}

function int(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function providerOf(review: RawReview, model: string): string {
  const explicit = str(review.provider);
  if (explicit !== '') return explicit;
  const prefix = model.split('/')[0];
  return prefix && prefix !== model ? prefix : 'unknown';
}

/** The report's findings in the shape the ledger matcher and the wire share. */
function wireFindings(raw: unknown, belowThreshold: boolean, offset: number): Array<{ wire: WireFinding; models: string[] }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ wire: WireFinding; models: string[] }> = [];
  for (const f of raw as RawFinding[]) {
    if (typeof f !== 'object' || f === null || typeof f.file !== 'string' || typeof f.title !== 'string') continue;
    const severity = (SEVERITIES.has(str(f.severity)) ? f.severity : 'minor') as ConsensusFinding['severity'];
    const category = str(f.category, 'other') as ConsensusFinding['category'];
    const startLine = int(f.startLine);
    const endLine = Math.max(startLine, int(f.endLine, startLine));
    const raw = (f.consensus ?? {}) as Record<string, unknown>;
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.replace(/[\u0000-\u001f\u007f]/g, ' ')) : [];
    const models = strings(raw['models']);
    const index = offset + out.length;
    // Rebuilt field by field: a recovered file is not trusted for its shape.
    const consensus = {
      score: typeof raw['score'] === 'number' && Number.isFinite(raw['score']) ? raw['score'] : 0,
      total: typeof raw['total'] === 'number' && Number.isFinite(raw['total']) ? raw['total'] : models.length,
      models,
      roles: strings(raw['roles']),
      crossRole: raw['crossRole'] === true,
      crossModel: raw['crossModel'] === true,
      elevated: raw['elevated'] === true,
    } as unknown as ConsensusFinding['consensus'];
    const gatingReason = str(f.gating?.reason);
    out.push({
      models,
      wire: {
        ref: `f${String(index + 1).padStart(3, '0')}`,
        identity_key: stableFindingKey({ file: f.file, category, startLine, endLine }),
        file: textField(f.file),
        start_line: startLine,
        end_line: endLine,
        severity,
        category,
        title: textField(f.title, 500),
        description: textField(f.description),
        ...(typeof f.suggestedFix === 'string' ? { suggested_fix: textField(f.suggestedFix) } : {}),
        consensus: scrubDeep(consensus),
        gating_reason: (['consensus', 'critical', 'verified'].includes(gatingReason) ? gatingReason : 'none') as WireFinding['gating_reason'],
        ...(typeof f.gating?.verification?.verdict === 'string' ? { verification_verdict: textField(f.gating.verification.verdict, 200) } : {}),
        below_threshold: belowThreshold,
      },
    });
  }
  return out;
}

function wireCalls(reviews: RawReview[]): { calls: WireCall[]; roster: RosterEntry[] } {
  const roster = new Map<string, RosterEntry>();
  const calls: WireCall[] = [];
  for (const review of reviews) {
    if (typeof review !== 'object' || review === null || typeof review.model !== 'string') continue;
    const model = scrubIdentifier(review.model);
    const role = scrubIdentifier(str(review.role, 'general'));
    const provider = scrubIdentifier(providerOf(review, review.model));
    const key = `${model} ${role}`;
    // Identifiers pass the identifier scrubber; a NUL inside one is not an identifier.
    if (/[\u0000-\u001f\u007f]/.test(model + role + provider)) continue;
    if (!roster.has(key)) roster.set(key, { model, role, provider, lane: 'blocking' });
    calls.push({
      model,
      role,
      provider,
      lane: 'blocking',
      chunk_index: 0,
      status: (STATUSES.has(str(review.status)) ? review.status : 'error') as ModelReview['status'],
      duration_ms: int(review.durationMs),
      dropped_findings: 0,
      warnings: [],
      async: false,
    });
  }
  return { calls, roster: [...roster.values()] };
}

interface LedgerRound {
  round: number;
  reportBase: string;
  bullets: LedgerBullet[];
}

/** Rounds and their bullets, each round tied to the report it names. */
function parseLedgerRounds(ledger: string): LedgerRound[] {
  const rounds: LedgerRound[] = [];
  let current: LedgerRound | undefined;
  let bullet: LedgerBullet | undefined;
  for (const line of ledger.split('\n')) {
    const round = ROUND_RE.exec(line);
    if (round) {
      // The path may sit in backticks or quotes and carry trailing punctuation.
      const path = round[2]!.replace(/^[`"'(]+/, '').replace(/[`"',.)]+$/, '');
      current = { round: Number(round[1]), reportBase: basename(path), bullets: [] };
      rounds.push(current);
      bullet = undefined;
      continue;
    }
    if (!current) continue;
    const match = BULLET_RE.exec(line.trim());
    if (match) {
      bullet = { verdict: match[1]!.toLowerCase() as 'fixed' | 'dismissed', text: match[2]!, reportBase: current.reportBase };
      current.bullets.push(bullet);
      continue;
    }
    if (bullet && /^\s+\S/.test(line) && !line.trim().startsWith('#')) {
      bullet.text += ' ' + line.trim();
    } else if (line.trim() === '' || line.startsWith('#')) {
      bullet = undefined;
    }
  }
  return rounds;
}

export async function buildBackfillRuns(options: BackfillBuildOptions): Promise<BackfillBuild> {
  const { dir, repo, host, rclVersion } = options;
  const entries = (await readdir(dir)).sort();
  const reportNames = entries.filter((n) => /^rcl-report-.*\.json$/.test(n));
  const ledgerNames = entries.filter((n) => /^rcl-converge-.*-ledger\.md$/.test(n));
  const skipped: BackfillBuild['skipped'] = [];
  const runs: BackfillRun[] = [];
  // Findings per report basename, for the ledger matcher: file, title, models and the wire identity.
  const findingsByBase = new Map<string, Array<{ file: string; title: string; description: string; severity?: string; models: string[]; identity: string }>>();
  const runByBase = new Map<string, BackfillRun>();

  const hostKey = host.toLowerCase();
  // GitHub names are case-insensitive; the id must not depend on how the
  // caller spelled the repository.
  const repoKey = repo.toLowerCase();

  for (const name of reportNames) {
    try {
      const { bytes, mtime } = await readRegular(join(dir, name));
      const report = JSON.parse(bytes) as RawReport;
      if (typeof report !== 'object' || report === null || !Array.isArray(report.reviews)) {
        skipped.push({ file: name, reason: 'no reviews array — not an rcl report' });
        continue;
      }
      if (report.run !== undefined) {
        skipped.push({ file: name, reason: 'carries a run header (rcl ≥ 3.0) — it was delivered when written; use rcl telemetry flush for a spooled one' });
        continue;
      }
      const { calls, roster } = wireCalls(report.reviews as RawReview[]);
      const kept = wireFindings(report.findings, false, 0);
      const below = wireFindings(report.belowThresholdFindings, true, kept.length);
      const stats = report.stats ?? {};
      const durationMs = int(stats['durationMs']);
      if (durationMs > MAX_DURATION_MS) {
        skipped.push({ file: name, reason: `stats.durationMs ${durationMs} is not a review duration` });
        continue;
      }
      const finishedAt = mtime;
      const startedAt = new Date(finishedAt.getTime() - durationMs);
      if (
        !Number.isFinite(finishedAt.getTime()) ||
        finishedAt.getTime() < MIN_MTIME_MS ||
        finishedAt.getTime() > Date.now() + 24 * 60 * 60 * 1000 ||
        !Number.isFinite(startedAt.getTime())
      ) {
        skipped.push({ file: name, reason: `file time ${finishedAt.toISOString()} is not a plausible finishing time` });
        continue;
      }
      const digest = sha256(bytes);
      const id = uuidv5(`${hostKey}|${repoKey}|${digest}`, UUID_NAMESPACE_RCL_BACKFILL);
      const run: RunHeader = {
        id,
        rcl_version: 'pre-3.0',
        command: 'review',
        target: { kind: 'patch', repo, diff_sha256: digest, files: 0, additions: 0, deletions: 0 },
        roster,
        config_sha256: sha256('rcl telemetry backfill'),
        thresholds: { min_consensus_score: 0, min_confidence: 0, dedupe_line_window: 0, jaccard_threshold: 0 },
        // Pre-gating reports carried every finding; no verification pass ran.
        gating: { mode: 'all-findings', min_models: 0, verification_timeout_ms: 0 },
        context_files: [],
        runner: { kind: 'agent', agent: 'rcl telemetry backfill', host: scrubText(host, 64) },
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: durationMs,
        ci_exit_code: 0,
        provenance: 'backfill',
      };
      const reviews = report.reviews as RawReview[];
      const envelopeStats: RunEnvelope['stats'] = {
        totalReviews: int(stats['totalReviews'], reviews.length),
        successfulReviews: int(stats['successfulReviews'], calls.filter((c) => c.status === 'success').length),
        totalRawFindings: int(stats['totalRawFindings'], kept.length + below.length),
        totalDeduped: int(stats['totalDeduped'], kept.length),
        belowThreshold: int(stats['belowThreshold'], below.length),
        durationMs,
      };
      const mdName = name.replace(/\.json$/, '.md');
      let reportMd: string | undefined;
      if (entries.includes(mdName)) {
        try {
          reportMd = (await readRegular(join(dir, mdName))).bytes;
        } catch (err) {
          skipped.push({ file: mdName, reason: `companion markdown not read: ${reason(err)}` });
        }
      }
      // What leaves the machine is scrubbed as a live report would be; the run
      // id keeps the digest of the file as found, so it names the same file
      // whatever the scrubber removes.
      const artifacts: ArtifactBytes = { report_json: scrubSecrets(bytes), ...(reportMd !== undefined ? { report_md: scrubSecrets(reportMd) } : {}) };
      const envelope: RunEnvelope = {
        run,
        findings: [...kept, ...below].map((f) => f.wire),
        calls,
        stats: envelopeStats,
        artifacts_declared: declareArtifacts(artifacts),
        delivery: { mode: 'direct' },
      };
      const built: BackfillRun = { file: name, envelope, artifacts, events: [] };
      runs.push(built);
      runByBase.set(name, built);
      findingsByBase.set(
        name,
        [...kept, ...below].map((f) => ({ file: f.wire.file, title: f.wire.title, description: f.wire.description, severity: f.wire.severity, models: f.models, identity: f.wire.identity_key }))
      );
    } catch (err) {
      skipped.push({ file: name, reason: `not read as a report: ${reason(err)}` });
    }
  }
  void rclVersion;

  let bulletsMatched = 0;
  let bulletsUnmatched = 0;
  let ledgersScanned = 0;
  for (const name of ledgerNames) {
    let ledger: string;
    let mtime: Date;
    try {
      ({ bytes: ledger, mtime } = await readRegular(join(dir, name)));
    } catch (err) {
      skipped.push({ file: name, reason: `ledger not read: ${reason(err)}` });
      continue;
    }
    ledgersScanned++;
    const target = name.replace(/^rcl-converge-|-ledger\.md$/g, '');
    for (const round of parseLedgerRounds(ledger)) {
      const run = runByBase.get(round.reportBase);
      const findings = findingsByBase.get(round.reportBase);
      if (!run || !findings) {
        bulletsUnmatched += round.bullets.length;
        continue;
      }
      const verdicts: Array<Record<string, unknown>> = [];
      for (const bullet of round.bullets) {
        const matched = matchBulletToFindings(bullet, findings);
        if (matched.length === 0) {
          bulletsUnmatched++;
          continue;
        }
        bulletsMatched++;
        for (const finding of matched as typeof findings) {
          verdicts.push({
            identity_key: finding.identity,
            verdict: bullet.verdict,
            reason: textField(bullet.text, 500),
            ...(finding.severity !== undefined ? { severity: finding.severity } : {}),
            models: finding.models,
          });
        }
      }
      if (verdicts.length === 0) continue;
      // The server takes one verdict per identity in an event; when two bullets
      // of a round name the same finding, the later one is the round's verdict.
      const byIdentity = new Map<string, Record<string, unknown>>();
      for (const v of verdicts) byIdentity.set(String(v['identity_key']), v);
      verdicts.length = 0;
      verdicts.push(...byIdentity.values());
      const fingerprint = verdicts.map((v) => `${v['identity_key']}:${v['verdict']}`).sort().join(',');
      run.events.push({
        id: uuidv5(`${run.envelope.run.id}|verdicts|${round.round}|${fingerprint}`, UUID_NAMESPACE_RCL_BACKFILL),
        kind: 'verdicts_recorded',
        converge_target: scrubIdentifier(target),
        run_id: run.envelope.run.id,
        round: round.round,
        payload: scrubDeep({ verdicts }),
        occurred_at: mtime.toISOString(),
      });
    }
  }

  return { runs, skipped, ledgersScanned, bulletsMatched, bulletsUnmatched };
}

export interface BackfillOptions {
  dir: string;
  repo: string;
  rclVersion: string;
  dryRun?: boolean;
}

export interface BackfillDeps {
  /** Required to post; a dry run builds without one. */
  sink?: HarnessSink;
  host: string;
  /** The host is a stand-in (no credential): ids differ from the real backfill's. */
  placeholderHost?: boolean;
  progress?: (line: string) => void;
}

export interface BackfillSummary {
  dryRun: boolean;
  host: string;
  placeholderHost: boolean;
  runs: number;
  created: number;
  existing: number;
  skipped: number;
  /** What the build holds, whether or not it was posted (the dry run's whole answer). */
  planned: { artifacts: number; events: number; verdicts: number };
  /** Artifacts uploaded for runs created by this invocation; an already-recorded run keeps what it has. */
  artifacts: number;
  events: { inserted: number; duplicates: number };
  failed: Array<{ file: string; reason: string }>;
  ledgersScanned: number;
  bulletsMatched: number;
  bulletsUnmatched: number;
  skippedFiles: Array<{ file: string; reason: string }>;
}

/** Post every recovered run, its artifacts and its verdict events; a refused run is reported and the rest continue. */
export async function runBackfill(options: BackfillOptions, deps: BackfillDeps): Promise<BackfillSummary> {
  const built = await buildBackfillRuns({ dir: options.dir, repo: options.repo, host: deps.host, rclVersion: options.rclVersion });
  const summary: BackfillSummary = {
    dryRun: options.dryRun === true,
    host: deps.host,
    placeholderHost: deps.placeholderHost === true,
    runs: built.runs.length,
    created: 0,
    existing: 0,
    skipped: built.skipped.length,
    planned: {
      artifacts: built.runs.reduce((n, r) => n + r.envelope.artifacts_declared.length, 0),
      events: built.runs.reduce((n, r) => n + r.events.length, 0),
      verdicts: built.runs.reduce((n, r) => n + r.events.reduce((m, e) => m + ((e.payload['verdicts'] as unknown[] | undefined)?.length ?? 0), 0), 0),
    },
    artifacts: 0,
    events: { inserted: 0, duplicates: 0 },
    failed: [],
    ledgersScanned: built.ledgersScanned,
    bulletsMatched: built.bulletsMatched,
    bulletsUnmatched: built.bulletsUnmatched,
    skippedFiles: built.skipped,
  };
  if (summary.dryRun) return summary;
  const sink = deps.sink;
  if (!sink) throw new Error('a Harness sink is required to post a backfill; only a dry run builds without one');

  for (const run of built.runs) {
    const posted = await sink.postRun(run.envelope);
    if (posted.kind !== 'ok') {
      summary.failed.push({ file: run.file, reason: describeOutcome(posted) });
      deps.progress?.(`${run.file}: ${describeOutcome(posted)}`);
      continue;
    }
    if (posted.value.status === 'created') summary.created++;
    else summary.existing++;
    // A run created here gets every artifact. A run the server already holds
    // gets only what it is missing — the server's own artifact state says
    // which — so a second pass moves no report body it already has, and a
    // first pass that lost an upload is healed by the next.
    let wanted: ReadonlySet<'report_json' | 'report_md'>;
    if (posted.value.status === 'created') {
      wanted = new Set(['report_json', 'report_md']);
    } else {
      const known = await getRun(sink, run.envelope.run.id);
      if (known.kind !== 'ok') {
        summary.failed.push({ file: `${run.file} (artifact state)`, reason: describeOutcome(known) });
        wanted = new Set();
      } else {
        wanted = new Set(
          (known.value.artifacts ?? [])
            .filter((a) => !a.stored && (a.kind === 'report_json' || a.kind === 'report_md'))
            .map((a) => a.kind as 'report_json' | 'report_md')
        );
      }
    }
    for (const kind of ['report_json', 'report_md'] as const) {
      const bytes = run.artifacts[kind];
      if (bytes === undefined || !wanted.has(kind)) continue;
      const put = await sink.putArtifact(run.envelope.run.id, kind, bytes);
      if (put.kind === 'ok') summary.artifacts++;
      else summary.failed.push({ file: `${run.file} (${kind})`, reason: describeOutcome(put) });
    }
    const events = run.events.filter(deliverable);
    if (events.length > 0) {
      const sent = await sink.postEvents(events);
      if (sent.kind === 'ok') {
        summary.events.inserted += sent.value.inserted;
        summary.events.duplicates += sent.value.duplicates;
      } else {
        summary.failed.push({ file: `${run.file} (verdicts)`, reason: describeOutcome(sent) });
      }
    }
    deps.progress?.(`${run.file}: ${posted.value.status} ${run.envelope.run.id}`);
  }
  return summary;
}
