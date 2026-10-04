import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { releasedLoopbackCycleFixture } from '../fixtures/parent123-cycle.js';
import { sha, uuid } from '../evidence/recovery-validation/fixtures.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { correctionAnchor } from '../../src/converge/correction-anchors.js';
import { deriveNativeRecovery, applyNativeRecovery, effectivePendingIdentities } from '../../src/converge/recovery-state.js';
import { loadConvergeRunState, recordVerdicts } from '../../src/converge/run-state.js';
import { withRecoveryTarget } from '../../src/converge/target-ownership.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';

const exec = promisify(execFile);
const entry = process.env.RCL_TEST_PACKAGED_CLI ?? fileURLToPath(new URL('../../dist/index.js', import.meta.url));

it('actual CLI preserves recovery, cycle, artifact and attempt bindings through same-cycle admission', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl123-cycle-cli-')));
  const common = join(root, '.git');
  const requests: Array<{ method: string; path: string; raw: string; body: any }> = [];
  let cycle: any;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = new URL(req.url!, 'http://127.0.0.1').pathname;
      const body = raw && !path.includes('/artifacts/') ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method!, path, raw, body });
      let result: unknown;
      if (path === '/v1/chat/completions') {
        result = { id: 'synthetic-completion', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify({ findings: [{ id: 'tenant', file: 'cache.ts', startLine: 1,
            endLine: 1, category: 'security', severity: 'important', confidence: 0.99, title: 'Foreign tenant data disclosure',
            description: 'Authorization accepts a foreign account before validating tenant ownership.',
            suggestedFix: 'Check tenant membership before authorizing the account.' }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
      } else if (path === '/api/v1/reviews/prs/allocator-one/rcl/42' && req.method === 'GET') {
        result = { data: { repo: 'allocator-one/rcl', pr_number: 42, head: { sha: '9'.repeat(40), merged: false },
          cycle_protocol: 1, active_cycle: { id: cycle.id, operation_id: cycle.operationId,
            previous_cycle_id: cycle.previousCycleId, head_sha: '9'.repeat(40), inserted_at: '2026-09-27T00:00:00.000Z' } } };
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
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), RCL_DATA_DIR: join(root, 'data'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', RCL_NO_HARNESS_KEYS: '1', HARNESS_API_URL: baseUrl,
    HARNESS_API_TOKEN: 'synthetic-only', OPENAI_COMPAT_BASE_URL: `${baseUrl}/v1`, OPENAI_COMPAT_API_KEY: 'local',
    NO_COLOR: '1', FORCE_COLOR: '0', RCL_RUNNER: 'human', RCL_CONVERGE_ROUND: '13', RCL_CONVERGE_ATTEMPT: '17' };
  try {
    await exec('git', ['init', '-q'], { cwd: root, env });
    await exec('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root, env });
    await mkdir(join(common, 'rcl-converge-runs'), { mode: 0o700 });
    await mkdir(join(root, '.harness-cli')); await writeFile(join(root, '.harness-cli/config.json'), '{}');
    const f = await releasedLoopbackCycleFixture(common, baseUrl);
    cycle = f.native.cycle;
    const sourceJson = await readFile(f.runPath, 'utf8');
    const rows = f.selection.sourceReceipts[0]!.payload.identities as Array<{ matched_identity: string }>;
    const selection = { ...f.selection, findingRef: 'f002', previousIdentity: rows[1]!.matched_identity };
    const operationId = uuid(850), event = prepareClaimSplit(selection).event;
    const anchor = correctionAnchor(selection, { ...selection.scope, ...event, actor_user_id: uuid(7), attempt: null }, uuid(7), operationId);
    const plan = deriveNativeRecovery({ sourceJson, target: selection.target, operationId, anchors: [anchor],
      reports: [selection.reportJson], sourceReceipts: selection.sourceReceipts });
    await withRecoveryTarget(common, plan.target, ownership => applyNativeRecovery({ gitCommonDir: common, plan, ownership }));
    const recovered = (await loadConvergeRunState(common, plan.target))!;
    await recordVerdicts({ gitCommonDir: common, target: plan.target, round: 1, runId: JSON.parse(selection.reportJson).run.id,
      verdicts: effectivePendingIdentities(recovered).map(key => ({ key, verdict: 'dismissed' as const,
        reason: 'Synthetic fixture explicitly completes each retained independent obligation.' })) });
    const before = await readFile(f.runPath, 'utf8'), beforeAttempts = await readFile(f.attemptPath, 'utf8');
    const patch = join(root, 'change.patch'), config = join(root, 'review.config.json');
    await writeFile(patch, 'diff --git a/cache.ts b/cache.ts\n--- a/cache.ts\n+++ b/cache.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n');
    await writeFile(config, JSON.stringify({ models: ['openai-compat/synthetic-a', 'openai-compat/synthetic-b'], roles: ['general'],
      secondaryModels: [], asyncModels: [], gating: { mode: 'all-findings' }, harness: { telemetry: 'full' },
      maxRetries: 0, timeout: 2000, concurrency: 2 }));
    const shim = join(root, 'network.mjs');
    await writeFile(shim, `const original = globalThis.fetch; globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.origin !== ${JSON.stringify(baseUrl)}) throw new Error('Unexpected external fixture request: ' + url.origin);
      return original(input, options);
    };`);
    const command = async (args: string[]) => {
      try { return { code: 0, ...await exec(process.execPath, ['--import', shim, entry, ...args], { cwd: root, env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }) }; }
      catch (error) { const e = error as { code: number; stdout: string; stderr: string }; return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
    };
    const reportPath = join(root, 'review.json'), markdownPath = join(root, 'review.md');
    const claimed = await command(['converge-attempt', '--target', plan.target, '--json']);
    expect(claimed.code, claimed.stderr).toBe(0);
    expect(JSON.parse(claimed.stdout)).toMatchObject({ target: plan.target, attempt: 2, attemptsUsed: 2 });
    const reviewed = await command(['review', patch, '--config', config, '--converge-target', plan.target,
      '--guarded-converge', '--attempt', '2',
      '--head-sha', '9'.repeat(40), '--base-sha', 'a'.repeat(40), '--for-pr', 'allocator-one/rcl#42',
      '--json-file', reportPath, '--markdown', markdownPath, '--json']);
    expect(reviewed.code, reviewed.stderr).toBe(0);
    const raw = await readFile(reportPath, 'utf8'), report = JSON.parse(raw);
    expect(report.run).toMatchObject({ cycle_id: cycle.id, converge: { target: plan.target, round: 2, attempt: 2,
      recovery_source: { version: 1, native_sha256: sha(before) } }, gating: { bound_classification_protocol: 1 } });
    expect(report.run.converge).not.toHaveProperty('cycleId');
    expect(report.findings).toHaveLength(1); expect(report.findings[0].claimDescriptor.version).toBe(1);
    expect(await readFile(f.runPath, 'utf8')).toBe(before);
    const ledger = (await loadConvergeAttemptState(common, plan.target))!;
    expect(ledger).toMatchObject({ attemptsUsed: 2, cap: 20, cycle, lastLaunch: {
      status: 'completed', attempt: 2, round: 2, runId: report.run.id, reportJsonSha256: sha(raw) } });
    expect(ledger.attempts.slice(0, 1)).toEqual(JSON.parse(beforeAttempts).attempts);
    const envelope = requests.find(r => r.path === '/api/v1/reviews/runs' && r.method === 'POST')!.body;
    expect(envelope.run.cycle_id).toBe(cycle.id);
    expect(envelope.run.converge.recovery_source).toEqual(report.run.converge.recovery_source);
    expect(envelope.run.gating.bound_classification_protocol).toBe(1);
    expect(envelope.artifacts_declared.find((a: any) => a.kind === 'report_json').sha256).toBe(sha(raw));
    expect(requests.find(r => r.path.endsWith('/artifacts/report_json'))!.raw).toBe(raw);
    expect(requests.flatMap(r => r.body?.events ?? []).filter(e => e.kind === 'attempt_claimed'))
      .toEqual([expect.objectContaining({ converge_target: plan.target, attempt: 2, payload: { attempt: 2, cap: 20, cycle_id: cycle.id } })]);
    const wrongPath = join(root, 'wrong-cycle.json');
    await writeFile(wrongPath, JSON.stringify({ ...report, run: { ...report.run, cycle_id: uuid(899) } }));
    const admit = (path: string) => command(['converge-report', '--target', plan.target, '--round', '2', '--report', path, '--json']);
    const refused = await admit(wrongPath);
    expect(refused.code).not.toBe(0); expect(refused.stderr).toContain('review_cycle_mismatch');
    expect(await readFile(f.runPath, 'utf8')).toBe(before);
    expect(requests.flatMap(r => r.body?.events ?? []).filter(e => e.kind === 'round_processed')).toEqual([]);
    const admitted = await admit(reportPath); expect(admitted.code, admitted.stderr).toBe(0);
    const state = (await loadConvergeRunState(common, plan.target))!;
    expect(state.rounds).toHaveLength(2); expect(state.rounds[0]).toEqual(JSON.parse(before).rounds[0]);
    expect(state.rounds[1]!.reportBinding!.reportSha256).toBe(sha(raw));
    expect(state.cycle).toEqual(cycle); expect(state.recovery).toEqual(JSON.parse(before).recovery);
    expect(await readFile(f.archivePath, 'utf8')).toBe(f.archiveJson);
    expect(await loadConvergeAttemptState(common, plan.target)).toEqual(ledger);
    const admittedEvent = requests.flatMap(r => r.body?.events ?? []).find(e => e.kind === 'round_processed');
    expect(admittedEvent).toMatchObject({ run_id: report.run.id, round: 2, payload: { classification_version: 1,
      report_json_sha256: sha(raw), identities: [expect.objectContaining({ finding_ref: 'f001', report_json_sha256: sha(raw) })] } });
    expect(requests.filter(r => r.path === '/v1/chat/completions')).toHaveLength(2);
    expect(requests.filter(r => r.path.endsWith('/cycles') && r.method === 'POST')).toEqual([]);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
