import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { stableFindingKey } from '../consensus/finding-identity.js';
import type { ConsensusFinding, ModelReview } from '../consensus/types.js';
import { matchBulletToFindings, type LedgerBullet } from '../models/seed.js';
import type { RosterEntry, RunHeader } from '../report/run-header.js';
import { UUID_NAMESPACE_RCL_BACKFILL, uuidv5 } from '../report/uuid.js';
import { declareArtifacts, type ArtifactBytes, type RunEnvelope, type WireCall, type WireFinding } from './envelope.js';
import { deliverable, type WireEvent } from './events.js';
import { scrubDeep, scrubIdentifier, scrubText } from './scrub.js';
import { describeOutcome, type HarnessSink } from './sink.js';

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
const BULLET_RE = /^-\s*\[(?:[a-z]+\/)?(fixed|dismissed)\]\s*(.*)$/;
const ROUND_RE = /^##\s+Round\s+(\d+)\b.*?report\s+(\S+\.json)/;

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
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
    const models = Array.isArray(f.consensus?.models) ? (f.consensus!.models as unknown[]).filter((m): m is string => typeof m === 'string') : [];
    const index = offset + out.length;
    const consensus = (f.consensus ?? { score: 0, total: 0, models, roles: [], crossRole: false, crossModel: false, elevated: false }) as unknown as ConsensusFinding['consensus'];
    const gatingReason = str(f.gating?.reason);
    out.push({
      models,
      wire: {
        ref: `f${String(index + 1).padStart(3, '0')}`,
        identity_key: stableFindingKey({ file: f.file, category, startLine, endLine }),
        file: scrubText(f.file),
        start_line: startLine,
        end_line: endLine,
        severity,
        category,
        title: scrubText(f.title, 500),
        description: scrubText(str(f.description)),
        ...(typeof f.suggestedFix === 'string' ? { suggested_fix: scrubText(f.suggestedFix) } : {}),
        consensus: scrubDeep(consensus),
        gating_reason: (['consensus', 'critical', 'verified'].includes(gatingReason) ? gatingReason : 'none') as WireFinding['gating_reason'],
        ...(typeof f.gating?.verification?.verdict === 'string' ? { verification_verdict: scrubText(f.gating.verification.verdict) } : {}),
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
      current = { round: Number(round[1]), reportBase: basename(round[2]!), bullets: [] };
      rounds.push(current);
      bullet = undefined;
      continue;
    }
    if (!current) continue;
    const match = BULLET_RE.exec(line.trim());
    if (match) {
      bullet = { verdict: match[1] as 'fixed' | 'dismissed', text: match[2]!, reportBase: current.reportBase };
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

  for (const name of reportNames) {
    const path = join(dir, name);
    let bytes: string;
    let report: RawReport;
    let mtime: Date;
    try {
      bytes = await readFile(path, 'utf8');
      report = JSON.parse(bytes) as RawReport;
      mtime = (await stat(path)).mtime;
    } catch (err) {
      skipped.push({ file: name, reason: `unreadable: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
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
    const finishedAt = mtime;
    const startedAt = new Date(finishedAt.getTime() - durationMs);
    const digest = sha256(bytes);
    const id = uuidv5(`${host}|${repo}|${digest}`, UUID_NAMESPACE_RCL_BACKFILL);
    const run: RunHeader = {
      id,
      rcl_version: 'pre-3.0',
      command: 'review',
      target: { kind: 'patch', repo, diff_sha256: digest, files: 0, additions: 0, deletions: 0 },
      roster,
      config_sha256: sha256('rcl telemetry backfill'),
      thresholds: { min_consensus_score: 0, min_confidence: 0, dedupe_line_window: 0, jaccard_threshold: 0 },
      gating: { mode: 'legacy' as RunHeader['gating']['mode'], min_models: 0, verification_timeout_ms: 0 },
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
    const mdPath = join(dir, name.replace(/\.json$/, '.md'));
    let reportMd: string | undefined;
    try {
      reportMd = await readFile(mdPath, 'utf8');
    } catch {
      reportMd = undefined;
    }
    const artifacts: ArtifactBytes = { report_json: bytes, ...(reportMd !== undefined ? { report_md: reportMd } : {}) };
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
    void rclVersion;
  }

  let bulletsMatched = 0;
  let bulletsUnmatched = 0;
  let ledgersScanned = 0;
  for (const name of ledgerNames) {
    let ledger: string;
    let mtime: Date;
    try {
      ledger = await readFile(join(dir, name), 'utf8');
      mtime = (await stat(join(dir, name))).mtime;
    } catch {
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
            reason: scrubText(bullet.text, 500),
            ...(finding.severity !== undefined ? { severity: finding.severity } : {}),
            models: finding.models,
          });
        }
      }
      if (verdicts.length === 0) continue;
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
  sink: HarnessSink;
  host: string;
  progress?: (line: string) => void;
}

export interface BackfillSummary {
  dryRun: boolean;
  runs: number;
  created: number;
  existing: number;
  skipped: number;
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
    runs: built.runs.length,
    created: 0,
    existing: 0,
    skipped: built.skipped.length,
    artifacts: 0,
    events: { inserted: 0, duplicates: 0 },
    failed: [],
    ledgersScanned: built.ledgersScanned,
    bulletsMatched: built.bulletsMatched,
    bulletsUnmatched: built.bulletsUnmatched,
    skippedFiles: built.skipped,
  };
  if (summary.dryRun) return summary;

  for (const run of built.runs) {
    const posted = await deps.sink.postRun(run.envelope);
    if (posted.kind !== 'ok') {
      summary.failed.push({ file: run.file, reason: describeOutcome(posted) });
      deps.progress?.(`${run.file}: ${describeOutcome(posted)}`);
      continue;
    }
    if (posted.value.status === 'created') summary.created++;
    else summary.existing++;
    for (const kind of ['report_json', 'report_md'] as const) {
      const bytes = run.artifacts[kind];
      if (bytes === undefined) continue;
      const put = await deps.sink.putArtifact(run.envelope.run.id, kind, bytes);
      if (put.kind === 'ok') summary.artifacts++;
      else summary.failed.push({ file: `${run.file} (${kind})`, reason: describeOutcome(put) });
    }
    const events = run.events.filter(deliverable);
    if (events.length > 0) {
      const sent = await deps.sink.postEvents(events);
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
