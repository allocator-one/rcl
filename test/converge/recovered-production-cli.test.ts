import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { installRecoveredProduction } from '../fixtures/recovered-production.js';
import { installTriagedRecoveredProduction } from '../fixtures/guarded-recovered-production.js';
import { convergeAttemptStatePath, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { sha, uuid } from '../evidence/recovery-validation/fixtures.js';
const roots: string[] = [];
const servers: Server[] = [];
const exec = promisify(execFile);
const entry = process.env.RCL_TEST_PACKAGED_CLI ?? fileURLToPath(new URL('../../dist/index.js', import.meta.url));
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(syntheticFindings?: Array<Record<string, unknown>> | ((model: string) => Array<Record<string, unknown>>)) {
  const root = await mkdtemp(join(tmpdir(), 'rcl-recovered-cli-')); roots.push(root);
  const repo = join(root, 'repo'); await mkdir(repo);
  const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  await exec('git', ['init', '-q'], { cwd: repo, env: gitEnv });
  await exec('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: repo, env: gitEnv });
  await mkdir(join(repo, '.harness-cli')); await writeFile(join(repo, '.harness-cli', 'config.json'), '{}');
  const common = join(repo, '.git'); const recovered = await installRecoveredProduction(common);
  await installTriagedRecoveredProduction(common);
  const patch = join(root, 'change.patch');
  await writeFile(patch, 'diff --git a/cache.ts b/cache.ts\n--- a/cache.ts\n+++ b/cache.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n');
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ models: ['openai-compat/synthetic-a', 'openai-compat/synthetic-b'], roles: ['general'],
    secondaryModels: [], asyncModels: [], gating: { mode: 'all-findings' }, thresholds: { minConfidence: 0.6, minConsensusScore: 0.75 },
    harness: { telemetry: 'full' }, maxRetries: 0, timeout: 2000, concurrency: 2 }));
  const requests: Array<{ method: string; path: string; raw: string; body: any }> = [];
  let onProvider: (() => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const path = new URL(req.url!, 'http://127.0.0.1').pathname;
      const body = raw && !path.includes('/artifacts/') ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method!, path, raw, body });
      let result: unknown;
      if (path === '/v1/chat/completions') {
        const change = onProvider; onProvider = undefined; await change?.();
        const findings = (typeof syntheticFindings==='function'? syntheticFindings(body.model):syntheticFindings) ?? [
          { id: 'expiry', file: 'cache.ts', startLine: 10, endLine: 12, category: 'correctness', severity: 'important', confidence: 0.99,
            title: 'cache.read', description: recovered.selection.descriptor.invariant,
            suggestedFix: recovered.selection.descriptor.evidence[0] },
          { id: 'tenant', file: 'cache.ts', startLine: 10, endLine: 12, category: 'security', severity: 'important', confidence: 0.99,
            title: 'Foreign tenant data disclosure', description: 'Authorization accepts a foreign account identifier before validating tenant ownership.',
            suggestedFix: 'Check tenant membership before authorizing the account.' },
          { id: 'appendix', file: 'appendix.ts', startLine: 2, endLine: 4, category: 'tests', severity: 'minor', confidence: 0.1,
            title: 'Appendix regression coverage', description: 'The regression fixture omits the empty input boundary.' },
        ];
        result = { id: 'synthetic-completion', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify({ findings: findings.filter(finding => finding.id !== 'appendix' || body.model === 'synthetic-a') }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
      } else if (path === '/api/v1/reviews/runs' && req.method === 'POST') {
        result = { data: { id: body.run.id, url: 'http://synthetic.invalid/run', artifacts_expected: ['report_json', 'report_md'] } };
      } else if (path.includes('/artifacts/') && req.method === 'PUT') {
        result = { data: { kind: path.split('/').at(-1), sha256: sha(raw) } };
      } else if (path === '/api/v1/reviews/converge/events' && req.method === 'POST') {
        result = { data: { inserted: body.events.length, duplicates: 0 } };
      } else if (path === '/api/v1/reviews/model-stats') {
        result = { data: { models: [] }, meta: { evidence_protocol_version: 2, bound_classification_protocol: 1 } };
      } else if (path === '/api/v1/reviews/runs' && req.method === 'GET') {
        result = { data: [], meta: { evidence_protocol_version: 2, bound_classification_protocol: 1 } };
      } else { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = { ...gitEnv, XDG_CONFIG_HOME: join(root, 'config'), RCL_DATA_DIR: join(root, 'data'), RCL_NO_HARNESS_KEYS: '1',
    HARNESS_API_URL: url, HARNESS_API_TOKEN: 'synthetic-only', OPENAI_COMPAT_BASE_URL: `${url}/v1`, OPENAI_COMPAT_API_KEY: 'local',
    NO_COLOR: '1', FORCE_COLOR: '0', RCL_RUNNER: 'human' };
  const reportPath = join(root, 'review.json'); const markdownPath = join(root, 'review.md');
  async function command(args: string[], cwd=repo) {
    try { const out = await exec(process.execPath, [entry, ...args], { cwd, env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }); return { code: 0, ...out }; }
    catch (error) { const e = error as Error & { code: number; stdout: string; stderr: string }; return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
  }
  return { root, common, recovered, requests, reportPath, markdownPath, command,
    providerChange: (change: () => Promise<void>) => { onProvider = change; },
    review: (target=recovered.plan.target,cwd=repo,guarded=target === recovered.plan.target && cwd === repo,round='2') => command(['review', patch, '--config', config, '--converge-target', target,
      ...(guarded ? ['--guarded-converge'] : ['--round', round, '--attempt', '6']),
      '--head-sha', 'b'.repeat(40), '--base-sha', 'a'.repeat(40), '--for-pr', 'synthetic/recovery#7',
      '--json-file', reportPath, '--markdown', markdownPath, '--json', ...(cwd===repo? ['--evidence-required']:['--no-telemetry'])],cwd),
    admit: async () => {
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      return command(['converge-report', '--target', recovered.plan.target, '--round', String(report.run.converge.round), '--report', reportPath, '--json']);
    },
  };
}
it('refuses an unguarded recovered-v3 producer before provider calls or accounting changes', async () => {
  const f = await fixture();
  const before = await readFile(f.recovered.path, 'utf8');
  const attemptsBefore = await loadConvergeAttemptState(f.common, f.recovered.plan.target);
  const reviewed = await f.review(f.recovered.plan.target, undefined, false, '3');
  expect(reviewed.code).not.toBe(0);
  expect(reviewed.stderr).toContain('recovery_guard_required');
  expect(f.requests.filter(request => request.path === '/v1/chat/completions')).toEqual([]);
  expect(await readFile(f.recovered.path, 'utf8')).toBe(before);
  expect(await loadConvergeAttemptState(f.common, f.recovered.plan.target)).toEqual(attemptsBefore);
}, 30000);

it('refuses a fabricated marked recovered report without an exact completed launch', async () => {
  const f = await fixture();
  const before = await readFile(f.recovered.path, 'utf8');
  const attemptsBefore = await loadConvergeAttemptState(f.common, f.recovered.plan.target);
  const report = JSON.parse(f.recovered.reportJson);
  const runId = uuid(991);
  report.run.id = runId;
  report.run.converge = { target: f.recovered.plan.target, round: 3, attempt: 2,
    recovery_source: { version: 1, native_sha256: sha(before) } };
  report.run.gating = { ...report.run.gating, bound_classification_protocol: 1 };
  const all = [...report.findings, ...(report.belowThresholdFindings ?? [])];
  for (const [index, finding] of all.entries()) {
    finding.identity = `report:${runId}:${String(index + 1).padStart(16, '0')}`;
  }
  const reportJson = JSON.stringify(report);
  await expect(processRoundReport({ gitCommonDir: f.common, target: f.recovered.plan.target,
    round: 3, runId, findings: all, reportSha256: sha(reportJson), evidence: { reportJson } }))
    .rejects.toThrow('recovery_launch_mismatch');
  expect(await readFile(f.recovered.path, 'utf8')).toBe(before);
  expect(await loadConvergeAttemptState(f.common, f.recovered.plan.target)).toEqual(attemptsBefore);
}, 30000);

it('refuses an explicit report digest that disagrees with immutable report evidence without mutating authority', async () => {
  const f = await fixture(), target = f.recovered.plan.target;
  const nativeBeforeLaunch = await readFile(f.recovered.path, 'utf8');
  const round = Math.max(...JSON.parse(nativeBeforeLaunch).rounds.map((entry: { round: number }) => entry.round)) + 1;
  const runId = uuid(994);
  const report = JSON.parse(f.recovered.reportJson);
  report.run.id = runId;
  report.run.converge = { target, round, attempt: 2,
    recovery_source: { version: 1, native_sha256: sha(nativeBeforeLaunch) } };
  report.run.gating = { ...report.run.gating, bound_classification_protocol: 1 };
  report.findings = [];
  report.belowThresholdFindings = [];
  const reportJson = JSON.stringify(report);
  await guardReviewLaunch({ gitCommonDir: f.common, target, recoverySource: report.run.converge.recovery_source,
    headSha: 'b'.repeat(40), inputSha256: 'c'.repeat(64), round, validate: async () => {},
    run: async () => ({ runId, reportJsonSha256: sha(reportJson), successfulReviews: 2,
      totalReviews: 2, deliveryPending: false }) });
  const attemptPath = convergeAttemptStatePath(f.common, target);
  const nativeBeforeAdmission = await readFile(f.recovered.path, 'utf8');
  const attemptsBeforeAdmission = await readFile(attemptPath, 'utf8');
  await expect(processRoundReport({ gitCommonDir: f.common, target, round, runId, findings: [],
    reportSha256: 'e'.repeat(64), evidence: { reportJson } }))
    .rejects.toThrow('report_digest_mismatch');
  expect(await readFile(f.recovered.path, 'utf8')).toBe(nativeBeforeAdmission);
  expect(await readFile(attemptPath, 'utf8')).toBe(attemptsBeforeAdmission);
}, 30000);

it('refuses recovered admission backed only by a legacy native launch without durable attempt accounting', async () => {
  const f = await fixture();
  const state = JSON.parse(await readFile(f.recovered.path, 'utf8'));
  const report = JSON.parse(f.recovered.reportJson);
  const runId = uuid(992);
  report.run.id = runId;
  report.run.converge = { target: f.recovered.plan.target, round: 3, attempt: 2,
    recovery_source: { version: 1, native_sha256: '0'.repeat(64) } };
  report.run.gating = { ...report.run.gating, bound_classification_protocol: 1 };
  const all = [...report.findings, ...(report.belowThresholdFindings ?? [])];
  for (const [index, finding] of all.entries()) {
    finding.identity = `report:${runId}:${String(index + 1).padStart(16, '0')}`;
  }
  const reportJson = JSON.stringify(report);
  state.lastLaunch = { status: 'completed', attempt: 2, round: 3, headSha: 'b'.repeat(40),
    inputSha256: 'c'.repeat(64), startedAt: '2026-10-04T00:00:00.000Z', pid: process.pid,
    runId, reportJsonSha256: 'd'.repeat(64), successfulReviews: 2, totalReviews: 2, deliveryPending: false };
  const nativeBytes = JSON.stringify(state);
  report.run.converge.recovery_source.native_sha256 = sha(nativeBytes);
  const boundReportJson = JSON.stringify(report);
  await writeFile(f.recovered.path, nativeBytes);
  await rm(convergeAttemptStatePath(f.common, f.recovered.plan.target));
  await expect(processRoundReport({ gitCommonDir: f.common, target: f.recovered.plan.target,
    round: 3, runId, findings: all, reportSha256: sha(boundReportJson), evidence: { reportJson: boundReportJson } }))
    .rejects.toThrow('recovery_launch_required');
  expect(await readFile(f.recovered.path, 'utf8')).toBe(nativeBytes);
  expect(await loadConvergeAttemptState(f.common, f.recovered.plan.target)).toBeUndefined();
}, 30000);
it('guarded recovered CLI derives its ordinal and admits the exact unchanged predecessor after dispatch', async () => {
  const f = await fixture();
  const recovered = f.recovered;
  const before = await readFile(recovered.path, 'utf8');
  const source = JSON.parse(before);
  const round = Math.max(...source.rounds.map((entry: { round: number }) => entry.round)) + 1;
  const reviewed = await f.command(['review', join(f.root, 'change.patch'), '--config', join(f.root, 'config.json'),
    '--converge-target', recovered.plan.target, '--guarded-converge',
    '--head-sha', 'b'.repeat(40), '--base-sha', 'a'.repeat(40), '--for-pr', 'synthetic/recovery#7',
    '--json-file', f.reportPath, '--markdown', f.markdownPath, '--json', '--evidence-required']);
  expect(reviewed.code, reviewed.stderr).toBe(0);
  const raw = await readFile(f.reportPath, 'utf8');
  const report = JSON.parse(raw);
  expect(report.run.converge).toMatchObject({ target: recovered.plan.target, round, attempt: 2,
    recovery_source: { version: 1, native_sha256: sha(before) } });
  expect(await readFile(recovered.path, 'utf8')).toBe(before);
  expect(await loadConvergeAttemptState(f.common, recovered.plan.target)).toMatchObject({ attemptsUsed: 2,
    lastLaunch: { status: 'completed', attempt: 2, round, runId: report.run.id } });
  const admitted = await f.command(['converge-report', '--target', recovered.plan.target, '--round', String(round),
    '--report', f.reportPath, '--json']);
  expect(admitted.code, admitted.stderr).toBe(0);
  const after = JSON.parse(await readFile(recovered.path, 'utf8'));
  expect(after.rounds.slice(0, -1)).toEqual(source.rounds);
  expect(after.rounds.at(-1).reportBinding.reportSha256).toBe(sha(raw));
  expect(after.recovery).toEqual(source.recovery);
  expect(f.requests.filter(request => request.path === '/v1/chat/completions')).toHaveLength(2);
}, 30000);

it('consumes one exact standalone claim for recovered production without spending a second attempt', async () => {
  const f = await fixture(), target = f.recovered.plan.target;
  const before = await readFile(f.recovered.path, 'utf8');
  const seedRound = Math.max(...JSON.parse(before).rounds.map((entry: { round: number }) => entry.round)) + 1;
  const seedRunId = uuid(993);
  const seed = JSON.parse(f.recovered.reportJson);
  seed.run.id = seedRunId;
  seed.run.converge = { target, round: seedRound, attempt: 2,
    recovery_source: { version: 1, native_sha256: sha(before) } };
  seed.run.gating = { ...seed.run.gating, bound_classification_protocol: 1 };
  seed.findings = []; seed.belowThresholdFindings = [];
  const seedJson = JSON.stringify(seed);
  await guardReviewLaunch({ gitCommonDir: f.common, target, recoverySource: seed.run.converge.recovery_source,
    headSha: 'b'.repeat(40), inputSha256: 'c'.repeat(64), round: seedRound, validate: async () => {},
    run: async () => ({ runId: seedRunId, reportJsonSha256: sha(seedJson), successfulReviews: 2,
      totalReviews: 2, deliveryPending: false }) });
  await processRoundReport({ gitCommonDir: f.common, target, round: seedRound, runId: seedRunId,
    findings: [], reportSha256: sha(seedJson), evidence: { reportJson: seedJson } });
  await recordVerdicts({ gitCommonDir: f.common, target, round: seedRound, verdicts: [] });
  expect(await loadConvergeAttemptState(f.common, target)).toMatchObject({ attemptsUsed: 2,
    lastLaunch: { attempt: 2, round: seedRound, status: 'completed' } });

  const claimed = await f.command(['converge-attempt', '--target', target, '--json']);
  expect(claimed.code, claimed.stderr).toBe(0);
  expect(JSON.parse(claimed.stdout)).toMatchObject({ target, attempt: 3, attemptsUsed: 3 });
  const callsBeforeRefusal = f.requests.filter(request => request.path === '/v1/chat/completions').length;
  const wrong = await f.command(['review', join(f.root, 'change.patch'), '--config', join(f.root, 'config.json'),
    '--converge-target', target, '--guarded-converge', '--attempt', '2',
    '--head-sha', 'b'.repeat(40), '--base-sha', 'a'.repeat(40), '--for-pr', 'synthetic/recovery#7',
    '--json-file', f.reportPath, '--markdown', f.markdownPath, '--json', '--evidence-required']);
  expect(wrong.code).not.toBe(0);
  expect(f.requests.filter(request => request.path === '/v1/chat/completions')).toHaveLength(callsBeforeRefusal);
  expect(await loadConvergeAttemptState(f.common, target)).toMatchObject({ attemptsUsed: 3,
    lastLaunch: { attempt: 2, round: seedRound, status: 'completed' } });

  const reviewed = await f.command(['review', join(f.root, 'change.patch'), '--config', join(f.root, 'config.json'),
    '--converge-target', target, '--guarded-converge', '--attempt', '3',
    '--head-sha', 'b'.repeat(40), '--base-sha', 'a'.repeat(40), '--for-pr', 'synthetic/recovery#7',
    '--json-file', f.reportPath, '--markdown', f.markdownPath, '--json', '--evidence-required']);
  expect(reviewed.code, reviewed.stderr).toBe(0);
  const raw = await readFile(f.reportPath, 'utf8'), report = JSON.parse(raw);
  expect(report.run.converge).toMatchObject({ target, round: seedRound + 1, attempt: 3 });
  const ledger = (await loadConvergeAttemptState(f.common, target))!;
  expect(ledger).toMatchObject({ attemptsUsed: 3, lastLaunch: { status: 'completed', attempt: 3,
    round: seedRound + 1, runId: report.run.id, reportJsonSha256: sha(raw) } });
  expect(ledger.attempts).toHaveLength(3);
  expect(ledger.attempts.at(-1)).toMatchObject({ attempt: 3, handoff: { version: 1 } });
  expect(f.requests.filter(request => request.path === '/v1/chat/completions')).toHaveLength(callsBeforeRefusal + 2);
  const attemptEvents = f.requests.flatMap(request => request.body?.events ?? [])
    .filter(event => event.kind === 'attempt_claimed' && event.attempt === 3);
  expect(attemptEvents).toHaveLength(1);
  const admitted = await f.command(['converge-report', '--target', target, '--round', String(seedRound + 1),
    '--report', f.reportPath, '--json']);
  expect(admitted.code, admitted.stderr).toBe(0);
  expect((await loadConvergeAttemptState(f.common, target))!.attemptsUsed).toBe(3);
}, 60000);

it('actual CLI continues the recovered same target through original bytes, transport and marked native admission', async () => {
  const f = await fixture(); const before = await readFile(f.recovered.path, 'utf8');
  const original = await readFile(`${f.recovered.path}.evidence/${sha(f.recovered.reportJson)}.json`, 'utf8');
  const reviewed = await f.review(); expect(reviewed.code, reviewed.stderr).toBe(0);
  const raw = await readFile(f.reportPath, 'utf8'); const report = JSON.parse(raw);
  expect(report.run.converge.recovery_source).toEqual({ version: 1, native_sha256: sha(before) });
  expect(report.run.gating.bound_classification_protocol).toBe(1);
  expect(report.findings).toHaveLength(2); expect(report.belowThresholdFindings).toHaveLength(1);
  const all = [...report.findings, ...report.belowThresholdFindings];
  expect(all.every(finding => finding.claimDescriptor.version === 1)).toBe(true);
  const run = f.requests.find(r => r.method === 'POST' && r.path === '/api/v1/reviews/runs')!.body;
  expect(run.run.converge.recovery_source).toEqual(report.run.converge.recovery_source);
  expect(run.artifacts_declared.find((a: any) => a.kind === 'report_json').sha256).toBe(sha(raw));
  expect(f.requests.find(r => r.path.endsWith('/artifacts/report_json'))!.raw).toBe(raw);
  expect(f.requests.find(r => r.path.endsWith('/artifacts/report_md'))!.raw).toBe(await readFile(f.markdownPath, 'utf8'));
  const admitted = await f.admit(); expect(admitted.code, admitted.stderr).toBe(0);
  const afterRaw = await readFile(f.recovered.path, 'utf8'); const after = JSON.parse(afterRaw);
  const beforeState = JSON.parse(before);
  expect(after.version).toBe(3); expect(after.rounds[0]).toEqual(JSON.parse(before).rounds[0]);
  expect(after.recovery).toEqual(beforeState.recovery); expect(after.rounds).toHaveLength(beforeState.rounds.length + 1);
  const newSightings = after.sightings.slice(beforeState.sightings.length);
  expect(newSightings).toHaveLength(3);
  expect(newSightings.find((s: any) => s.category === 'correctness').canonicalIdentity).toBe(f.recovered.selection.identity);
  expect(newSightings.find((s: any) => s.category === 'security').canonicalIdentity).not.toBe(f.recovered.selection.identity);
  expect(newSightings.map((s: any) => s.findingRef)).toEqual(['f001', 'f002', 'f003']);
  const event = f.requests.flatMap(r => r.body?.events ?? []).find(e => e.kind === 'round_processed');
  expect(event.payload.classification_version).toBe(1); expect(event.payload.report_json_sha256).toBe(sha(raw));
  expect(event.payload.identities.map((i: any) => i.report_json_sha256)).toEqual([sha(raw), sha(raw), sha(raw)]);
  expect(await readFile(after.rounds.at(-1).reportBinding.sourcePath, 'utf8')).toBe(raw);
  expect(await readFile(`${f.recovered.path}.evidence/${sha(f.recovered.reportJson)}.json`, 'utf8')).toBe(original);
  const replay = await f.admit(); expect(replay.code, replay.stderr).toBe(0);
  expect(await readFile(f.recovered.path, 'utf8')).toBe(afterRaw);
  expect(f.requests.filter(r => r.path === '/v1/chat/completions')).toHaveLength(2);
}, 30000);
it('preserves a completed report and refuses changed predecessor admission after providers', async () => {
  const f = await fixture(); const before = await readFile(f.recovered.path, 'utf8');
  let changed = '';
  f.providerChange(async () => { const state = JSON.parse(before); state.updatedAt = '2026-09-24T00:00:00.000Z'; changed = JSON.stringify(state); await writeFile(f.recovered.path, changed); });
  const reviewed = await f.review(); expect(reviewed.code, reviewed.stderr).toBe(0);
  const raw = await readFile(f.reportPath, 'utf8');
  expect(JSON.parse(raw).run.converge.recovery_source.native_sha256).toBe(sha(before));
  const admitted = await f.admit(); expect(admitted.code).not.toBe(0); expect(admitted.stderr).toContain('changed during review');
  expect(await readFile(f.reportPath, 'utf8')).toBe(raw); expect(await readFile(f.recovered.path, 'utf8')).toBe(changed);
  expect(f.requests.flatMap(r => r.body?.events ?? []).filter(e => e.kind === 'round_processed')).toEqual([]);
  expect(f.requests.filter(r => r.path === '/v1/chat/completions')).toHaveLength(2);
}, 30000);
it('refuses an unavailable original before any synthetic provider call', async () => {
  const f = await fixture();
  for (const name of await readdir(`${f.recovered.path}.evidence`)) await rm(`${f.recovered.path}.evidence/${name}`);
  const before = await readFile(f.recovered.path, 'utf8');
  const result = await f.review(); expect(result.code).not.toBe(0);
  expect(f.requests.filter(r => r.path === '/v1/chat/completions')).toEqual([]);
  expect(await readFile(f.recovered.path, 'utf8')).toBe(before);
  expect(await readdir(f.root)).not.toContain('review.json');
}, 30000);

const boundClaims = ['lower','upper'].map((direction,i) => ({
  id: direction,file: 'cache.ts',startLine: 10,endLine: 12,category: 'correctness',
  severity: i===0? 'important':'critical',confidence: 0.99,title: 'Cache bound validation',
  description: `The cache bound lacks a ${direction} clamp.`,suggestedFix: 'Validate the cache bound before reading the array.',
}));
it('separates independent same-location recovered claims before actual producer consensus',async () => {
  const f=await fixture(boundClaims); const before=await readFile(f.recovered.path,'utf8');
  const reviewed=await f.review(); expect(reviewed.code,reviewed.stderr).toBe(0);
  const raw=await readFile(f.reportPath,'utf8'); const report=JSON.parse(raw);
  expect(report.stats.totalRawFindings).toBe(4);
  expect(report.stats.totalDeduped).toBe(2);
  expect(report.findings).toHaveLength(2);
  expect(new Set(report.findings.map((finding: any) => finding.claimDescriptor.invariant)).size).toBe(2);
  expect(report.findings.map((finding: any) => finding.consensus.score)).toEqual([2,2]);
  expect(report.findings.every((finding: any) => finding.consensus.models.length===2)).toBe(true);
  expect(report.reviews.flatMap((review: any) => review.findings.map((finding: any) => finding.description)).sort())
    .toEqual(boundClaims.flatMap(finding => [finding.description,finding.description]).sort());
  expect(await readFile(f.recovered.path,'utf8')).toBe(before);
  expect(report.run.converge.recovery_source.native_sha256).toBe(sha(before));
  const admitted=await f.admit(); expect(admitted.code,admitted.stderr).toBe(0);
  const findings=JSON.parse(admitted.stdout).findings;
  expect(new Set(findings.map((finding: any) => finding.identity)).size).toBe(2);
  const after=JSON.parse(await readFile(f.recovered.path,'utf8'));
  expect(after.recovery).toEqual(JSON.parse(before).recovery);
  expect(after.rounds[0]).toEqual(JSON.parse(before).rounds[0]);
},30000);
it.each(['absent','v1','standalone'] as const)('preserves ordinary legacy grouping for %s production',async mode => {
  const f=await fixture(boundClaims);
  if(mode==='v1') await writeFile(f.recovered.path,f.recovered.sourceJson);
  const reviewed=await f.review(mode==='v1'? f.recovered.plan.target:'ordinary',mode==='standalone'? f.root:undefined,false);
  expect(reviewed.code,reviewed.stderr).toBe(0);
  const report=JSON.parse(await readFile(f.reportPath,'utf8'));
  expect(report.stats.totalRawFindings).toBe(4); expect(report.stats.totalDeduped).toBe(1);
  expect(report.findings).toHaveLength(1);
  expect(report.findings[0].description).toBe(boundClaims[1]!.description);
  expect(report.findings[0].severity).toBe('critical');
  expect(report.findings[0].consensus.models).toHaveLength(2);
  expect(report.findings[0].claimDescriptor).toBeUndefined();
  expect(report.run.converge.recovery_source).toBeUndefined();
},30000);
it('refuses unsupported native v2 before contacting the actual loopback producer',async () => {
  const f=await fixture(boundClaims);
  await writeFile(f.recovered.path,JSON.stringify({ version: 2,target: f.recovered.plan.target,roundCap: 15,
    updatedAt: '2026-09-23T00:00:00.000Z',rounds: [],findings: {},sightings: [] }));
  const reviewed=await f.review(); expect(reviewed.code).not.toBe(0);
  expect(reviewed.stderr).toContain('supported recovery');
  expect(f.requests.filter(r => r.path==='/v1/chat/completions')).toEqual([]);
},30000);

it('combines a complete bounded paraphrase in the actual recovered producer while preserving both raw reports',async () => {
  const originals=await Promise.all(['claude','gpt'].map(async name => JSON.parse(await readFile(
    new URL(`../fixtures/review-${name}.json`,import.meta.url),'utf8')).findings[0]));
  const f=await fixture(model => [originals[model==='synthetic-a'?0:1]]);
  const before=await readFile(f.recovered.path,'utf8');
  const reviewed=await f.review(); expect(reviewed.code,reviewed.stderr).toBe(0);
  const report=JSON.parse(await readFile(f.reportPath,'utf8'));
  expect(report.stats.totalRawFindings).toBe(2); expect(report.stats.totalDeduped).toBe(1);
  expect(report.findings).toHaveLength(1);
  expect(report.findings[0].claimDescriptor.operation).toContain('rcl-claim-contract-v1:');
  expect(report.findings[0].consensus.score).toBe(2);
  expect(report.reviews.flatMap((review: any) => review.findings.map((finding: any) => finding.description)).sort())
    .toEqual(originals.map(finding => finding.description).sort());
  expect(await readFile(f.recovered.path,'utf8')).toBe(before);
},30000);
