import { execFileSync } from 'node:child_process';
import { onTestFinished, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { convergeRunStatePath, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { convergeAttemptStatePath } from '../../src/converge/attempt-budget.js';
import { previewStaleReport, applyStaleReport } from '../../src/converge/stale-report.js';
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
