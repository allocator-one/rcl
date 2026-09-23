import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { processRoundReport, convergeRunStatePath } from '../../src/converge/run-state.js';
import { convergeAttemptStatePath } from '../../src/converge/attempt-budget.js';
import { applyRoundGap, previewRoundGap, type RoundGapManifest } from '../../src/converge/round-gap.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';
import { sampleResult } from '../telemetry/fixtures.js';
const dirs: string[] = [];
export async function cleanup() { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); }
export async function fixture(git = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'rcl-gap-binding-')); dirs.push(cwd);
  if (git) execFileSync('git',['init','-q',cwd]);
  const dir = git ? join(cwd,'.git') : cwd;
  const target = 'synthetic-gap';
  await processRoundReport({ gitCommonDir: dir, target, round: 1, findings: [] });
  const statePath = convergeRunStatePath(dir, target), attemptPath = convergeAttemptStatePath(dir, target);
  const attempts = { version: 2, target, cap: 20, migratedAttempts: 0, attemptsUsed: 3,
    attempts: [1, 2, 3].map(attempt => ({ attempt, claimedAt: '2026-01-01T00:00:00.000Z', pid: process.pid, source: 'claim' as const })), updatedAt: '2026-01-01T00:00:00.000Z' };
  await mkdir(dirname(attemptPath)); await writeFile(attemptPath, JSON.stringify(attempts));
  const report = sampleResult(); report.run!.converge = { target, round: 3, attempt: 3 };
  const reportPath = join(dir, 'report.json'), incompletePath = join(dir, 'incomplete.md');
  await writeFile(reportPath, JSON.stringify(report)); await writeFile(incompletePath, 'Available partial output; controller exit unknown.\n');
  const input = { target, gapRound: 2, admittingRound: 3, attempt: 2, runId: report.run!.id,
    reportPath, incompletePath, reportSha256: sha256(await readFile(reportPath)), incompleteSha256: sha256(await readFile(incompletePath)) };
  const manifestPath = join(dir,'manifest.json');
  async function save(manifest: RoundGapManifest) { await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n'); }
  async function prepare() { const manifest = await previewRoundGap(input,dir); await save(manifest); return manifest; }
  const apply = async (mode: 'apply' | 'resume' = 'apply', hooks = {}) => applyRoundGap({ manifest:manifestPath,manifestSha256:sha256(await readFile(manifestPath)),mode },dir,hooks);
  return { cwd, dir, target, attempts, attemptPath, statePath, report, input, manifestPath, prepare, save, apply };
}
