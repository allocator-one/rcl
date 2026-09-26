import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  asyncTargetKey,
  collectAsyncResults,
  resolveAsyncStoreDir,
  runAsyncWorker,
  spoolAsyncCalls,
} from '../src/dispatch/async-lane.js';
import type { ReviewAdapter } from '../src/dispatch/adapter.js';
import { Quarantine } from '../src/telemetry/quarantine.js';
import { buildRunEnvelope } from '../src/telemetry/envelope.js';
import { sampleResult } from './telemetry/fixtures.js';
import type { Attestation } from '../src/telemetry/attest.js';
import { loadConvergeAttemptState } from '../src/converge/attempt-budget.js';
import { loadConvergeRunState, processRoundReport } from '../src/converge/run-state.js';
import { sha256Hex } from '../src/report/run-header.js';
import { CheckpointJournal, checkpointPath } from '../src/dispatch/checkpoint.js';

// Global setup builds dist unless an installed package entrypoint is selected.
const cliEntrypoint = process.env['RCL_TEST_PACKAGED_CLI'] || process.env['RCL_TEST_REVIEW_ENTRYPOINT'] || fileURLToPath(new URL('../dist/index.js', import.meta.url));
// Keep explicit TypeScript development overrides without loading tsx for built CLI runs.
const cliNodeArgs = /\.(?:[cm]?ts|tsx)$/.test(cliEntrypoint)
  ? ['--import', import.meta.resolve('tsx'), cliEntrypoint]
  : [cliEntrypoint];
const tempDirs: string[] = [];
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice };

function tempRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rcl-review-cli-'));
  tempDirs.push(directory);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, env: GIT_ENV });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(directory, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  return directory;
}

function runRcl(args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [...cliNodeArgs, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      NODE_NO_WARNINGS: '1',
      // Never reach a provider or Harness from this test, and never look like
      // a GitHub Actions job with id-token: write (the suite may run in one).
      RCL_NO_HARNESS_KEYS: '1',
      ACTIONS_ID_TOKEN_REQUEST_URL: '',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
      ANTHROPIC_API_KEY: '',
      // spawn omits undefined values. The SDK rejects a missing key before
      // any request, but accepts an empty string and attempts a connection.
      OPENAI_API_KEY: undefined,
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      OPENROUTER_API_KEY: '',
    },
    timeout: 30_000,
  });
}

function runRclAsync(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
  timeoutMs = 30_000,
  onSpawn?: (child: ChildProcess) => void
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...cliNodeArgs, ...args], {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
        NODE_NO_WARNINGS: '1',
        RCL_NO_HARNESS_KEYS: '1',
        ACTIONS_ID_TOKEN_REQUEST_URL: '',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        GEMINI_API_KEY: '',
        GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timeoutHandle = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`rcl did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timeoutHandle);
      resolve({ status, stdout, stderr });
    });
  });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface GuardedCliFixture {
  repo: string;
  args: string[];
  env: Record<string, string>;
  calls: () => number;
  requests: () => number;
  failCall: (call: number) => void;
  holdCall: (call: number) => void;
  delayCapability: (ms: number) => void;
  responseForCall: (makeContent: (call: number) => string) => void;
  holdResponses: () => void;
  releaseResponses: () => void;
  firstRequest: Promise<void>;
  retainedArgs: () => string[];
  privateRuns: Map<string, { envelope: any; ordinary: Map<string, string>; privateBytes?: string }>;
  capability: (supported: boolean) => void;
  protectedEnv: Record<string, string>;
  minted: Map<string, Attestation>;
  privateUnreadable: (value: boolean) => void;
}

async function withGuardedFixture(work: (fixture: GuardedCliFixture) => Promise<void>): Promise<void> {
  const repo = tempRepository();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'change.patch'), 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
  writeFileSync(join(repo, 'config.json'), JSON.stringify({
    models: ['openai-compat/fixture'], secondaryModels: [], asyncModels: [],
    roles: ['general', 'security-auditor'], harness: { telemetry: 'off' },
  }));
  let calls = 0, requests = 0;
  let failingCall: number | undefined, heldCall: number | undefined, capabilityDelay = 0;
  let responseForCall = (_call: number): string => JSON.stringify({ findings: [] });
  let holdResponses = false;
  const pendingResponses: Array<() => void> = [];
  let notifyRequest: () => void = () => {};
  const firstRequest = new Promise<void>(resolve => { notifyRequest = resolve; });
  const privateRuns = new Map<string, { envelope: any; ordinary: Map<string, string>; privateBytes?: string }>();
  let privateSupported = true, privateUnreadable = false;
  const minted = new Map<string, Attestation>();
  const protectedHost = 'https://harness.example.test';
  const server = createServer(async (request, response) => {
    requests++;
    if (request.url?.startsWith('/synthetic-oidc')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ value: 'synthetic.jwt' })); return; }
    if (request.url?.startsWith('/fake-github/')) {
      response.setHeader('content-type', 'application/json');
      if (request.url.includes('/compare/')) { response.end(JSON.stringify({ merge_base_commit: { sha: head }, files: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b\n' }] })); return; }
      response.end(JSON.stringify({ number: 105, title: 'Synthetic PR', body: '', user: { login: 'fixture' },
        base: { ref: 'main', sha: head }, head: { ref: 'candidate', sha: head }, changed_files: 1,
        html_url: 'https://github.com/allocator-one/rcl/pull/105', labels: [], draft: false })); return;
    }
    if (request.url?.startsWith('/api/v1/reviews')) {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks).toString('utf8');
      const answer = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.url.endsWith('/attest')) {
        if (request.headers.authorization !== 'Bearer synthetic.jwt') return answer(403, { error: 'forbidden' });
        const body = JSON.parse(bytes);
        if (privateRuns.has(body.run_id)) return answer(409, { error: 'run_exists' });
        const source = body.reviewer_recovery?.source;
        if (source && (!privateRuns.get(source.run_id)?.privateBytes || sha256Hex(privateRuns.get(source.run_id)!.privateBytes!) !== source.reviewer_artifact_sha256)) return answer(403, { error: 'source_unavailable' });
        const session: Attestation = { credential: { url: protectedHost, token: `rbc_${body.run_id}`, source: 'attest' },
          runId: body.run_id, audience: protectedHost, expiresAt: new Date(Date.now() + 60000).toISOString(),
          ...(body.reviewer_recovery ? { reviewerRecovery: body.reviewer_recovery } : {}) };
        minted.set(body.run_id, session);
        return answer(201, { data: { credential: session.credential.token, run_id: body.run_id, expires_at: session.expiresAt } });
      }
      const protectedSession = [...minted.values()].find(session => `Bearer ${session.credential.token}` === request.headers.authorization);
      if (!protectedSession && request.headers.authorization !== 'Bearer synthetic-owner') return answer(403, { error: 'forbidden' });
      if (request.url.endsWith('/model-stats') && capabilityDelay) { const delay = capabilityDelay; capabilityDelay = 0; await new Promise(resolve => setTimeout(resolve, delay)); }
      if (request.url.endsWith('/model-stats')) return answer(200, { data: { models: [] }, meta: privateSupported ? { reviewer_recovery_protocol: 1, reviewer_artifact_schema: 1, reviewer_artifact_max_bytes: 25000000 } : {} });
      if (request.url.includes('?page_size=')) return answer(200, { data: [], meta: { location_provenance: true } });
      if (request.method === 'POST' && request.url.endsWith('/runs')) {
        const envelope = JSON.parse(bytes), existing = privateRuns.get(envelope.run.id);
        if (protectedSession && envelope.run.id !== protectedSession.runId) return answer(403, { error: 'forbidden' });
        if (existing && JSON.stringify(existing.envelope) !== bytes) return answer(409, { error: 'conflict' });
        privateRuns.set(envelope.run.id, existing ?? { envelope, ordinary: new Map() });
        return answer(existing ? 200 : 201, { data: { id: envelope.run.id, url: 'http://localhost/run', artifacts_expected: envelope.artifacts_declared.map((row: any) => row.kind) }, meta: { status: existing ? 'existing' : 'created' } });
      }
      const match = /^\/api\/v1\/reviews\/runs\/([^/]+)(?:\/(.*))?$/.exec(request.url);
      const run = match && privateRuns.get(match[1]!); if (!run) return answer(404, { error: 'not_found' });
      const resource = match![2];
      if (protectedSession && !(match![1] === protectedSession.runId || request.method === 'GET' && resource === 'reviewer-artifact' && match![1] === protectedSession.reviewerRecovery?.source.run_id)) return answer(403, { error: 'forbidden' });
      if (!resource) return answer(200, { data: { id: match![1], url: `${protectedHost}/api/v1/reviews/runs/${match![1]}`,
        envelope_sha256: sha256Hex(JSON.stringify(run.envelope)), artifacts_declared: run.envelope.artifacts_declared,
        artifacts_expected: run.envelope.artifacts_declared.map((row: any) => row.kind) }, meta: { status: 'existing' } });
      if (resource === 'reviewer-artifact') {
        const declaration = run.envelope.reviewer_recovery;
        if (request.method === 'PUT') {
          const wire = JSON.parse(bytes);
          if (run.ordinary.get('report_json') !== wire.report.bytes) return answer(503, { error: 'source_unavailable' });
          expect(sha256Hex(bytes)).toBe(declaration.sha256); expect(Buffer.byteLength(bytes)).toBe(declaration.bytes);
          run.privateBytes = bytes;
          return answer(201, { data: { run_id: match![1], sha256: declaration.sha256, bytes: declaration.bytes }, meta: { status: 'created' } });
        }
        if (!run.privateBytes) return answer(404, { error: 'reviewer_artifact_pending', data: { run_id: match![1], sha256: declaration.sha256, bytes: declaration.bytes } });
        if (privateUnreadable) return answer(503, { error: 'source_unavailable' });
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-artifact-sha256': sha256Hex(run.privateBytes), 'cache-control': 'private, no-store', 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff' }); response.end(run.privateBytes); return;
      }
      const kind = resource?.replace('artifacts/', '');
      if (!kind) return answer(404, { error: 'not_found' });
      if (protectedSession && request.method !== 'PUT') return answer(403, { error: 'forbidden' });
      if (request.method === 'PUT') { run.ordinary.set(kind, bytes); return answer(201, { data: { kind, sha256: sha256Hex(bytes) } }); }
      const raw = run.ordinary.get(kind); if (raw === undefined) return answer(404, { error: 'not_found' });
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-artifact-sha256': sha256Hex(raw) }); response.end(raw); return;
    }
    request.resume();
    calls++;
    notifyRequest();
    const call = calls;
    const respond = () => {
      if (call === failingCall) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Fixture rejected credential', type: 'authentication_error' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture',
        choices: [{ index: 0, finish_reason: 'stop', message: {
          role: 'assistant', content: responseForCall(call),
        } }],
      }));
    };
    if (holdResponses || call === heldCall) pendingResponses.push(respond);
    else respond();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const preload = join(repo, 'synthetic-workflow.mjs');
  writeFileSync(preload, `const original = globalThis.fetch;
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://actions.example.test/synthetic-oidc';
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'synthetic-request';
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.hostname === 'harness.example.test' || url.hostname === 'actions.example.test') return original('http://127.0.0.1:${port}' + url.pathname + url.search, init);
      if (url.hostname === 'api.github.com') return original('http://127.0.0.1:${port}/fake-github' + url.pathname + url.search, init);
      if (url.hostname === '127.0.0.1') return original(input, init);
      throw new Error('unapproved test network');
    };`);

  try {
    await work({
      repo,
      args: ['review', 'change.patch', '--guarded-converge', '--converge-target', 'guarded-fixture',
        '--head-sha', head, '--base-sha', head, '--json-file', 'report.json',
        '--config', 'config.json', '--no-telemetry'],
      env: { OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${port}/v1`,
        OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, HARNESS_API_URL: `http://127.0.0.1:${port}`, HARNESS_API_TOKEN: 'synthetic-owner', RCL_TELEMETRY: '', RCL_DATA_DIR: join(repo, 'rcl-data') },
      calls: () => calls, requests: () => requests,
      failCall: call => { failingCall = call; },
      holdCall: call => { heldCall = call; }, delayCapability: ms => { capabilityDelay = ms; },
      responseForCall: makeContent => { responseForCall = makeContent; },
      holdResponses: () => { holdResponses = true; },
      releaseResponses: () => {
        holdResponses = false;
        for (const respond of pendingResponses.splice(0)) respond();
      },
      firstRequest, privateRuns, minted, privateUnreadable: value => { privateUnreadable = value; },
      protectedEnv: { GITHUB_TOKEN: 'synthetic-github', GH_TOKEN: 'synthetic-github', NODE_OPTIONS: `--import=${preload}`, HARNESS_API_URL: protectedHost }, capability: supported => { privateSupported = supported; },
      retainedArgs: () => {
        const config = JSON.parse(readFileSync(join(repo, 'config.json'), 'utf8')); config.harness.telemetry = 'full';
        writeFileSync(join(repo, 'config.json'), JSON.stringify(config)); mkdirSync(join(repo, '.harness-cli'), { recursive: true });
        writeFileSync(join(repo, '.harness-cli/config.json'), JSON.stringify({ team: 'RCL' }));
        return ['review', 'change.patch', '--guarded-converge', '--converge-target', 'guarded-fixture', '--head-sha', head, '--base-sha', head, '--json-file', 'report.json', '--config', 'config.json'];
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('rcl review — guarded native launch', () => {
  it('finalizes an expired saved successor locally after process loss with zero network or new intents', async () => {
    await withGuardedFixture(async fixture => {
      const args = fixture.retainedArgs(), config = JSON.parse(readFileSync(join(fixture.repo, 'config.json'), 'utf8'));
      config.maxRetries = 0; writeFileSync(join(fixture.repo, 'config.json'), JSON.stringify(config));
      fixture.responseForCall(call => call === 1 ? 'unparseable' : '{"findings":[]}');
      const original = await runRclAsync([...args, '--retain-reviewers', '--for-pr', 'allocator-one/rcl#105'], fixture.repo, fixture.env);
      expect(original.status, original.stderr).toBe(0);
      const source = JSON.parse(readFileSync(join(fixture.repo, 'report.json'), 'utf8')), head = source.run.target.head_sha;
      fixture.holdCall(3); let child: ChildProcess | undefined;
      const running = runRclAsync(['reviewers', 'apply', 'guarded-fixture', '--run', source.run.id, '--review-target', 'change.patch',
        '--head-sha', head, '--base-sha', head, '--for-pr', 'allocator-one/rcl#105', '--config', 'config.json',
        '--max-additional-calls', '1', '--max-attempts-per-cell', '2', '--time-budget-ms', '2500'], fixture.repo, fixture.env, 10000, process => { child = process; });
      for (let i = 0; fixture.calls() < 3 && i < 150; i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(fixture.calls()).toBe(3); child!.kill('SIGKILL'); await running;
      const commonDir = realpathSync(join(fixture.repo, '.git')), launch = (await loadConvergeRunState(commonDir, 'guarded-fixture'))!.lastLaunch!;
      const journal = await CheckpointJournal.inspectRead(checkpointPath(commonDir, 'guarded-fixture', launch.runId!));
      const operation = JSON.parse((await journal.readBindings()).operation!), before = JSON.stringify((await journal.read()).records.filter(record => record.type === 'intent'));
      const localArgs = ['reviewers', 'resume', 'guarded-fixture', '--run', launch.runId!, '--local-only', '--json-file', 'local.json'];
      const requests = fixture.requests();
      const live = await runRclAsync(localArgs, fixture.repo, { ...fixture.env, HARNESS_API_URL: '', HARNESS_API_TOKEN: '' });
      expect(live.status).toBe(1); expect(live.stderr).toContain('local_only_operation_live');
      await new Promise(resolve => setTimeout(resolve, Math.max(0, operation.expiresAtMs - Date.now() + 30)));
      const local = await runRclAsync(localArgs, fixture.repo, { ...fixture.env, HARNESS_API_URL: '', HARNESS_API_TOKEN: '' });
      expect(local.status, local.stderr).toBe(4); expect(local.stderr).toContain('Local terminal');
      expect(fixture.requests()).toBe(requests); expect(fixture.calls()).toBe(3);
      const terminal = (await journal.readTerminalReport())!;
      expect(terminal.reportBytes).toBe(readFileSync(join(fixture.repo, 'local.json'), 'utf8'));
      expect(JSON.stringify((await journal.read()).records.filter(record => record.type === 'intent'))).toBe(before);
      expect((await journal.readVerification())?.intents ?? []).toEqual([]);
      expect(await loadConvergeAttemptState(commonDir, 'guarded-fixture')).toMatchObject({ attemptsUsed: 2 });
      const replay = await runRclAsync(localArgs.slice(0, -2), fixture.repo, { ...fixture.env, HARNESS_API_URL: '', HARNESS_API_TOKEN: '' });
      expect(replay.status, replay.stderr).toBe(4); expect((await journal.readTerminalReport())!.reportBytes).toBe(terminal.reportBytes);
      expect(fixture.requests()).toBe(requests);
    });
  }, 40000);

  it('runs a protected retained original and signed-parent successor through the real CLI with owned native counters', async () => {
    await withGuardedFixture(async fixture => {
      fixture.retainedArgs();
      const config = JSON.parse(readFileSync(join(fixture.repo, 'config.json'), 'utf8')); config.maxRetries = 0;
      writeFileSync(join(fixture.repo, 'config.json'), JSON.stringify(config));
      fixture.responseForCall(call => call === 1 ? 'unparseable' : '{"findings":[]}');
      const env = { ...fixture.env, ...fixture.protectedEnv };
      const incompatible = await runRclAsync(['review', 'allocator-one/rcl#105', '--retain-reviewers', '--attest', '--guarded-converge', '--converge-target', 'guarded-fixture'], fixture.repo, env);
      expect(incompatible.status).toBe(1); expect(incompatible.stderr).toContain('incompatible_launch');
      expect(fixture.minted.size).toBe(0); expect(fixture.calls()).toBe(0);
      const original = await runRclAsync(['review', 'allocator-one/rcl#105', '--retain-reviewers', '--attest', '--converge-target', 'guarded-fixture',
        '--config', 'config.json', '--json-file', 'protected.json'], fixture.repo, env);
      expect(original.status, original.stderr).toBe(0); expect(fixture.calls()).toBe(2);
      const source = JSON.parse(readFileSync(join(fixture.repo, 'protected.json'), 'utf8'));
      const applied = await runRclAsync(['reviewers', 'apply', 'guarded-fixture', '--run', source.run.id,
        '--review-target', 'allocator-one/rcl#105', '--config', 'config.json', '--attest', '--max-additional-calls', '1',
        '--max-attempts-per-cell', '2', '--time-budget-ms', '30000', '--json-file', 'protected-successor.json'], fixture.repo, env);
      expect(applied.status, applied.stderr).toBe(0); expect(fixture.calls()).toBe(3);
      const successor = JSON.parse(readFileSync(join(fixture.repo, 'protected-successor.json'), 'utf8'));
      expect(successor.run.converge).toMatchObject({ attempt: 2, round: 1 });
      expect(fixture.minted.get(successor.run.id)!.reviewerRecovery!.source.run_id).toBe(source.run.id);
      expect(fixture.privateRuns.get(successor.run.id)!.envelope.calls).toEqual([]);
      const before = fixture.minted.size;
      const refused = await runRclAsync(['reviewers', 'resume', 'guarded-fixture', '--run', successor.run.id,
        '--review-target', 'allocator-one/rcl#105', '--config', 'config.json', '--attest'], fixture.repo, env);
      expect(refused.status).toBe(1); expect(refused.stderr).toContain('same_live_session');
      expect(fixture.minted.size).toBe(before); expect(fixture.calls()).toBe(3);
    });
  }, 40000);

  it('reopens protected lost-ACK bytes with an externally held same live session and refuses missing session transfer', async () => {
    await withGuardedFixture(async fixture => {
      fixture.retainedArgs(); fixture.privateUnreadable(true);
      const env = { ...fixture.env, ...fixture.protectedEnv };
      const original = await runRclAsync(['review', 'allocator-one/rcl#105', '--retain-reviewers', '--attest', '--converge-target', 'guarded-fixture',
        '--config', 'config.json', '--json-file', 'protected.json'], fixture.repo, env);
      expect(original.status, original.stderr).toBe(4); expect(fixture.calls()).toBe(2);
      const report = JSON.parse(readFileSync(join(fixture.repo, 'protected.json'), 'utf8'));
      const bytes = fixture.privateRuns.get(report.run.id)!.privateBytes, session = fixture.minted.get(report.run.id)!;
      fixture.privateUnreadable(false);
      const resumed = await runRclAsync(['reviewers', 'resume', 'guarded-fixture', '--run', report.run.id,
        '--review-target', 'allocator-one/rcl#105', '--config', 'config.json', '--attest', '--attestation-stdin'], fixture.repo, env,
        30000, child => child.stdin!.end(JSON.stringify(session)));
      expect(resumed.status, resumed.stderr).toBe(0); expect(fixture.calls()).toBe(2);
      expect(fixture.privateRuns.get(report.run.id)!.privateBytes).toBe(bytes);
      expect(resumed.stderr + resumed.stdout).not.toContain(session.credential.token);
      expect((await loadConvergeRunState(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture'))!.lastLaunch!.deliveryPending).toBe(false);
    });
  }, 40000);

  it.each(['asserted', 'protected'])('routes a normal guarded retry in %s mode to only eligible unstarted cells after the original finite deadline', async mode => {
    await withGuardedFixture(async fixture => {
      const retainedArgs = fixture.retainedArgs();
      const args = [...(mode === 'asserted' ? [...retainedArgs, '--retain-reviewers', '--for-pr', 'allocator-one/rcl#105'] :
        ['review', 'allocator-one/rcl#105', '--retain-reviewers', '--attest', '--converge-target', 'guarded-fixture', '--config', 'config.json', '--json-file', 'report.json']),
        '--max-attempts', '4', '--max-rounds', '3', '--round', '1'];
      const env = mode === 'asserted' ? fixture.env : { ...fixture.env, ...fixture.protectedEnv };
      const config = JSON.parse(readFileSync(join(fixture.repo, 'config.json'), 'utf8'));
      config.roles.push('performance-engineer'); config.maxRetries = 0; config.timeout = 2000; config.concurrency = 1;
      writeFileSync(join(fixture.repo, 'config.json'), JSON.stringify(config));
      fixture.delayCapability(3000); fixture.holdCall(2);
      const original = await runRclAsync(args, fixture.repo, env);
      expect(original.status, original.stderr).toBe(0); expect(fixture.calls()).toBe(2);
      const source = JSON.parse(readFileSync(join(fixture.repo, 'report.json'), 'utf8'));
      const initial = fixture.privateRuns.get(source.run.id)!.privateBytes!;
      const nativeBefore = await loadConvergeAttemptState(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture');
      for (const [flag, value] of [['--max-attempts', '5'], ['--max-rounds', '4'], ['--round', '2']]) {
        const changed = args.map((arg, index) => args[index - 1] === flag ? value! : arg).map(arg => arg === 'report.json' ? 'refused.json' : arg);
        const refused = await runRclAsync(changed, fixture.repo, env);
        expect(refused.status).toBe(1); expect(refused.stderr).toContain('preserves_saved_native_limits');
        expect(fixture.calls()).toBe(2);
        expect(await loadConvergeAttemptState(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture')).toEqual(nativeBefore);
      }
      const next = await runRclAsync(args.map(arg => arg === 'report.json' ? 'next.json' : arg), fixture.repo, env);
      expect(next.status, next.stderr).toBe(0); expect(fixture.calls()).toBe(3);
      const successor = JSON.parse(readFileSync(join(fixture.repo, 'next.json'), 'utf8'));
      expect(successor.run.reviewer_evidence.kind).toBe('supplemented');
      expect(successor.run.converge).toMatchObject({ attempt: 2, round: 1 });
      const wire = JSON.parse(fixture.privateRuns.get(successor.run.id)!.privateBytes!);
      expect(wire.checkpoints).toHaveLength(2); expect(wire.newPhysicalAttempts).toHaveLength(1);
      expect(fixture.privateRuns.get(source.run.id)!.privateBytes).toBe(initial);
      expect(await loadConvergeAttemptState(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture')).toMatchObject({ attemptsUsed: 2, cap: 4 });
      expect((await loadConvergeRunState(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture'))!.roundCap).toBe(3);
    });
  }, 40000);

  it('allows genuinely changed retained inputs through the original guarded retry policy without replacing source evidence', async () => {
    await withGuardedFixture(async fixture => {
      const args = fixture.retainedArgs(), config = JSON.parse(readFileSync(join(fixture.repo, 'config.json'), 'utf8'));
      config.maxRetries = 0; writeFileSync(join(fixture.repo, 'config.json'), JSON.stringify(config));
      writeFileSync(join(fixture.repo, 'spec.md'), 'Original private specification');
      fixture.responseForCall(call => call === 1 ? 'unparseable' : '{"findings":[]}');
      const first = await runRclAsync([...args, '--retain-reviewers', '--for-pr', 'allocator-one/rcl#105', '--spec', 'spec.md'], fixture.repo, fixture.env);
      expect(first.status, first.stderr).toBe(0); expect(fixture.calls()).toBe(2);
      const source = JSON.parse(readFileSync(join(fixture.repo, 'report.json'), 'utf8'));
      const sourceBytes = fixture.privateRuns.get(source.run.id)!.privateBytes;
      writeFileSync(join(fixture.repo, 'spec.md'), 'Materially revised private specification');
      const nextArgs = [...args.map(arg => arg === 'report.json' ? 'changed.json' : arg), '--retain-reviewers', '--for-pr', 'allocator-one/rcl#105', '--spec', 'spec.md'];
      const next = await runRclAsync([...nextArgs, '--retry-reason', 'Changed specification after the failed original; new inputs require a fresh original'], fixture.repo, fixture.env);
      expect(next.status, next.stderr).toBe(0); expect(fixture.calls()).toBe(4);
      const report = JSON.parse(readFileSync(join(fixture.repo, 'changed.json'), 'utf8'));
      expect(report.run.reviewer_evidence.kind).toBe('original'); expect(report.run.id).not.toBe(source.run.id);
      expect(report.run.converge).toMatchObject({ attempt: 2, round: 1 });
      expect(fixture.privateRuns.get(source.run.id)!.privateBytes).toBe(sourceBytes);
      expect(await loadConvergeAttemptState(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture')).toMatchObject({ attemptsUsed: 2 });
    });
  }, 40000);

  it('uses a distinct ordinary attested original for materially changed automatic inputs under the same native guard', async () => {
    await withGuardedFixture(async fixture => {
      fixture.retainedArgs();
      const config = JSON.parse(readFileSync(join(fixture.repo, 'config.json'), 'utf8')); config.maxRetries = 0;
      writeFileSync(join(fixture.repo, 'config.json'), JSON.stringify(config));
      writeFileSync(join(fixture.repo, 'spec.md'), 'Original protected specification');
      fixture.responseForCall(call => call === 1 ? 'unparseable' : '{"findings":[]}');
      const env = { ...fixture.env, ...fixture.protectedEnv };
      const args = ['review', 'allocator-one/rcl#105', '--retain-reviewers', '--attest', '--converge-target', 'guarded-fixture',
        '--config', 'config.json', '--spec', 'spec.md', '--json-file', 'protected.json'];
      const first = await runRclAsync(args, fixture.repo, env); expect(first.status, first.stderr).toBe(0);
      const source = JSON.parse(readFileSync(join(fixture.repo, 'protected.json'), 'utf8'));
      const sourceBytes = fixture.privateRuns.get(source.run.id)!.privateBytes, commonDir = realpathSync(join(fixture.repo, '.git'));
      const before = await loadConvergeAttemptState(commonDir, 'guarded-fixture');
      writeFileSync(join(fixture.repo, 'spec.md'), 'Materially revised protected specification');
      const nextArgs = args.map(arg => arg === 'protected.json' ? 'changed-protected.json' : arg);
      const refused = await runRclAsync(nextArgs, fixture.repo, env);
      expect(refused.status).toBe(1); expect(refused.stderr).toContain('infrastructure_failure');
      expect(fixture.calls()).toBe(2); expect(await loadConvergeAttemptState(commonDir, 'guarded-fixture')).toEqual(before);
      const next = await runRclAsync([...nextArgs, '--retry-reason', 'Changed specification requires a separately guarded original'], fixture.repo, env);
      expect(next.status, next.stderr).toBe(0); expect(fixture.calls()).toBe(4);
      const report = JSON.parse(readFileSync(join(fixture.repo, 'changed-protected.json'), 'utf8'));
      expect(report.run.reviewer_evidence.kind).toBe('original'); expect(report.run.id).not.toBe(source.run.id);
      expect(report.run.converge).toMatchObject({ attempt: 2, round: 1 });
      expect(fixture.minted.get(report.run.id)!.reviewerRecovery).toBeUndefined();
      const wire = JSON.parse(fixture.privateRuns.get(report.run.id)!.privateBytes!);
      expect(wire.checkpoints).toHaveLength(1); expect(wire.asyncExecution).toBeUndefined();
      for (const [id, session] of fixture.minted) if (session.reviewerRecovery) {
        expect(id).not.toBe(report.run.id); expect(fixture.privateRuns.has(id)).toBe(false);
        expect(existsSync(checkpointPath(commonDir, 'guarded-fixture', id))).toBe(false);
      }
      expect(fixture.privateRuns.get(source.run.id)!.privateBytes).toBe(sourceBytes);
    });
  }, 40000);

  it('applies and resumes only missing retained assignments without rebilling source calls', async () => {
    await withGuardedFixture(async fixture => {
      const args = fixture.retainedArgs(), config = JSON.parse(readFileSync(join(fixture.repo, 'config.json'), 'utf8'));
      config.maxRetries = 0; writeFileSync(join(fixture.repo, 'config.json'), JSON.stringify(config));
      fixture.responseForCall(call => call === 1 ? 'unparseable fixture' : '{"findings":[]}');
      const original = await runRclAsync([...args, '--retain-reviewers', '--for-pr', 'allocator-one/rcl#105'], fixture.repo, fixture.env);
      expect(original.status, original.stderr).toBe(0); expect(fixture.calls()).toBe(2);
      const source = JSON.parse(readFileSync(join(fixture.repo, 'report.json'), 'utf8'));
      const head = source.run.target.head_sha;
      const binding = ['--review-target', 'change.patch', '--head-sha', head, '--base-sha', head,
        '--for-pr', 'allocator-one/rcl#105', '--config', 'config.json'];
      const applyArgs = ['reviewers', 'apply', 'guarded-fixture', '--run', source.run.id, ...binding,
        '--max-additional-calls', '1', '--max-attempts-per-cell', '2', '--time-budget-ms', '30000'];
      const tiny = await runRclAsync(applyArgs.map(arg => arg === '30000' ? '3' : arg), fixture.repo, fixture.env);
      expect(tiny.status).toBe(1); expect(tiny.stderr).toContain('retained_execution_budget');
      expect(fixture.calls()).toBe(2);
      expect(await loadConvergeAttemptState(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture')).toMatchObject({ attemptsUsed: 1 });
      fixture.capability(false);
      const unsupported = await runRclAsync(applyArgs, fixture.repo, fixture.env);
      expect(unsupported.status).toBe(1); expect(unsupported.stderr).toContain('capability_unavailable');
      fixture.capability(true);
      const wrongBinding = await runRclAsync(applyArgs.map(arg => arg === 'allocator-one/rcl#105' ? 'allocator-one/rcl#106' : arg), fixture.repo, fixture.env);
      expect(wrongBinding.status).toBe(1); expect(wrongBinding.stderr).toContain('input_mismatch');
      const storedSource = fixture.privateRuns.get(source.run.id)!, savedSource = storedSource.privateBytes;
      storedSource.privateBytes = undefined;
      const unavailable = await runRclAsync(applyArgs, fixture.repo, fixture.env);
      expect(unavailable.status).toBe(1); expect(unavailable.stderr).toContain('source_unavailable');
      storedSource.privateBytes = savedSource;
      expect(fixture.calls()).toBe(2);
      expect(await loadConvergeAttemptState(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture')).toMatchObject({ attemptsUsed: 1 });
      writeFileSync(join(fixture.repo, 'empty.patch'), '');
      const empty = await runRclAsync(applyArgs.map(arg => arg === 'change.patch' ? 'empty.patch' : arg), fixture.repo, fixture.env);
      expect(empty.status).toBe(1); expect(empty.stderr).toContain('input_mismatch');
      const applied = await runRclAsync(['reviewers', 'apply', 'guarded-fixture', '--run', source.run.id, ...binding,
        '--max-additional-calls', '1', '--max-attempts-per-cell', '2', '--time-budget-ms', '30000', '--json-file', 'successor.json'], fixture.repo, fixture.env);
      expect(applied.status, applied.stderr).toBe(0); expect(fixture.calls()).toBe(3);
      const successor = JSON.parse(readFileSync(join(fixture.repo, 'successor.json'), 'utf8'));
      expect(successor.run.converge).toMatchObject({ attempt: 2, round: 1 });
      expect(successor.run.reviewer_evidence.kind).toBe('supplemented');
      expect(fixture.privateRuns.get(successor.run.id)!.envelope.calls).toEqual([]);
      const saved = fixture.privateRuns.get(source.run.id)!.privateBytes;
      const resumed = await runRclAsync(['reviewers', 'resume', 'guarded-fixture', '--run', successor.run.id, ...binding], fixture.repo, fixture.env);
      expect(resumed.status, resumed.stderr).toBe(0); expect(fixture.calls()).toBe(3);
      expect(fixture.privateRuns.get(source.run.id)!.privateBytes).toBe(saved);
      expect(await loadConvergeAttemptState(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture')).toMatchObject({ attemptsUsed: 2 });
      const renewal = await runRclAsync(['reviewers', 'resume', 'guarded-fixture', '--run', successor.run.id, ...binding, '--time-budget-ms', '60000'], fixture.repo, fixture.env);
      expect(renewal.status).toBe(1); expect(fixture.calls()).toBe(3);
    });
  }, 40000);

  it('dispatches captured retained async calls under the same journal and delivers exact original-only accounting', async () => {
    await withGuardedFixture(async fixture => {
      const args = fixture.retainedArgs();
      const config = JSON.parse(readFileSync(join(fixture.repo, 'config.json'), 'utf8')); config.asyncModels = ['openai-compat/bonus']; config.maxRetries = 0;
      writeFileSync(join(fixture.repo, 'config.json'), JSON.stringify(config));
      fixture.holdResponses();
      const running = runRclAsync([...args, '--retain-reviewers', '--for-pr', 'allocator-one/rcl#105'], fixture.repo, fixture.env);
      try {
        await Promise.race([fixture.firstRequest, running.then(result => { throw new Error(result.stderr); })]);
        const until = Date.now() + 5000; while (fixture.calls() < 3 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
        expect(fixture.calls()).toBe(3);
      } finally { fixture.releaseResponses(); }
      const result = await running; expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(join(fixture.repo, 'report.json'), 'utf8'));
      const stored = fixture.privateRuns.get(report.run.id)!; const artifact = JSON.parse(stored.privateBytes!);
      expect(artifact.newAsyncPhysicalAttempts).toHaveLength(1); expect(artifact.asyncExecution).toBeDefined();
      const asyncProof = JSON.parse(artifact.asyncExecution.bytes), lifetime = asyncProof.plan.context.expiresAtMs - asyncProof.plan.context.startedAtMs;
      expect(asyncProof.plan.expiresAtMs).toBe(asyncProof.plan.context.expiresAtMs - Math.min(120000, Math.floor(lifetime / 4)));
      expect(artifact.health.successfulSeats).toHaveLength(2); expect(stored.envelope.calls).toEqual([]);
      const status = await runRclAsync(['reviewers', 'status', 'guarded-fixture', '--run', report.run.id, '--json'], fixture.repo, fixture.env);
      expect(status.status, status.stderr).toBe(0); expect(JSON.parse(status.stdout).attempts.async.current.intents).toBe(1);
      expect(fixture.calls()).toBe(3);
    });
  }, 20000);

  it('delivers a retained original only through the actual current-credential capability and private pair', async () => {
    await withGuardedFixture(async fixture => {
      const result = await runRclAsync([...fixture.retainedArgs(), '--retain-reviewers', '--for-pr', 'allocator-one/rcl#105'], fixture.repo, fixture.env);
      expect(result.status, result.stderr).toBe(0); expect(fixture.calls()).toBe(2);
      const report = JSON.parse(readFileSync(join(fixture.repo, 'report.json'), 'utf8'));
      const stored = fixture.privateRuns.get(report.run.id)!;
      expect(stored.envelope.calls).toEqual([]); expect(stored.privateBytes).toBeDefined();
      expect(JSON.parse(stored.privateBytes!).report.bytes).toBe(stored.ordinary.get('report_json'));
      expect((await loadConvergeRunState(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture'))?.lastLaunch).toMatchObject({ attempt: 1, round: 1, deliveryPending: false });
    });
  }, 40000);

  it('retains the actual verifier phase with the original private report and never repeats it for status', async () => {
    await withGuardedFixture(async fixture => {
      const config = JSON.parse(readFileSync(join(fixture.repo, 'config.json'), 'utf8'));
      config.thresholds = { minConfidence: 0, minConsensusScore: 0 };
      config.gating = { mode: 'verified-consensus', minModels: 2, verificationModel: 'openai-compat/verifier',
        verificationTimeout: 10000, verificationPassTimeout: 10000 };
      writeFileSync(join(fixture.repo, 'config.json'), JSON.stringify(config));
      fixture.responseForCall(call => call === 1 ? JSON.stringify({ findings: [{
        id: 'F1', file: 'a.ts', startLine: 1, endLine: 1, severity: 'important', category: 'correctness',
        title: 'Missing guard', description: 'The changed line omits its required guard.'
      }] }) : call === 2 ? JSON.stringify({ findings: [] }) : '[{"id":"F1","verdict":"confirmed"}]');
      const result = await runRclAsync([...fixture.retainedArgs(), '--retain-reviewers', '--for-pr', 'allocator-one/rcl#105'],
        fixture.repo, fixture.env);
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(join(fixture.repo, 'report.json'), 'utf8'));
      expect(report.findings[0].gating.reason).toBe('verified');
      expect(fixture.calls()).toBe(3);
      const journal = await CheckpointJournal.inspectRead(checkpointPath(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture', report.run.id));
      const phase = (await journal.readVerification())!;
      expect(phase.terminal!.status).toBe('complete');expect(phase.intents).toHaveLength(1);
      expect(phase.outcomes[0]!.answerBytes).toContain('confirmed');
      const terminal = (await journal.readTerminalReport())!;
      expect(JSON.parse(terminal.reviewerArtifactBytes).verification.bytes).toBe((await journal.exportVerificationProof()).bytes);
      const status = await runRclAsync(['reviewers', 'status', 'guarded-fixture', '--run', report.run.id, '--json'], fixture.repo, fixture.env);
      expect(status.status, status.stderr).toBe(0);expect(fixture.calls()).toBe(3);
      expect(JSON.parse(status.stdout).attempts).toMatchObject({ physical: 2, newOnly: 2,
        verifier: { current: { intents: 1, uncertain: 0, status: 'complete' }, inherited: { intents: 0, uncertain: 0 } },
        reviewerAndVerifier: { physical: 3, newOnly: 3, uncertain: 0 } });
    });
  }, 40000);

  it('retains actual reviewer inputs and immutable terminal artifacts privately in the guarded review command', async () => {
    await withGuardedFixture(async fixture => {
      writeFileSync(join(fixture.repo, 'spec.md'), 'PRIVATE retained council specification');
      fixture.holdResponses();
      const running = runRclAsync([...fixture.retainedArgs(), '--retain-reviewers', '--for-pr', 'allocator-one/rcl#105',
        '--spec', 'spec.md'], fixture.repo, fixture.env);
      await fixture.firstRequest;
      try {
        const targetDirectory = dirname(checkpointPath(realpathSync(join(fixture.repo, '.git')),
          'guarded-fixture', '019921a0-0000-7000-8000-000000000001'));
        const runs = readdirSync(targetDirectory).filter(name => name !== '.staging');
        expect(runs).toHaveLength(1);
        const active = await CheckpointJournal.inspectRead(join(targetDirectory, runs[0]!));
        const bindings = await active.readBindings();
        expect(bindings['captured-inputs']).toContain('PRIVATE retained council specification');
        expect(JSON.parse(bindings.launch!)).toMatchObject({ originalNativeClaim: { attempt: 1, round: 1 } });
        expect((await active.read()).finalized).toBe(false);
      } finally { fixture.releaseResponses(); }
      const result = await running;
      expect(result.status, result.stderr).toBe(0);
      const reportBytes = readFileSync(join(fixture.repo, 'report.json'), 'utf8'), report = JSON.parse(reportBytes);
      expect(report.run.reviewer_evidence.kind).toBe('original');
      expect(fixture.calls()).toBe(2);
      expect(reportBytes).not.toContain('PRIVATE retained council specification');
      expect(report.reviewerEvidence).toBeUndefined();
      const journal = await CheckpointJournal.inspectRead(checkpointPath(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture', report.run.id));
      expect((await journal.read()).successes).toHaveLength(2);
      expect((await journal.read()).finalized).toBe(true);
      const retained = await journal.readTerminalReport();
      expect(retained!.reportBytes).toBe(reportBytes);
      expect(retained!.reviewerArtifactBytes).toContain('PRIVATE retained council specification');
      const status = await runRclAsync(['reviewers', 'status', 'guarded-fixture', '--run', report.run.id, '--json'],
        fixture.repo, fixture.env);
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).not.toContain('PRIVATE');
      const preview = await runRclAsync(['reviewers', 'preview', 'guarded-fixture', '--run', report.run.id,
        '--max-additional-calls', '1', '--max-attempts-per-cell', '2', '--time-budget-ms', '30000', '--json'], fixture.repo, fixture.env);
      expect(preview.status, preview.stderr).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({ scope: 'local_structural_preview_only',
        recovery: { nextAction: 'build_report', successesNeeded: 0 }, eligibleAssignments: [] });
      expect(preview.stdout).not.toContain('PRIVATE');
      expect(await loadConvergeAttemptState(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture')).toMatchObject({ attemptsUsed: 1 });
      expect(fixture.calls()).toBe(2);
      const admitted = await runRclAsync(['converge-report', '--target', 'guarded-fixture', '--round', '1',
        '--report', 'report.json', '--json'], fixture.repo, { ...fixture.env, RCL_TELEMETRY: 'off' });
      expect(admitted.status, admitted.stderr).toBe(0);
      expect(JSON.parse(admitted.stdout).actionableGating).toBe(0);
      expect((await loadConvergeRunState(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture'))!.rounds)
        .toHaveLength(1);
      expect(fixture.calls()).toBe(2);
    });
  }, 40_000);

  it('preserves strict original-seat quorum through retained assembly and launch completion', async () => {
    await withGuardedFixture(async fixture => {
      const config = JSON.parse(readFileSync(join(fixture.repo, 'config.json'), 'utf8'));
      config.roles.push('performance-engineer');
      config.quorumFraction = 1;
      config.maxRetries = 0;
      writeFileSync(join(fixture.repo, 'config.json'), JSON.stringify(config));
      fixture.failCall(3);
      const args = [...fixture.retainedArgs(), '--retain-reviewers', '--for-pr', 'allocator-one/rcl#105', '--ci'];
      const result = await runRclAsync(args, fixture.repo, fixture.env);
      expect(result.status, result.stderr).toBe(1);
      expect(fixture.calls()).toBe(3);
      const report = JSON.parse(readFileSync(join(fixture.repo, 'report.json'), 'utf8'));
      expect(report.run.ci_exit_code).toBe(1);
      expect(report.stats).toMatchObject({ successfulReviews: 2, totalReviews: 3 });
      const commonDir = realpathSync(join(fixture.repo, '.git'));
      const state = await loadConvergeRunState(commonDir, 'guarded-fixture');
      expect(state).toMatchObject({ rounds: [], lastLaunch: { status: 'completed', reviewerHealth: {
        version: 1, successfulSeats: 2, policy: { version: 1, fraction: 1, seatCount: 3, minimumSuccessful: 3 },
      } } });
      const journal = await CheckpointJournal.inspectRead(checkpointPath(commonDir, 'guarded-fixture', report.run.id));
      expect((await journal.read()).successes).toHaveLength(2);
      expect((await journal.read()).outcomes).toHaveLength(3);
      expect(await journal.readTerminalReport()).toBeDefined();
      const refused = await runRclAsync(['converge-report', '--target', 'guarded-fixture', '--round', '1',
        '--report', 'report.json', '--json'], fixture.repo, { ...fixture.env, RCL_TELEMETRY: 'off' });
      expect(refused.status).toBe(3);
      expect(refused.stderr).toContain('retained_report_inconclusive');
      const stripped = structuredClone(report);
      delete stripped.run.reviewer_evidence;
      writeFileSync(join(fixture.repo, 'stripped.json'), JSON.stringify(stripped));
      const strippedRefused = await runRclAsync(['converge-report', '--target', 'guarded-fixture', '--round', '1',
        '--report', 'stripped.json', '--json'], fixture.repo, { ...fixture.env, RCL_TELEMETRY: 'off' });
      expect(strippedRefused.status).toBe(3);
      expect((await loadConvergeRunState(commonDir, 'guarded-fixture'))!.rounds).toEqual([]);
      const retry = await runRclAsync(args.map(arg => arg === 'report.json' ? 'retry.json' : arg), fixture.repo, fixture.env);
      expect(retry.status).toBe(1);
      expect(retry.stderr).toContain('recovery_launch_source_not_actionable');
      expect(fixture.calls()).toBe(3);
      expect(await loadConvergeAttemptState(commonDir, 'guarded-fixture')).toMatchObject({ attemptsUsed: 1 });
    });
  }, 40_000);

  it('refuses reviewer retention without a guarded claim before any provider request', async () => {
    await withGuardedFixture(async fixture => {
      const result = await runRclAsync([...fixture.args.filter(arg => arg !== '--guarded-converge'), '--retain-reviewers'],
        fixture.repo, fixture.env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('reviewer_retention_requires_guard');
      expect(fixture.calls()).toBe(0);
    });
  }, 40_000);

  it.each(['missing-binding', 'unsupported-backend'])('refuses retained %s before a native claim or provider call', async reason => {
    await withGuardedFixture(async fixture => {
      let args = [...fixture.args, '--retain-reviewers'];
      if (reason === 'unsupported-backend') {
        const config = JSON.parse(readFileSync(join(fixture.repo, 'config.json'), 'utf8'));
        config.harness.telemetry = 'full';
        writeFileSync(join(fixture.repo, 'config.json'), JSON.stringify(config));
        args = [...args.filter(arg => arg !== '--no-telemetry'), '--for-pr', 'allocator-one/rcl#105'];
      }
      const result = await runRclAsync(args, fixture.repo, { ...fixture.env, RCL_TELEMETRY: '' });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(reason === 'missing-binding'
        ? 'reviewer_retention_requires_binding' : 'reviewer_evidence_backend_unsupported');
      expect(fixture.calls()).toBe(0);
      expect(await loadConvergeAttemptState(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture')).toBeUndefined();
    });
  }, 40_000);

  it('refuses invalid retention time bounds without spending a native attempt', async () => {
    await withGuardedFixture(async fixture => {
      const config = JSON.parse(readFileSync(join(fixture.repo, 'config.json'), 'utf8'));
      config.timeout = 2_147_483_648;
      writeFileSync(join(fixture.repo, 'config.json'), JSON.stringify(config));
      const result = await runRclAsync([...fixture.retainedArgs(), '--retain-reviewers', '--for-pr', 'allocator-one/rcl#105'],
        fixture.repo, fixture.env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('original_launch_invalid_duration');
      expect(fixture.calls()).toBe(0);
      expect(await loadConvergeAttemptState(realpathSync(join(fixture.repo, '.git')), 'guarded-fixture')).toBeUndefined();
    });
  }, 40_000);

  it('claims and binds one launch only after successful preflight', async () => {
    await withGuardedFixture(async fixture => {
      const result = await runRclAsync(fixture.args, fixture.repo, fixture.env);

      expect(result.status, result.stderr).toBe(0);
      expect(fixture.calls()).toBe(2);
      expect(JSON.parse(readFileSync(join(fixture.repo, 'report.json'), 'utf8')).run.converge)
        .toEqual({ target: 'guarded-fixture', round: 1, attempt: 1 });
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture'))
        .toMatchObject({ attemptsUsed: 1 });
    });
  }, 40_000);

  it('keeps a privately retained terminal report reusable after a late output collision', async () => {
    await withGuardedFixture(async fixture => {
      fixture.holdResponses();
      const args = [...fixture.retainedArgs(), '--retain-reviewers', '--for-pr', 'allocator-one/rcl#105'];
      const running = runRclAsync(args, fixture.repo, fixture.env);
      await fixture.firstRequest;
      writeFileSync(join(fixture.repo, 'report.json'), 'preserved');
      fixture.releaseResponses();
      const result = await running;
      expect(result.status).toBe(1);
      expect(readFileSync(join(fixture.repo, 'report.json'), 'utf8')).toBe('preserved');
      const commonDir = realpathSync(join(fixture.repo, '.git'));
      const state = await loadConvergeRunState(commonDir, 'guarded-fixture');
      expect(state!.lastLaunch!.status).toBe('completed');
      const journal = await CheckpointJournal.inspectRead(checkpointPath(commonDir, 'guarded-fixture', state!.lastLaunch!.runId!));
      expect((await journal.readTerminalReport())!.reportSha256).toBe(state!.lastLaunch!.reportJsonSha256);
      const retry = await runRclAsync([...args, '--json-file', 'retry.json'], fixture.repo, fixture.env);
      expect(retry.status).toBe(1);
      expect(retry.stderr).toContain('report_not_admitted');
      expect(fixture.calls()).toBe(2);
      expect(await loadConvergeAttemptState(commonDir, 'guarded-fixture')).toMatchObject({ attemptsUsed: 1 });
    });
  }, 40_000);

  it('preserves a report file created after guarded preflight', async () => {
    await withGuardedFixture(async fixture => {
      fixture.holdResponses();
      const run = runRclAsync(fixture.args, fixture.repo, fixture.env);
      await fixture.firstRequest;
      writeFileSync(join(fixture.repo, 'report.json'), 'preserved');
      fixture.releaseResponses();
      const result = await run;
      expect(result.status).toBe(1);
      expect(readFileSync(join(fixture.repo, 'report.json'), 'utf8')).toBe('preserved');
      expect((await loadConvergeRunState(join(fixture.repo, '.git'), 'guarded-fixture'))?.lastLaunch?.status)
        .toBe('failed');

      const retryArgs = [...fixture.args, '--json-file', 'retry.json'];
      const blindRetry = await runRclAsync(retryArgs, fixture.repo, fixture.env);
      expect(blindRetry.status).toBe(1);
      expect(blindRetry.stderr).toContain('dispatch_unknown');
      expect(fixture.calls()).toBe(2);
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture'))
        .toMatchObject({ attemptsUsed: 1 });

      const recovered = await runRclAsync([...retryArgs, '--retry-reason',
        'Known JSON write collision; selected a fresh destination after checking the failed run'], fixture.repo, fixture.env);
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(fixture.calls()).toBe(4);
      expect(JSON.parse(readFileSync(join(fixture.repo, 'retry.json'), 'utf8')).run.converge)
        .toEqual({ target: 'guarded-fixture', round: 1, attempt: 2 });
    });
  }, 40_000);

  it.each(['retained JSON', 'Markdown only'])('reuses the completed report after a %s write failure', async failedOutput => {
    await withGuardedFixture(async fixture => {
      const retainedJson = failedOutput === 'retained JSON';
      const output = retainedJson ? 'report.json' : 'report.md';
      const env = { ...fixture.env, ...(retainedJson ? {
        RCL_TELEMETRY: 'findings', HARNESS_API_URL: 'http://127.0.0.1:1', HARNESS_API_TOKEN: '',
      } : {}) };
      if (retainedJson) {
        mkdirSync(join(fixture.repo, '.harness-cli'));
        writeFileSync(join(fixture.repo, '.harness-cli', 'config.json'), '{}');
      }
      const args = retainedJson
        ? fixture.args.filter(argument => argument !== '--no-telemetry')
        : [...fixture.args, '--markdown', output];
      fixture.holdResponses();
      const run = runRclAsync(args, fixture.repo, env);
      await fixture.firstRequest;
      writeFileSync(join(fixture.repo, output), 'preserved');
      fixture.releaseResponses();
      expect((await run).status).toBe(1);
      const state = await loadConvergeRunState(join(fixture.repo, '.git'), 'guarded-fixture');
      expect(state?.lastLaunch?.status).toBe('completed');
      const reportPath = retainedJson
        ? join(fixture.repo, 'rcl-data', 'quarantine', state!.lastLaunch!.runId!, 'report.json')
        : join(fixture.repo, 'report.json');
      expect(JSON.parse(readFileSync(reportPath, 'utf8')).run.id).toBe(state?.lastLaunch?.runId);

      const retry = await runRclAsync([...args, '--json-file', 'retry.json', '--retry-reason',
        'A fresh output destination is available'], fixture.repo, env);
      expect(retry.status).toBe(1);
      expect(retry.stderr).toContain('report_not_admitted');
      expect(fixture.calls()).toBe(2);
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture'))
        .toMatchObject({ attemptsUsed: 1 });
    });
  }, 40_000);

  it.each([
    { args: ['--round', '27'], error: /wrong_round.*round 1/i },
    { args: ['--json-file', 'missing-directory/report.json'], error: /ENOENT|output/i },
    { args: ['--reviewer', 'openai/fixture:general'], error: /missing_provider_credentials/i },
    { args: ['--context', 'missing-context.md'], error: /unreadable_context/i },
    { args: ['--spec', 'missing-spec.md'], error: /unreadable_spec/i },
    { args: ['--config', 'missing-config.json'], error: /ConfigError/i },
    { args: ['--markdown', 'report.json'], error: /output_collision/i },
    { args: ['--attempt', '1'], error: /incompatible_launch/i },
    { args: ['--role', 'general'], error: /insufficient_reviewers/i },
    { args: ['--reviewer', 'openai-compat/fixture:general', '--reviewer', 'openai-compat/fixture:missing-role'], error: /invalid_reviewers/i },
    { args: ['--launch-intent', 'stop-review'], error: /review_stopped/i },
    { args: ['--launch-intent', 'retry-delivery'], error: /delivery_only/i },
  ])('refuses predictable failures without an attempt: $args', async scenario => {
    await withGuardedFixture(async fixture => {
      const result = await runRclAsync([...fixture.args, ...scenario.args], fixture.repo, fixture.env);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(scenario.error);
      expect(fixture.calls()).toBe(0);
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture')).toBeUndefined();
    });
  }, 40_000);

  it('does not launch again while a completed report awaits native admission', async () => {
    await withGuardedFixture(async fixture => {
      const first = await runRclAsync(fixture.args, fixture.repo, fixture.env);
      expect(first.status, first.stderr).toBe(0);

      const second = await runRclAsync([...fixture.args, '--json-file', 'second.json'], fixture.repo, fixture.env);

      expect(second.status).toBe(1);
      expect(second.stderr).toContain('report_not_admitted');
      expect(fixture.calls()).toBe(2);
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture'))
        .toMatchObject({ attemptsUsed: 1 });
    });
  }, 40_000);

  it('does not spend on base-tip movement but requires review of a changed head', async () => {
    await withGuardedFixture(async fixture => {
      const first = await runRclAsync([...fixture.args, '--launch-intent', 'stop-upstream'], fixture.repo, fixture.env);
      expect(first.status, first.stderr).toBe(0);
      const bytes = readFileSync(join(fixture.repo, 'report.json'), 'utf8');
      const report = JSON.parse(bytes);
      await processRoundReport({ gitCommonDir: join(fixture.repo, '.git'), target: 'guarded-fixture',
        round: 1, findings: report.findings, runId: report.run.id, reportSha256: sha256Hex(bytes) });

      const unchanged = await runRclAsync([...fixture.args, '--base-sha', 'b'.repeat(40), '--json-file', 'second.json'], fixture.repo, fixture.env);
      expect(unchanged.status, unchanged.stderr).toBe(1);
      expect(unchanged.stderr).toContain('inputs_unchanged');
      expect(fixture.calls()).toBe(2);
      const changed = await runRclAsync([...fixture.args, '--head-sha', 'c'.repeat(40), '--json-file', 'second.json'], fixture.repo, fixture.env);

      expect(changed.status, changed.stderr).toBe(0);
      expect(fixture.calls()).toBe(4);
      expect(JSON.parse(readFileSync(join(fixture.repo, 'second.json'), 'utf8')).run.converge)
        .toEqual({ target: 'guarded-fixture', round: 2, attempt: 2 });
    });
  }, 40_000);

  it.skipIf(process.platform === 'win32')('preserves uncertain dispatch after an actual process loss and refuses automatic retry', async () => {
    await withGuardedFixture(async fixture => {
      fixture.holdResponses();
      let child: ChildProcess | undefined;
      const first = runRclAsync(fixture.args, fixture.repo, fixture.env, 30_000, process => { child = process; });
      await Promise.race([fixture.firstRequest, first.then(result => {
        throw new Error(`Review did not dispatch: ${result.stderr}`);
      })]);
      try {
        const conflicting = await runRclAsync([...fixture.args, '--json-file', 'conflict.json'], fixture.repo, fixture.env);
        expect(conflicting.status).not.toBe(0);
        expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture'))
          .toMatchObject({ attemptsUsed: 1 });
        expect(child!.exitCode).toBeNull();
      } finally {
        child!.kill('SIGKILL');
      }
      await first;
      const calls = fixture.calls();
      expect(await loadConvergeRunState(join(fixture.repo, '.git'), 'guarded-fixture'))
        .toMatchObject({ lastLaunch: { status: 'pending', pid: child!.pid } });

      const second = await runRclAsync([...fixture.args, '--json-file', 'second.json'], fixture.repo, fixture.env);

      expect(second.status).toBe(1);
      expect(second.stderr).toContain('dispatch_unknown');
      expect(fixture.calls()).toBe(calls);
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture'))
        .toMatchObject({ attemptsUsed: 1 });
    });
  }, 40_000);
});

describe('rcl review — exact-head binding flags', () => {
  it('reviews a captured patch without reading gh credentials', async () => {
    const repo = tempRepository();
    const marker = join(repo, 'gh-called');
    const binaries = join(repo, 'bin');
    mkdirSync(binaries);
    writeFileSync(join(binaries, 'gh'),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\nprocess.stdout.write('fixture-token');\n`,
      { mode: 0o700 });
    writeFileSync(join(repo, 'change.patch'), 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
    writeFileSync(join(repo, 'config.json'), JSON.stringify({
      models: ['openai-compat/fixture'], secondaryModels: [], asyncModels: [],
      harness: { telemetry: 'off' },
    }));
    let calls = 0;
    const server = createServer((request, response) => {
      request.resume();
      calls++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture',
        choices: [{ index: 0, finish_reason: 'stop', message: {
          role: 'assistant', content: JSON.stringify({ findings: [] }),
        } }],
      }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const result = await runRclAsync([
        'review', 'change.patch', '--config', 'config.json',
        '--reviewer', 'openai-compat/fixture:general', '--no-telemetry',
      ], repo, {
        PATH: `${binaries}:${process.env['PATH'] ?? ''}`,
        GITHUB_TOKEN: '', GH_TOKEN: '',
        OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${port}/v1`,
        RCL_DATA_DIR: join(repo, 'rcl-data'),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(calls).toBe(1);
      expect(existsSync(marker)).toBe(false);
      expect(result.stdout + result.stderr).not.toContain('fixture-token');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 40_000);

  it('--expect-head-sha fails fast before anything is reviewed when HEAD differs', () => {
    const repo = tempRepository();
    const result = runRcl(['review', '--staged', '--expect-head-sha', 'f'.repeat(40)], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/head .*does not match .*--expect-head-sha/i);
  });

  it('--expect-head-sha passes when HEAD matches (and an empty diff then exits cleanly)', () => {
    const repo = tempRepository();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
    const result = runRcl(['review', '--staged', '--expect-head-sha', head], repo);

    expect(result.status).toBe(0);
    // The notice may land on either stream depending on the spinner's TTY
    // detection; the exit status is the primary assertion.
    expect(result.stderr + result.stdout).toMatch(/No staged changes/);
  });

  it('--head-sha rejects anything but a full 40-hex SHA', () => {
    const repo = tempRepository();
    writeFileSync(join(repo, 'x.patch'), 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
    const result = runRcl(['review', './x.patch', '--head-sha', 'abc123'], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--head-sha.*40/);
  });

  it('classifies any non-PR-shaped target as a patch file, whatever its case or path form', () => {
    const repo = tempRepository();
    // Reaches the SHA format check, which only a patch-classified target does.
    for (const name of ['fix.DIFF', 'patches/fix', 'changes.txt']) {
      const result = runRcl(['review', name, '--head-sha', 'abc123'], repo);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/--head-sha.*40/);
    }
  });

  it('a mistyped PR reference explains what a target can be instead of a bare file error', () => {
    const repo = tempRepository();
    for (const typo of ['owner/repo#12x', 'owner/repo/pull/123']) {
      const result = runRcl(['review', typo], repo);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/No such patch file: .*owner\/repo#N, or a GitHub PR URL/);
    }
  });

  it('--head-sha and --base-sha apply to patch files only', () => {
    const repo = tempRepository();
    const result = runRcl(['review', '--staged', '--head-sha', 'a'.repeat(40)], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--head-sha.*patch file/);
  });

  it('--spec-source without a spec is an error, not a silently dropped claim', () => {
    const repo = tempRepository();
    const result = runRcl(['review', '--staged', '--spec-source', 'harness_issue:IO-12475'], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--spec-source was given without a spec/);
  });

  it('--head-sha with a git target fails before any configuration or diff work', () => {
    const repo = tempRepository();
    const result = runRcl(['review', '--working-tree', '--base-sha', 'a'.repeat(40)], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/patch files only.*--working-tree resolves HEAD itself/);
  });

  it('--spec-source rejects an unknown source', () => {
    const repo = tempRepository();
    const result = runRcl(['review', '--staged', '--spec-source', 'linear:ABC-1'], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--spec-source/);
  });
});

describe('rcl telemetry rejected', () => {
  it('inspects a selected retained original without delivering it', async () => {
    const repo = tempRepository();
    const dataDir = mkdtempSync(join(tmpdir(), 'rcl-rejected-cli-'));
    tempDirs.push(dataDir);
    const result = sampleResult();
    const artifacts = { report_json: JSON.stringify(result), report_md: '# Original report\n' };
    const store = new Quarantine(join(dataDir, 'quarantine'));
    await store.retain({
      runId: result.run!.id,
      artifacts,
      envelope: buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' } }),
      events: [],
      requestedMode: 'asserted',
      acknowledged: false,
      diagnostics: [{ path: 'delivery', message: 'HTTP 422' }],
    });

    const command = runRcl(['telemetry', 'rejected', '--run', result.run!.id, '--json'], repo, { RCL_DATA_DIR: dataDir });

    expect(command.status, command.stderr).toBe(0);
    expect(JSON.parse(command.stdout)).toMatchObject({
      entries: [{ runId: result.run!.id, status: 'complete' }],
    });
  });
});

describe('rcl review - async convergence identity', () => {
  it.each([
    { mode: 'patch', context: 'flag', attributed: false },
    { mode: 'patch', context: 'flag', attributed: true },
    { mode: 'patch', context: 'environment', attributed: false },
    { mode: 'patch', context: 'environment', attributed: true },
    { mode: 'patch', context: 'none', attributed: false },
    { mode: 'staged', context: 'flag', attributed: false },
    { mode: 'working-tree', context: 'flag', attributed: false },
    { mode: 'plan', context: 'flag', attributed: false },
  ])('collects with $mode identity, $context context, PR attribution=$attributed', async ({ mode, context, attributed }) => {
    const repo = tempRepository();
    const first = join(mkdtempSync(join(repo, 'round-1-')), 'review.patch');
    const next = join(mkdtempSync(join(repo, 'round-2-')), 'review.patch');
    const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
    writeFileSync(first, patch, { mode: 0o600 });
    const nextContent = mode === 'plan' ? '# Fixture plan\n\nA later plan.\n' : patch.replace('+b', '+c');
    writeFileSync(next, nextContent, { mode: 0o600 });
    const target = 'repo-12';
    const store = await resolveAsyncStoreDir(repo);
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo, env: GIT_ENV, encoding: 'utf8',
    }).trim();
    const label = mode === 'patch' ? (context === 'none' ? next : first)
      : mode === 'plan' ? `plan:${next}` : `git-${mode}-${branch}`;
    const key = asyncTargetKey(label, mode === 'patch' && context !== 'none' ? target : undefined);
    if (mode === 'staged' || mode === 'working-tree') {
      writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n');
      if (mode === 'staged') execFileSync('git', ['add', 'a.ts'], { cwd: repo, env: GIT_ENV });
    }
    const model = 'openrouter/async-fixture';
    const [spool] = await spoolAsyncCalls([{
      model, role: 'general', provider: 'openrouter',
      systemPrompt: 'fixture', userPrompt: patch,
    }], { storeDir: store, targetKey: key, timeoutMs: 1000, maxRetries: 0 });
    expect(await collectAsyncResults(store, key)).toEqual([]);
    const adapter: ReviewAdapter = {
      name: 'fixture', provider: 'openrouter',
      review: async (model, role) => ({
        model, role, provider: 'openrouter', findings: [], durationMs: 1, status: 'success',
      }),
      ask: async () => { throw new Error('not used'); },
    };
    await runAsyncWorker(spool!, () => adapter);

    const config = join(repo, 'config.json');
    writeFileSync(config, JSON.stringify({
      models: ['openai/fixture'], secondaryModels: [], asyncModels: [model],
    }));
    const reportPath = join(repo, 'report.json');
    const home = join(repo, 'home');
    mkdirSync(home);
    // Explicit reviewers suppress async dispatch, not collection. The blocking
    // fixture has no API key and records an error without contacting a provider.
    // Only the already-published fake result can supply an async review here.
    const result = runRcl([
      ...(mode === 'plan' ? ['review-plan', next]
        : mode === 'patch' ? ['review', next] : ['review', `--${mode}`]),
      '--config', config, '--reviewer', 'openai/fixture:general',
      ...(mode === 'patch' ? ['--head-sha', 'a'.repeat(40), '--base-sha', 'b'.repeat(40)] : []),
      ...(context === 'none' ? [] : ['--round', '2', '--attempt', '2']),
      '--no-telemetry', '--json-file', reportPath,
      ...(context === 'flag' ? ['--converge-target', ` ${target} `] : []),
      ...(attributed && context === 'flag' ? ['--for-pr', 'owner/repo#12'] : []),
    ], repo, {
      HOME: home, XDG_CONFIG_HOME: home, RCL_DATA_DIR: join(home, 'rcl'),
      RCL_CONVERGE_TARGET: context === 'none' ? '' : context === 'flag' ? 'must-not-win' : ` ${target} `,
      RCL_CONVERGE_ROUND: '', RCL_CONVERGE_ATTEMPT: '',
      RCL_FOR_PR: attributed && context === 'environment' ? 'owner/repo#12' : '',
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.run.converge).toEqual(context === 'none' ? undefined : { target, round: 2, attempt: 2 });
    expect(report.run.target.kind).toBe(mode === 'working-tree' ? 'working_tree' : mode);
    if (mode === 'patch') expect(report.run.target.head_sha).toBe('a'.repeat(40));
    expect(report.run.target.pr_number).toBe(attributed ? 12 : undefined);
    expect.soft(report.reviews.filter((review: { async?: boolean }) => review.async)).toEqual([
      expect.objectContaining({ model, role: 'general', status: 'success', async: true }),
    ]);
    expect(report.reviews.find((review: { model: string }) => review.model === 'openai/fixture')).toMatchObject({
      status: 'error', error: expect.stringContaining('Missing credentials'),
    });
    expect.soft(report.stats.asyncMerged).toBe(1);
    expect(report.stats.asyncLaunched).toBeUndefined();
    expect.soft(await collectAsyncResults(store, key)).toEqual([]);
    expect(readFileSync(first, 'utf8')).toBe(patch);
    expect(readFileSync(next, 'utf8')).toBe(nextContent);
  });
});

describe('rcl converge-report — pre-3.0 reports', () => {
  it('still loads a report without a run header or finding identities', () => {
    const repo = tempRepository();
    const report = {
      reviews: [
        { model: 'm1', role: 'general', provider: 'test', findings: [], durationMs: 1, status: 'success' },
        { model: 'm2', role: 'general', provider: 'test', findings: [], durationMs: 1, status: 'success' },
      ],
      findings: [
        {
          id: 'f1',
          file: 'src/a.ts',
          startLine: 10,
          endLine: 12,
          severity: 'important',
          category: 'correctness',
          title: 'Off by one',
          description: 'd',
          consensus: {
            score: 2,
            total: 2,
            models: ['m1', 'm2'],
            roles: ['general'],
            crossRole: false,
            crossModel: true,
            elevated: false,
            elevation: 'none',
            confidence: 0.7,
            confidenceLabel: 'High',
            tier: 'unanimous',
          },
          gating: { reason: 'consensus' },
        },
      ],
      stats: {
        totalReviews: 2,
        successfulReviews: 2,
        totalRawFindings: 2,
        totalDeduped: 1,
        belowThreshold: 0,
        durationMs: 10,
      },
    };
    writeFileSync(join(repo, 'report.json'), JSON.stringify(report));

    const result = runRcl(
      ['converge-report', '--target', 'legacy-target', '--report', 'report.json', '--round', '1', '--json'],
      repo
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.counts).toEqual({ new: 1, repeat: 0, suppressed: 0, regating: 0 });
    expect(parsed.findings[0]).toMatchObject({ status: 'new', gating: 'consensus', file: 'src/a.ts' });
  });
});

describe('rcl review — --attest (RCL-40)', () => {
  it('exits non-zero with a clear message outside GitHub Actions, before any network or reviewer work', () => {
    const repo = tempRepository();
    const result = runRcl(['review', 'allocator-one/rcl#42', '--attest'], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/GitHub Actions/);
    expect(result.stderr).toMatch(/id-token: write/);
    expect(result.stderr).not.toMatch(/Fetching|Resolving diff/);
  });

  it('refuses a local diff or a patch file: only a pull request can be attested', () => {
    const repo = tempRepository();
    writeFileSync(join(repo, 'change.patch'), 'diff --git a/a.ts b/a.ts\n');
    for (const args of [['review', '--staged', '--attest'], ['review', 'change.patch', '--attest']]) {
      const result = runRcl(args, repo);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/--attest applies to a pull request target/);
    }
  });

  it('contradicts --no-telemetry: an attested review is recorded or it does not run', () => {
    const repo = tempRepository();
    const result = runRcl(['review', 'allocator-one/rcl#42', '--attest', '--no-telemetry'], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--attest contradicts --no-telemetry/);
  });

  it.each([
    {
      source: 'the environment',
      expected: 'findings',
      prepare: (_repo: string) => ({ args: [] as string[], env: { RCL_TELEMETRY: 'findings' } }),
    },
    {
      source: 'the project config',
      expected: 'off',
      prepare: (repo: string) => {
        writeFileSync(join(repo, '.review-council.yml'), 'harness:\n  telemetry: off\n');
        return { args: [] as string[], env: { RCL_TELEMETRY: '' } };
      },
    },
    {
      source: 'the explicitly named config',
      expected: 'envelope',
      prepare: (repo: string) => {
        writeFileSync(join(repo, 'alt.yml'), 'harness:\n  telemetry: envelope\n');
        return { args: ['--config', 'alt.yml'], env: { RCL_TELEMETRY: '' } };
      },
    },
  ])('needs the full telemetry level from $source before any token is requested', ({ expected, prepare }) => {
    const repo = tempRepository();
    const { args, env } = prepare(repo);
    const result = runRcl(['review', 'allocator-one/rcl#42', '--attest', ...args], repo, env);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`--attest needs the telemetry level full \\(resolved: ${expected}\\)`));
  });
});

describe('rcl review — completed report output failure', () => {
  it.each(['json', 'markdown'])('retains both originals and attempts the sibling output when %s cannot be written', (failed) => {
    const repo = tempRepository();
    const dataDir = join(repo, 'private-data');
    mkdirSync(join(repo, '.harness-cli'));
    writeFileSync(join(repo, '.harness-cli', 'config.json'), '{}');
    writeFileSync(join(repo, 'change.patch'), 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
    writeFileSync(join(repo, 'config.json'), JSON.stringify({ models: ['openai/fixture'], secondaryModels: [], asyncModels: [] }));
    const jsonPath = join(repo, failed === 'json' ? 'missing/report.json' : 'report.json');
    const mdPath = join(repo, failed === 'markdown' ? 'missing/report.md' : 'report.md');
    const result = runRcl([
      'review', 'change.patch', '--config', 'config.json', '--reviewer', 'openai/fixture:general',
      '--head-sha', 'a'.repeat(40),
      '--json-file', jsonPath, '--markdown', mdPath,
    ], repo, {
      RCL_DATA_DIR: dataDir, RCL_TELEMETRY: 'findings',
      // An incomplete explicit credential pair prevents login fallback and all HTTP.
      HARNESS_API_URL: 'http://127.0.0.1:1', HARNESS_API_TOKEN: '',
      RCL_CONVERGE_TARGET: '', RCL_CONVERGE_ROUND: '', RCL_CONVERGE_ATTEMPT: '', RCL_FOR_PR: '',
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('Could not write');
    const [runId] = readdirSync(join(dataDir, 'quarantine'));
    const dir = join(dataDir, 'quarantine', runId!);
    const originalJson = readFileSync(join(dir, 'report.json'), 'utf8');
    const originalMd = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(JSON.parse(originalJson).run.id).toBe(runId);
    expect(originalMd).toContain(runId);
    expect(readFileSync(failed === 'json' ? mdPath : jsonPath, 'utf8')).toBe(failed === 'json' ? originalMd : originalJson);
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).diagnostics)
      .toContainEqual(expect.objectContaining({ path: `output.${failed === 'json' ? 'report_json' : 'report_md'}` }));
  });
});

describe('rcl review — bounded verification fallback', () => {
  it('writes a strict-severity CI report when the whole verification pass times out', async () => {
    const repo = tempRepository();
    const reportPath = join(repo, 'report.json');
    writeFileSync(
      join(repo, 'change.patch'),
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n'
    );
    writeFileSync(
      join(repo, 'config.json'),
      JSON.stringify({
        models: ['openai-compat/fixture'],
        secondaryModels: [],
        asyncModels: [],
        thresholds: { minConsensusScore: 0, minConfidence: 0 },
        gating: {
          verificationModel: 'openai-compat/fixture',
          verificationTimeout: 5_000,
          verificationPassTimeout: 100,
        },
        harness: { telemetry: 'off' },
      })
    );

    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      requests++;
      if (requests > 1) return;

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-review',
          object: 'chat.completion',
          created: 0,
          model: 'fixture',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  findings: [
                    {
                      id: 'f1',
                      file: 'a.ts',
                      startLine: 1,
                      endLine: 1,
                      severity: 'important',
                      category: 'correctness',
                      title: 'Synthetic blocking finding',
                      description: 'The fixture finding must fall back to strict severity gating.',
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runRclAsync(
        [
          'review',
          'change.patch',
          '--config',
          'config.json',
          '--reviewer',
          'openai-compat/fixture:general',
          '--head-sha',
          'a'.repeat(40),
          '--base-sha',
          'b'.repeat(40),
          '--json-file',
          reportPath,
          '--no-telemetry',
          '--ci',
        ],
        repo,
        {
          OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${port}/v1`,
          RCL_DATA_DIR: join(repo, 'rcl-data'),
        },
        5_000
      );

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(/Gating pass failed .*falling back to severity gating/i);
      expect(requests).toBe(2);
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      expect(report.run.gating.verification_pass_timeout_ms).toBe(100);
      expect(report.stats.verification).toBeUndefined();
      expect(report.findings).toEqual([
        expect.objectContaining({
          severity: 'important',
          title: 'Synthetic blocking finding',
        }),
      ]);
      expect(report.findings[0]).not.toHaveProperty('gating');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }, 10_000);
});
