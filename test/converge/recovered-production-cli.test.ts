import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { installRecoveredProduction } from '../fixtures/recovered-production.js';
import { sha } from '../evidence/recovery-validation/fixtures.js';
const roots: string[] = [];
const servers: Server[] = [];
const exec = promisify(execFile);
const entry = process.env.RCL_TEST_PACKAGED_CLI ?? fileURLToPath(new URL('../../dist/index.js', import.meta.url));
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rcl-recovered-cli-')); roots.push(root);
  const repo = join(root, 'repo'); await mkdir(repo);
  const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  await exec('git', ['init', '-q'], { cwd: repo, env: gitEnv });
  await exec('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: repo, env: gitEnv });
  await mkdir(join(repo, '.harness-cli')); await writeFile(join(repo, '.harness-cli', 'config.json'), '{}');
  const common = join(repo, '.git'); const recovered = await installRecoveredProduction(common);
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
        const findings = [
          { id: 'expiry', file: 'cache.ts', startLine: 10, endLine: 12, category: 'correctness', severity: 'important', confidence: 0.99,
            title: 'Expired cache entries', description: recovered.selection.descriptor.invariant,
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
  async function command(args: string[]) {
    try { const out = await exec(process.execPath, [entry, ...args], { cwd: repo, env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }); return { code: 0, ...out }; }
    catch (error) { const e = error as Error & { code: number; stdout: string; stderr: string }; return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
  }
  return { root, common, recovered, requests, reportPath, markdownPath, command,
    providerChange: (change: () => Promise<void>) => { onProvider = change; },
    review: () => command(['review', patch, '--config', config, '--converge-target', recovered.plan.target, '--round', '2', '--attempt', '6',
      '--head-sha', 'b'.repeat(40), '--base-sha', 'a'.repeat(40), '--for-pr', 'synthetic/recovery#7',
      '--json-file', reportPath, '--markdown', markdownPath, '--json', '--evidence-required']),
    admit: () => command(['converge-report', '--target', recovered.plan.target, '--round', '2', '--report', reportPath, '--json']),
  };
}
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
  expect(after.version).toBe(3); expect(after.rounds[0]).toEqual(JSON.parse(before).rounds[0]);
  expect(after.recovery).toEqual(JSON.parse(before).recovery); expect(after.rounds).toHaveLength(2);
  expect(after.sightings).toHaveLength(3);
  expect(after.sightings.find((s: any) => s.category === 'correctness').canonicalIdentity).toBe(f.recovered.selection.identity);
  expect(after.sightings.find((s: any) => s.category === 'security').canonicalIdentity).not.toBe(f.recovered.selection.identity);
  expect(after.sightings.map((s: any) => s.findingRef)).toEqual(['f001', 'f002', 'f003']);
  const event = f.requests.flatMap(r => r.body?.events ?? []).find(e => e.kind === 'round_processed');
  expect(event.payload.classification_version).toBe(1); expect(event.payload.report_json_sha256).toBe(sha(raw));
  expect(event.payload.identities.map((i: any) => i.report_json_sha256)).toEqual([sha(raw), sha(raw), sha(raw)]);
  expect(await readFile(after.rounds[1].reportBinding.sourcePath, 'utf8')).toBe(raw);
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
  const f = await fixture(); await rm(`${f.recovered.path}.evidence/${sha(f.recovered.reportJson)}.json`);
  const before = await readFile(f.recovered.path, 'utf8');
  const result = await f.review(); expect(result.code).not.toBe(0);
  expect(f.requests.filter(r => r.path === '/v1/chat/completions')).toEqual([]);
  expect(await readFile(f.recovered.path, 'utf8')).toBe(before);
  expect(await readdir(f.root)).not.toContain('review.json');
}, 30000);
