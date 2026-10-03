import { execFileSync } from 'node:child_process';
import { onTestFinished, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { convergeRunStatePath, loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { convergeAttemptStatePath } from '../../src/converge/attempt-budget.js';
import { previewStaleReport, applyStaleReport } from '../../src/converge/stale-report.js';
import { reconcileFlushedRun } from '../../src/converge/delivery-reconciliation.js';
import { resolveQuorumPolicy } from '../../src/dispatch/quorum.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';
import { sampleResult, sampleReview, sampleFinding } from '../telemetry/fixtures.js';

export async function staleFixture(git = false, withHistory: boolean | 'fixed' = false) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-stale-')));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  if (git) execFileSync('git',['init','-q',dir]);
  const cwd = dir;
  const common = git ? join(dir,'.git') : dir;
  const target = 'synthetic-stale';
  if (withHistory) {
    const round = await processRoundReport({gitCommonDir:common,target,round:1,findings:[sampleFinding()]});
    await recordVerdicts({gitCommonDir:common,target,round:1,verdicts:[{key:round.findings[0]!.identity,verdict:withHistory === 'fixed' ? 'fixed' : 'dismissed',reason:'Existing guard independently verified.'}]});
  }
  const report = sampleResult({ reviews: [sampleReview(), sampleReview({model:'openai/gpt', role:'security-auditor', provider:'openai'})] });
  report.run!.converge = { target, round: withHistory ? 2 : 1, attempt: 1 };
  report.stats.totalReviews = 2; report.stats.successfulReviews = 2;
  const reportPath = join(dir, 'report.json');
  await writeFile(reportPath, JSON.stringify(report));
  const reportSha256 = sha256(await readFile(reportPath));
  const options = { gitCommonDir: common, target, headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64),
    validate: vi.fn(async () => {}), run: vi.fn(async () => ({ runId: report.run!.id, reportJsonSha256: reportSha256,
      successfulReviews: 2, totalReviews: 2, deliveryPending: false, hardFailure: false })) };
  await guardReviewLaunch(options);
  const selection = { target, headSha: 'c'.repeat(40), inputSha256: 'd'.repeat(64), reportPath, reportSha256,
    reason: 'The committed fix and effective specification supersede the original report.' };
  const manifestPath = join(dir, 'manifest.json');
  const statePath = convergeRunStatePath(common, target), attemptsPath = convergeAttemptStatePath(common,target);
  const bytes = async () => Promise.all([statePath, attemptsPath, reportPath].map(p => readFile(p)));
  const prepare = async () => {
    const manifest = await previewStaleReport(selection,common);
    await writeFile(manifestPath, JSON.stringify(manifest,null,2)+'\n');
    return manifest;
  };
  const apply = async (mode: 'apply' | 'resume' = 'apply', hooks = {}) => applyStaleReport({manifest:manifestPath,
    manifestSha256:sha256(await readFile(manifestPath)),mode},common,hooks);
  return {dir:common,cwd,target,options,selection,reportPath,reportSha256,manifestPath,statePath,attemptsPath,bytes,prepare,apply};
}

export const deliveredHardFailureRetryReason =
  'Evidence delivery was reconciled; the retained healthy report is stale on the replacement inputs.';

/** Real incident composition: blocking quorum is conclusive, another seat failed, then exact delivery reconciled. */
export async function reconciledHardFailureFixture(git = false, withHistory: boolean | 'fixed' = false) {
  const f = await staleFixture(git, withHistory);
  const report = JSON.parse(await readFile(f.reportPath, 'utf8'));
  const original = report.reviews[0];
  report.run.roster = Array.from({ length: 16 }, (_, index) => ({
    model: `fixture/model-${index + 1}`, role: `fixture-role-${index + 1}`, provider: 'anthropic',
    lane: index < 10 ? 'blocking' : index < 14 ? 'secondary' : index === 14 ? 'async' : 'verification',
  }));
  report.reviews = report.run.roster.slice(0, 15).map((seat: {model:string;role:string;provider:string}, index: number) => ({
    ...original, model: seat.model, role: seat.role, provider: seat.provider,
    ...(index === 14 ? { async: true } : {}),
    ...(index < 7 || index === 10 ? { status: 'success' } : {
      status: index % 3 === 0 ? 'error' : index % 3 === 1 ? 'timeout' : 'parse_failed',
      error: 'Retained non-successful reviewer outcome.',
    }),
  }));
  report.stats.totalReviews = 15;
  report.stats.successfulReviews = 8;
  await writeFile(f.reportPath, JSON.stringify(report));
  f.selection.reportSha256 = sha256(await readFile(f.reportPath));
  f.reportSha256 = f.selection.reportSha256;

  const state = (await loadConvergeRunState(f.dir, f.target))!;
  state.lastLaunch = { ...state.lastLaunch!, reportJsonSha256: f.selection.reportSha256,
    successfulReviews: 8, totalReviews: 15,
    reviewerHealth: { version: 1, policy: resolveQuorumPolicy(10), successfulSeats: 7 },
    deliveryPending: true, hardFailure: true, exitCode: 4 };
  await writeFile(f.statePath, JSON.stringify(state));
  // Reproduce an upgrade after 4.5.1 already authenticated delivery and cleared
  // the only pending bit, before 4.5.2 could retain a durable reconciliation marker.
  state.lastLaunch.deliveryPending = false;
  await writeFile(f.statePath, JSON.stringify(state));

  const runId = state.lastLaunch.runId!;
  const getRun = vi.fn().mockResolvedValue({ kind: 'ok', value: {
    id: runId, provenance: 'live', cycle_id: report.run.cycle_id,
    converge: { target: f.target, round: state.lastLaunch!.round, attempt: state.lastLaunch!.attempt },
    target: { kind: 'pull_request', head_sha: state.lastLaunch.headSha },
    artifacts: [{ kind: 'report_json', stored: true, declared_sha256: f.selection.reportSha256 }],
    findings: [], calls: [],
  } });
  await reconcileFlushedRun(runId, { remaining: [], failed: [], dropped: [] }, {} as never,
    { gitCommonDir: f.dir, getRun });
  return { ...f, retryReason: deliveredHardFailureRetryReason,
    hardFailureSelection: { ...f.selection, retryReason: deliveredHardFailureRetryReason } };
}
