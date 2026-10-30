import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { claimConvergeAttempt, convergeAttemptStatePath, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState } from '../../src/converge/run-state.js';
import { prepareFreshReview, readFreshReviewOperation } from '../../src/converge/fresh-review.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { captureProcessIdentity } from '../../src/converge/process-identity.js';
import { ordinaryCheckpointNamespace } from '../../src/converge/launch-guard.js';
import { checkpointPath } from '../../src/dispatch/checkpoint.js';
import { serializeRecoveryDocument } from '../../src/evidence/original-run/journal.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';
import { applyFreshReviewClose, freshReviewCloseAuditPath, previewFreshReviewClose } from '../../src/converge/fresh-review-close.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

/** The identity of a process that has exited, as a launch recorded it while it ran. */
async function deadProcessIdentity() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)']);
  const identity = await captureProcessIdentity(child.pid!);
  await new Promise(resolve => { child.on('exit', resolve); child.kill('SIGKILL'); });
  return identity;
}

/**
 * A fresh-review operation whose first launch claimed attempt 1, recorded its
 * pending launch and journal, and died before any reviewer result: the state
 * an interrupted `--start-over` leaves behind.
 */
async function diedFixture(options: { results?: string[]; gitCommonDir?: string } = {}) {
  const gitCommonDir = options.gitCommonDir ?? await mkdtemp(join(tmpdir(), 'rcl-fresh-close-'));
  if (!options.gitCommonDir) roots.push(gitCommonDir);
  const target = 'rcl-42', headSha = 'a'.repeat(40), inputSha256 = 'b'.repeat(64), packetSha256 = 'c'.repeat(64);
  let active: import('../../src/converge/review-cycle.js').ReviewCycleReceipt | null = null;
  const cycleRemote = { repo: 'allocator-one/rcl', prNumber: 42, url: 'https://harness.example',
    current: vi.fn(async () => active),
    start: vi.fn(async (request: import('../../src/converge/review-cycle.js').ReviewCycleRequest) => {
      active = { ...request, id: randomUUID(), inserted_at: new Date().toISOString() }; return active;
    }) };
  const fresh = await withNativeTarget(gitCommonDir, target, async ownership => {
    const prepared = await prepareFreshReview({ gitCommonDir, target, headSha, remote: cycleRemote, ownership });
    await claimConvergeAttempt({ gitCommonDir, target, ownership, freshReviewOperation: prepared.operationId });
    return prepared;
  });
  const processIdentity = await deadProcessIdentity();
  const runPath = convergeRunStatePath(gitCommonDir, target);
  const run = JSON.parse(await readFile(runPath, 'utf8'));
  await writeFile(runPath, JSON.stringify({ ...run, lastLaunch: { status: 'pending', attempt: 1, round: 1, headSha, inputSha256,
    startedAt: new Date().toISOString(), pid: processIdentity.pid, processIdentity,
    ordinaryInputs: { version: 1, packetSha256, baseSha: 'd'.repeat(40) } } }));
  const checkpoint = checkpointPath(gitCommonDir, target, ordinaryCheckpointNamespace(packetSha256));
  for (const child of ['events', 'results']) await mkdir(join(checkpoint, child), { recursive: true, mode: 0o700 });
  await writeFile(join(checkpoint, 'plan.json'), '{}');
  for (const name of options.results ?? []) await writeFile(join(checkpoint, 'results', name), '{}');
  return { gitCommonDir, target, headSha, inputSha256, fresh, cycleRemote, runPath,
    attemptsPath: convergeAttemptStatePath(gitCommonDir, target), manifestPath: join(gitCommonDir, 'close-manifest.json') };
}

async function preview(f: Awaited<ReturnType<typeof diedFixture>>) {
  const manifest = await previewFreshReviewClose({ target: f.target, operationId: f.fresh.operationId }, f.gitCommonDir);
  const bytes = serializeRecoveryDocument(manifest);
  await writeFile(f.manifestPath, bytes);
  return { manifest, manifestSha256: sha256(bytes) };
}

it('closes an operation whose launch died before any report, changing no accounting', async () => {
  const f = await diedFixture();
  const runBefore = await readFile(f.runPath), attemptsBefore = await readFile(f.attemptsPath);
  const { manifest, manifestSha256 } = await preview(f);
  expect(manifest).toMatchObject({ kind: 'rcl-fresh-review-close', freshOperationId: f.fresh.operationId, cycleId: f.fresh.cycle.id,
    launch: { attempt: 1, round: 1 }, evidence: { process: 'dead', admittedRounds: 0, checkpoint: { present: true, results: 0, events: 0 } },
    disposition: { kind: 'died_before_report', accounting: 'unchanged' } });

  expect(await applyFreshReviewClose({ manifest: f.manifestPath, manifestSha256 }, f.gitCommonDir)).toBe('closed');

  const operation = (await readFreshReviewOperation(f.gitCommonDir, f.target))!.operation;
  expect(operation).toMatchObject({ phase: 'terminal',
    closure: { kind: 'died_before_report', auditId: manifest.auditId, manifestSha256 } });
  expect(await readFile(f.runPath)).toEqual(runBefore);
  expect(await readFile(f.attemptsPath)).toEqual(attemptsBefore);
  const audit = freshReviewCloseAuditPath(f.gitCommonDir, f.target, manifest.auditId);
  expect((await readdir(audit)).sort()).toEqual(['attempts-before.json', 'complete.json', 'manifest.json', 'operation-before.json', 'run-before.json']);
  expect(await readFile(join(audit, 'run-before.json'))).toEqual(runBefore);
  expect(await applyFreshReviewClose({ manifest: f.manifestPath, manifestSha256 }, f.gitCommonDir)).toBe('already_closed');
});

it('lets a later explicit fresh review start a new cycle that keeps the dead attempt as history', async () => {
  const f = await diedFixture();
  const { manifestSha256 } = await preview(f);
  await applyFreshReviewClose({ manifest: f.manifestPath, manifestSha256 }, f.gitCommonDir);
  const run = vi.fn(async () => ({ runId: randomUUID(), reportJsonSha256: 'e'.repeat(64), successfulReviews: 2, totalReviews: 2, deliveryPending: false }));

  await guardReviewLaunch({ gitCommonDir: f.gitCommonDir, target: f.target, headSha: 'f'.repeat(40), inputSha256: f.inputSha256,
    validate: async () => {}, run, startOver: true, cycleRemote: f.cycleRemote });

  const state = await loadConvergeRunState(f.gitCommonDir, f.target);
  expect(state!.cycle).toMatchObject({ previousCycleId: f.fresh.cycle.id, history: { attempts: 1, rounds: 0 } });
  expect(await loadConvergeAttemptState(f.gitCommonDir, f.target)).toMatchObject({ attemptsUsed: 1, cycle: { id: state!.cycle!.id } });
  expect(run).toHaveBeenCalledTimes(1);
});

it('refuses while the launching process is still alive', async () => {
  const f = await diedFixture();
  await expect(previewFreshReviewClose({ target: f.target, operationId: f.fresh.operationId }, f.gitCommonDir,
    { inspectProcess: async () => 'alive' })).rejects.toThrow('fresh_close_process_alive');
  await expect(previewFreshReviewClose({ target: f.target, operationId: f.fresh.operationId }, f.gitCommonDir,
    { inspectProcess: async () => 'unverifiable' })).rejects.toThrow('fresh_close_process_unverifiable');
});

it('refuses a launch whose council journaled a reviewer result', async () => {
  const f = await diedFixture({ results: ['cell-1-attempt-1.json'] });
  await expect(previewFreshReviewClose({ target: f.target, operationId: f.fresh.operationId }, f.gitCommonDir))
    .rejects.toThrow('fresh_close_results_present');
});

it('refuses a cycle that admitted a round', async () => {
  const f = await diedFixture();
  const run = JSON.parse(await readFile(f.runPath, 'utf8'));
  await writeFile(f.runPath, JSON.stringify({ ...run, rounds: [{ round: 1, runId: randomUUID(),
    counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } }] }));
  await expect(previewFreshReviewClose({ target: f.target, operationId: f.fresh.operationId }, f.gitCommonDir))
    .rejects.toThrow('fresh_close_round_admitted');
});

it('refuses an apply once the native state moved after the preview', async () => {
  const f = await diedFixture();
  const { manifestSha256 } = await preview(f);
  const run = JSON.parse(await readFile(f.runPath, 'utf8'));
  await writeFile(f.runPath, JSON.stringify({ ...run, updatedAt: new Date(Date.now() + 1000).toISOString() }));
  await expect(applyFreshReviewClose({ manifest: f.manifestPath, manifestSha256 }, f.gitCommonDir)).rejects.toThrow('fresh_close_state_changed');
  expect((await readFreshReviewOperation(f.gitCommonDir, f.target))!.operation.phase).toBe('active');
});

it('refuses a manifest whose bytes differ from the reviewed digest', async () => {
  const f = await diedFixture();
  await preview(f);
  await expect(applyFreshReviewClose({ manifest: f.manifestPath, manifestSha256: '0'.repeat(64) }, f.gitCommonDir))
    .rejects.toThrow('fresh_close_manifest_digest_mismatch');
});

it('previews and applies the close from the command line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcl-fresh-close-cli-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  const f = await diedFixture({ gitCommonDir: join(root, '.git') });
  const cli = process.env.RCL_TEST_PACKAGED_CLI || fileURLToPath(new URL('../../dist/index.js', import.meta.url));
  const run = (args: string[]) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, NODE_NO_WARNINGS: '1', RCL_TELEMETRY: 'off', RCL_NO_HARNESS_KEYS: '1' } });
  const manifest = join(root, 'close.json');

  const previewed = JSON.parse(run(['converge-close-fresh', '--preview', '--target', f.target, '--operation', f.fresh.operationId,
    '--manifest', manifest, '--json']));
  expect(previewed).toMatchObject({ mode: 'preview', accounting: 'unchanged' });
  expect(previewed.manifestSha256).toBe(sha256(await readFile(manifest)));

  const applied = JSON.parse(run(['converge-close-fresh', '--apply', '--manifest', manifest, '--manifest-sha256', previewed.manifestSha256, '--json']));
  expect(applied).toMatchObject({ mode: 'apply', result: 'closed' });
  expect((await readFreshReviewOperation(join(root, '.git'), f.target))!.operation.phase).toBe('terminal');
}, 60_000);
