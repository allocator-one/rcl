import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CallRecord, OutcomeRecord } from './stats-store.js';

/**
 * Backfill (RCL-27): seed the model-stats store from a directory of recovered
 * rcl artifacts — round reports (`*.json` with reviews/findings) provide call
 * stats and per-finding supporting models; converge ledgers
 * (`rcl-converge-*-ledger.md`) provide the triage verdicts. Ledger bullets
 * are matched back to their round's report findings by file basename plus
 * text-token overlap, since ledgers cite findings in prose.
 */

export interface LedgerBullet {
  verdict: 'fixed' | 'dismissed';
  text: string;
  reportBase?: string;
}

interface ReportFinding {
  file: string;
  title: string;
  description: string;
  severity?: string;
  models: string[];
}

// Verdict may carry a severity prefix — [fixed], [minor/fixed],
// [important/dismissed] all count.
const BULLET_RE = /^-\s*\[(?:[a-z]+\/)?(fixed|dismissed)\]\s*(.*)$/;

/** Parse a converge ledger into verdict bullets, each tied to its round's report basename. */
export function parseLedgerBullets(ledger: string): LedgerBullet[] {
  const bullets: LedgerBullet[] = [];
  let reportBase: string | undefined;
  let current: LedgerBullet | undefined;
  for (const line of ledger.split('\n')) {
    const round = /^##\s+Round\b.*?report\s+(\S+\.json)/.exec(line);
    if (round) {
      reportBase = basename(round[1]!);
      current = undefined;
      continue;
    }
    const bullet = BULLET_RE.exec(line.trim());
    if (bullet) {
      current = { verdict: bullet[1] as 'fixed' | 'dismissed', text: bullet[2]!, reportBase };
      bullets.push(current);
      continue;
    }
    // Continuation lines of a wrapped bullet.
    if (current && /^\s+\S/.test(line) && !line.trim().startsWith('#')) {
      current.text += ' ' + line.trim();
    } else if (line.trim() === '' || line.startsWith('#')) {
      current = undefined;
    }
  }
  return bullets;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2)
  );
}

/**
 * Match one ledger bullet to the report findings it triaged. A finding
 * matches when its file's basename appears in the bullet and enough of the
 * finding's title tokens appear in the bullet text. Conservative by design:
 * an unmatched bullet contributes nothing rather than mis-attributing.
 */
export function matchBulletToFindings(
  bullet: LedgerBullet,
  findings: ReportFinding[],
  minTitleOverlap = 0.5
): ReportFinding[] {
  const bulletTokens = tokens(bullet.text);
  // Whitespace-delimited words, so "a.ex" never substring-matches "data.ex".
  const bulletWords = bullet.text.split(/[\s'"`()]+/);
  const matches: Array<{ finding: ReportFinding; overlap: number }> = [];
  for (const finding of findings) {
    const base = basename(finding.file);
    const namesFile = bulletWords.some(
      (w) => w === base || w.endsWith(`/${base}`) || w === `${base}:` || w === `${base},`
    );
    if (!namesFile) continue;
    const titleTokens = tokens(finding.title);
    if (titleTokens.size === 0) continue;
    let hits = 0;
    for (const t of titleTokens) if (bulletTokens.has(t)) hits++;
    const overlap = hits / titleTokens.size;
    if (overlap >= minTitleOverlap) matches.push({ finding, overlap });
  }
  return matches.sort((a, b) => b.overlap - a.overlap).map((m) => m.finding);
}

interface RawReport {
  reviews?: Array<{ model?: string; role?: string; durationMs?: number; status?: string }>;
  findings?: Array<{
    file?: string;
    title?: string;
    description?: string;
    severity?: string;
    consensus?: { models?: string[] };
  }>;
}

function reportFindings(report: RawReport): ReportFinding[] {
  return (report.findings ?? [])
    .filter((f) => typeof f.file === 'string' && typeof f.title === 'string')
    .map((f) => ({
      file: f.file!,
      title: f.title!,
      description: f.description ?? '',
      severity: f.severity,
      models: f.consensus?.models ?? [],
    }));
}

export interface SeedResult {
  reportsScanned: number;
  callsSeeded: number;
  ledgersScanned: number;
  bullets: number;
  outcomesSeeded: number;
  unmatchedBullets: number;
}

/** Scan a fixtures directory (read-only) and produce seed records. */
export async function buildSeedRecords(
  dir: string
): Promise<SeedResult & { calls: CallRecord[]; outcomes: OutcomeRecord[] }> {
  const entries = await readdir(dir);
  const reportNames = entries.filter((n) => /^rcl-report-.*\.json$/.test(n));
  const ledgerNames = entries.filter((n) => /^rcl-converge-.*-ledger\.md$/.test(n));

  const calls: CallRecord[] = [];
  const reportsByBase = new Map<string, RawReport>();
  let reportsScanned = 0;
  for (const name of reportNames) {
    const path = join(dir, name);
    let report: RawReport;
    let ts: string;
    try {
      report = JSON.parse(await readFile(path, 'utf8')) as RawReport;
      ts = (await stat(path)).mtime.toISOString();
    } catch {
      continue;
    }
    reportsScanned++;
    reportsByBase.set(name, report);
    for (const r of report.reviews ?? []) {
      if (typeof r.model !== 'string' || typeof r.status !== 'string') continue;
      calls.push({
        ts,
        model: r.model,
        ...(r.role !== undefined ? { role: r.role } : {}),
        durationMs: typeof r.durationMs === 'number' ? r.durationMs : 0,
        status: r.status,
        source: 'seed',
      });
    }
  }

  const outcomes: OutcomeRecord[] = [];
  let bulletsTotal = 0;
  let unmatched = 0;
  let ledgersScanned = 0;
  for (const name of ledgerNames) {
    let ledger: string;
    let ts: string;
    try {
      const path = join(dir, name);
      ledger = await readFile(path, 'utf8');
      ts = (await stat(path)).mtime.toISOString();
    } catch {
      continue;
    }
    ledgersScanned++;
    for (const bullet of parseLedgerBullets(ledger)) {
      bulletsTotal++;
      const report = bullet.reportBase ? reportsByBase.get(bullet.reportBase) : undefined;
      if (!report) {
        unmatched++;
        continue;
      }
      const matched = matchBulletToFindings(bullet, reportFindings(report));
      if (matched.length === 0) {
        unmatched++;
        continue;
      }
      for (const finding of matched) {
        if (finding.models.length === 0) continue;
        const target = name.replace(/^rcl-converge-|-ledger\.md$/g, '');
        outcomes.push({
          ts,
          verdict: bullet.verdict,
          models: finding.models,
          ...(finding.severity !== undefined ? { severity: finding.severity } : {}),
          target,
          // Stable synthetic key so re-seeding the same artifacts collapses
          // to one outcome per finding at load time.
          findingKey: createHash('sha256')
            .update(`${bullet.reportBase ?? ''} ${finding.file} ${finding.title}`)
            .digest('hex')
            .slice(0, 16),
          source: 'seed',
        });
      }
    }
  }

  return {
    reportsScanned,
    callsSeeded: calls.length,
    ledgersScanned,
    bullets: bulletsTotal,
    outcomesSeeded: outcomes.length,
    unmatchedBullets: unmatched,
    calls,
    outcomes,
  };
}
