import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { processRoundReport } from '../../src/converge/run-state.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { withRecoveryTarget } from '../../src/converge/target-ownership.js';
import { sampleFinding, sampleResult } from '../telemetry/fixtures.js';

const exec = promisify(execFile);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

it.each([['report', 201], ['verdict', 201], ['attempt', 201], ['attempt', 503]] as const)
('holds recovery outside CLI %s publication until HTTP %i settles', async (kind, status) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-native-publication-')));
  const requestArrived = deferred(), releaseResponse = deferred();
  const target = 'synthetic-publication';
  const published: Array<{ kind: string }> = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += String(part);
    if (request.method === 'POST') {
      const body = JSON.parse(raw); published.push(...body.events); requestArrived.resolve(); await releaseResponse.promise;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status === 201 ? { data: { inserted: body.events.length, duplicates: 0 } } : { error: 'synthetic_unavailable' }));
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [], meta: { evidence_protocol_version: 2, bound_classification_protocol: 1 } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const env: NodeJS.ProcessEnv = { HOME: process.env.HOME, PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    XDG_CONFIG_HOME: join(root, 'config'), RCL_DATA_DIR: join(root, 'data'), RCL_NO_HARNESS_KEYS: '1', NODE_NO_WARNINGS: '1',
    HARNESS_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, HARNESS_API_TOKEN: 'synthetic-only' };
  let cli: ReturnType<typeof exec> | undefined, recovery: Promise<void> | undefined;
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, env });
    await mkdir(join(root, '.harness-cli'));
    await writeFile(join(root, '.harness-cli/config.json'), '{}');
    await writeFile(join(root, '.review-council.json'), JSON.stringify({ harness: { telemetry: 'envelope' } }));
    const report = sampleResult({ findings: [sampleFinding()], belowThresholdFindings: [] });
    report.run!.converge = { target, round: 1 };
    const raw = JSON.stringify(report), reportPath = join(root, 'report.json');
    await writeFile(reportPath, raw);
    let args: string[];
    if (kind === 'attempt') args = ['converge-attempt', '--target', target, '--max-attempts', '7', '--json'];
    else if (kind === 'report') args = ['converge-report', '--target', target, '--round', '1', '--report', reportPath, '--json'];
    else {
      const admitted = await processRoundReport({ gitCommonDir: join(root, '.git'), target, round: 1,
        findings: report.findings, runId: report.run!.id });
      args = ['converge-verdict', '--target', target, '--round', '1', '--dismissed', `${admitted.findings[0]!.identity}=synthetic guard`, '--json'];
    }
    cli = exec(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../../src/index.ts', import.meta.url)), ...args],
      { cwd: root, env, timeout: 10_000 });
    await Promise.race([requestArrived.promise, cli.then(() => { throw new Error('no_publication_attempt'); })]);
    let entered = false;
    recovery = withRecoveryTarget(join(root, '.git'), target, async () => { entered = true; });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(entered).toBe(false);
    expect(await readFile(reportPath, 'utf8')).toBe(raw);
    if (kind === 'attempt') {
      expect(published.map(event => event.kind)).toEqual(['attempt_claimed', 'cap_changed']);
      expect(await loadConvergeAttemptState(join(root, '.git'), target)).toMatchObject({ attemptsUsed: 1, cap: 7 });
    }
  } finally {
    releaseResponse.resolve();
    const settled = await Promise.allSettled([...(cli ? [cli] : []), ...(recovery ? [recovery] : [])]);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
  }
}, 15_000);
