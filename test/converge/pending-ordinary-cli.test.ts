import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState } from '../../src/converge/run-state.js';
import { checkpointPath } from '../../src/dispatch/checkpoint.js';

const cli = process.env.RCL_TEST_PACKAGED_CLI ||
  fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

it('previews, applies and idempotently replays an ordinary dead-owner recovery through the CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcl-ordinary-pending-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    encoding: 'utf8',
  }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  await mkdir(join(root, '.harness-cli'));
  await writeFile(join(root, '.harness-cli', 'config.json'), '{}');
  await writeFile(join(root, 'change.patch'),
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const a = 0;\n+export const a = 1;\n');
  await writeFile(join(root, 'config.json'), JSON.stringify({
    models: ['openai-compat/blocking'],
    secondaryModels: ['openai-compat/async'],
    asyncModels: ['openai-compat/async'],
    roles: ['general', 'security-auditor'],
    maxRetries: 0,
    concurrency: 2,
    timeout: 5_000,
    asyncTimeout: 5_000,
    harness: { telemetry: 'full' },
    gating: { mode: 'all-findings' },
  }));

  let providerCalls = 0;
  const providerCallsByModel = new Map<string, number>();
  const ordinaryArtifacts = new Map<string, Buffer>();
  const reviewerArtifacts = new Map<string, Buffer>();
  const reviewerDeclarations = new Map<string, { sha256: string; bytes: number }>();
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const raw = Buffer.concat(parts);
    const path = request.url!;
    const answer = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const artifactBytes = (bytes: Buffer) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream',
        'x-artifact-sha256': digest(bytes), 'cache-control': 'private, no-store',
        'content-disposition': 'attachment', 'x-content-type-options': 'nosniff' });
      response.end(bytes);
    };
    if (path === '/v1/chat/completions') {
      providerCalls++;
      const model = JSON.parse(raw.toString('utf8')).model as string;
      providerCallsByModel.set(model, (providerCallsByModel.get(model) ?? 0) + 1);
      return answer(200, { id: 'fixture', object: 'chat.completion', created: 0,
        model: 'fixture', choices: [{ index: 0, finish_reason: 'stop',
          message: { role: 'assistant', content: '{"findings":[]}' } }] });
    }
    if (path === '/api/v1/reviews/model-stats' && request.method === 'GET') {
      return answer(200, { data: { models: [] }, meta: { reviewer_recovery_protocol: 2,
        reviewer_checkpoint_plan_version: 2, reviewer_capture_version: 2,
        reviewer_provider_concurrency_version: 1, reviewer_artifact_schema: 1,
        reviewer_artifact_max_bytes: 25_000_000 } });
    }
    if (path === '/api/v1/reviews/runs' && request.method === 'POST') {
      const envelope = JSON.parse(raw.toString('utf8'));
      if (envelope.reviewer_recovery) {
        reviewerDeclarations.set(envelope.run.id, {
          sha256: envelope.reviewer_recovery.sha256,
          bytes: envelope.reviewer_recovery.bytes,
        });
      }
      return answer(201, { data: { id: envelope.run.id,
        url: `http://127.0.0.1/runs/${envelope.run.id}`,
        artifacts_expected: envelope.artifacts_declared.map((item: { kind: string }) => item.kind) } });
    }
    const artifact = path.match(/^\/api\/v1\/reviews\/runs\/([^/]+)\/artifacts\/(report_json|report_md)$/);
    if (artifact) {
      const key = `${artifact[1]}/${artifact[2]}`;
      if (request.method === 'PUT') {
        ordinaryArtifacts.set(key, raw);
        return answer(201, { data: { kind: artifact[2], sha256: digest(raw) } });
      }
      const stored = ordinaryArtifacts.get(key);
      return stored ? artifactBytes(stored) : answer(404, { error: 'not_found' });
    }
    const reviewerArtifact = path.match(/^\/api\/v1\/reviews\/runs\/([^/]+)\/reviewer-artifact$/);
    if (reviewerArtifact) {
      const runId = reviewerArtifact[1]!;
      const declaration = reviewerDeclarations.get(runId);
      if (!declaration) return answer(404, { error: 'not_found' });
      if (request.method === 'PUT') {
        reviewerArtifacts.set(runId, raw);
        return answer(201, { data: { run_id: runId, sha256: digest(raw), bytes: raw.length },
          meta: { status: 'created' } });
      }
      const stored = reviewerArtifacts.get(runId);
      return stored ? artifactBytes(stored) : answer(404, {
        error: 'reviewer_artifact_pending', data: { run_id: runId, ...declaration },
      });
    }
    if (path === '/api/v1/reviews/converge/events') {
      const events = JSON.parse(raw.toString('utf8')).events;
      return answer(200, { data: { inserted: events.length, duplicates: 0 } });
    }
    return answer(404, { error: 'unexpected_fixture_request', path });
  });

  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      TMPDIR: process.env.TMPDIR,
      NODE_NO_WARNINGS: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      RCL_NO_HARNESS_KEYS: '1',
      HARNESS_API_URL: baseUrl,
      HARNESS_API_TOKEN: 'synthetic-test-token',
      OPENAI_COMPAT_BASE_URL: `${baseUrl}/v1`,
      OPENAI_BASE_URL: `${baseUrl}/v1`,
      RCL_DATA_DIR: join(root, 'data'),
      RCL_TELEMETRY: 'full',
    };
    const run = (args: string[]) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { cwd: root, env });
      let output = '';
      child.stdout.on('data', value => { output += value; });
      child.stderr.on('data', value => { output += value; });
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('fixture CLI timeout'));
      }, 30_000);
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timeout);
        resolve({ code, output });
      });
    });
    const baseArgs = ['review', 'change.patch', '--guarded-converge',
      '--converge-target', 'ordinary-pending-fixture', '--head-sha', head,
      '--base-sha', head, '--for-pr', 'fixture/repo#42', '--evidence-required',
      '--config', 'config.json'];
    const first = await run([...baseArgs, '--json-file', 'first.json']);
    expect(first.code, first.output).toBe(0);

    const asyncDirectory = join(root, '.git', 'rcl-async');
    let asyncName: string | undefined;
    for (let attempt = 0; attempt < 100 && !asyncName; attempt++) {
      asyncName = (await readdir(asyncDirectory)).find(name => name.startsWith('result-'));
      if (!asyncName) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(asyncName).toBeDefined();
    const asyncBytes = await readFile(join(asyncDirectory, asyncName!));
    const asyncSha256 = digest(asyncBytes);
    const asyncCallsBeforeApply = providerCallsByModel.get('async') ?? 0;
    const blockingCallsBeforeApply = providerCallsByModel.get('blocking') ?? 0;
    expect(asyncCallsBeforeApply).toBeGreaterThan(0);

    const common = join(root, '.git');
    const nativePath = convergeRunStatePath(common, 'ordinary-pending-fixture');
    const native = JSON.parse(await readFile(nativePath, 'utf8'));
    const completed = native.lastLaunch;
    native.lastLaunch = { status: 'pending', attempt: completed.attempt, round: completed.round,
      headSha: completed.headSha, inputSha256: completed.inputSha256,
      startedAt: completed.startedAt, pid: 2_147_483_647 };
    native.updatedAt = new Date().toISOString();
    await writeFile(nativePath, JSON.stringify(native));

    const packagePath = join(root, 'pending-package.json');
    const preview = await run([...baseArgs, '--resume-pending', '--resume-async-sha256',
      asyncSha256, '--resume-pending-preview', packagePath]);
    expect(preview.code, preview.output).toBe(0);
    const packageSha256 = digest(await readFile(packagePath));

    const applyArgs = [...baseArgs, '--json-file', 'recovered.json', '--resume-pending',
      '--resume-async-sha256', asyncSha256, '--resume-pending-package', packagePath,
      '--resume-pending-package-sha256', packageSha256, '--retry-reason',
      'Fixture coordinator exited before durable blocking receipts.'];
    const applied = await run(applyArgs);
    expect(applied.code, applied.output).toBe(0);
    const callsAfterApply = providerCalls;
    expect(providerCallsByModel.get('async') ?? 0).toBe(asyncCallsBeforeApply);
    expect(providerCallsByModel.get('blocking') ?? 0).toBeGreaterThan(blockingCallsBeforeApply);
    expect(await loadConvergeAttemptState(common, 'ordinary-pending-fixture'))
      .toMatchObject({ cap: 20, attemptsUsed: 2 });
    const recovered = (await loadConvergeRunState(common, 'ordinary-pending-fixture'))!;
    expect(recovered).toMatchObject({ lastLaunch: { status: 'completed', attempt: 2, round: 1,
      pendingRecovery: { pendingAttempt: 1, blockingOutcome: 'unknown' } } });
    const sourceDigest = recovered.lastLaunch!.pendingRecovery!.sourceDigest;
    const archive = join(common, 'rcl-converge-pending-recovery', sourceDigest);
    expect(await readFile(join(archive, asyncSha256))).toEqual(asyncBytes);
    expect(JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))).toEqual({
      version: 1, sourceDigest, blockingOutcome: 'unknown', artifacts: [{ sha256: asyncSha256 }],
    });
    const recoveryRunId = recovered.lastLaunch!.runId!;
    const capturedBytes = await readFile(join(checkpointPath(common,
      'ordinary-pending-fixture', recoveryRunId), 'binding-captured-inputs.data'), 'utf8');
    expect(JSON.parse(capturedBytes)).not.toHaveProperty('async');
    expect(digest(capturedBytes)).toBe(recovered.lastLaunch!.pendingResume!.capturedInputsSha256);

    const replayed = await run(applyArgs);
    expect(replayed.code, replayed.output).toBe(0);
    expect(providerCalls).toBe(callsAfterApply);
    expect(providerCallsByModel.get('async') ?? 0).toBe(asyncCallsBeforeApply);
    expect(await loadConvergeAttemptState(common, 'ordinary-pending-fixture'))
      .toMatchObject({ attemptsUsed: 2 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
