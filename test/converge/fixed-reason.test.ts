import { afterEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { processRoundReport, recordVerdicts, convergeRunStatePath, loadConvergeRunState } from '../../src/converge/run-state.js';
import { sampleFinding } from '../telemetry/fixtures.js';
import type { WireEvent } from '../../src/telemetry/events.js';

const directories: string[] = [];
const cli = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'rcl-fixed-reason-')); directories.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice } });
  const gitCommonDir = join(repo, '.git'); const target = 'fixed-reason'; const runId = randomUUID();
  const first = await processRoundReport({ gitCommonDir, target, round: 1, findings: [sampleFinding()], runId: randomUUID() });
  const key = first.findings[0]!.identity;
  await recordVerdicts({ gitCommonDir, target, round: 1, verdicts: [{ key, verdict: 'dismissed', reason: 'Unrelated old dismissal' }] });
  await processRoundReport({ gitCommonDir, target, round: 2, findings: [sampleFinding()], runId });
  return { repo, gitCommonDir, target, runId, key };
}

describe('fresh fixed-verdict reasons', () => {
  it('does not attach a prior dismissal reason to a new reasonless fixed verdict', async () => {
    const f = await fixture();
    const result = await recordVerdicts({ ...f, round: 2, verdicts: [{ key: f.key, verdict: 'fixed' }] });
    expect(result.entries[0]).not.toHaveProperty('verdictReason');
    expect((await loadConvergeRunState(f.gitCommonDir, f.target))!.findings[f.key]).not.toHaveProperty('verdictReason');
  });

  it.each([undefined, 'The callback failure now has outcome=operation_failed'])('emits only the current fixed reason: %s', async reason => {
    const f = await fixture(); const events: WireEvent[] = [];
    const server = createServer(async (request, response) => {
      let text = ''; for await (const chunk of request) text += String(chunk);
      const received = (JSON.parse(text) as { events: WireEvent[] }).events; events.push(...received);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { inserted: received.length, duplicates: 0 } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(join(f.repo, '.harness-cli')); await writeFile(join(f.repo, '.harness-cli/config.json'), '{}');
      const env = { PATH: process.env.PATH, HOME: f.repo, XDG_CONFIG_HOME: join(f.repo, 'config'), RCL_DATA_DIR: join(f.repo, 'account'),
        GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice, RCL_NO_HARNESS_KEYS: '1', NODE_NO_WARNINGS: '1',
        HARNESS_API_TOKEN: 'synthetic-only', HARNESS_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
      const result = await promisify(execFile)(process.execPath, ['--import', tsx, cli, 'converge-verdict', '--target', f.target,
        '--round', '2', '--fixed', f.key, ...(reason ? ['--fixed-reason', `${f.key}=${reason}`] : []), '--json'], { cwd: f.repo, env, timeout: 15000 });
      expect(JSON.parse(result.stdout).resolution.status).toBe('fixes-pending-fresh-round');
      const verdict = events.find(event => event.kind === 'verdicts_recorded')!;
      expect(verdict).toMatchObject({ run_id: f.runId, round: 2, payload: { verdicts: [{ identity_key: f.key, verdict: 'fixed' }] } });
      const row = (verdict.payload.verdicts as Record<string, unknown>[])[0]!;
      if (reason) expect(row.reason).toBe(reason); else expect(row).not.toHaveProperty('reason');
      expect((await loadConvergeRunState(f.gitCommonDir, f.target))!.findings[f.key]!.verdictReason).toBe(reason);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }, 20000);

  it.each(['orphan', 'empty', 'duplicate', 'conflicting'] as const)('refuses %s reason arguments before changing state', async kind => {
    const f = await fixture(); const path = convergeRunStatePath(f.gitCommonDir, f.target); const before = await readFile(path);
    const args = kind === 'orphan' ? ['--fixed', f.key, '--fixed-reason', 'other=reason']
      : kind === 'empty' ? ['--fixed', f.key, '--fixed-reason', `${f.key}= `]
      : kind === 'duplicate' ? ['--fixed', f.key, '--fixed-reason', `${f.key}=one`, '--fixed-reason', `${f.key}=two`]
      : ['--fixed', f.key, '--fixed-reason', `${f.key}=one`, '--dismissed', `${f.key}=two`];
    await expect(promisify(execFile)(process.execPath, ['--import', tsx, cli, 'converge-verdict', '--target', f.target, '--round', '2', ...args, '--json'],
      { cwd: f.repo, timeout: 15000, env: { PATH: process.env.PATH, HOME: f.repo, XDG_CONFIG_HOME: join(f.repo, 'config'),
        RCL_DATA_DIR: join(f.repo, 'account'), RCL_NO_HARNESS_KEYS: '1', NODE_NO_WARNINGS: '1' } })).rejects.toMatchObject({ code: 3 });
    expect(await readFile(path)).toEqual(before);
  }, 20000);
});
