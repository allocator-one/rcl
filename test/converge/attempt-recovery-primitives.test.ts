import { afterEach, expect, it, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, realpath, readFile, writeFile, rm, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { primitiveFixture, spendAndRecord, terminal } from '../fixtures/attempt-recovery-owner-child.js';
import { releasedCycleFixture, sha, uuid } from '../evidence/recovery-validation/fixtures.js';
import { claimConvergeAttempt, loadConvergeAttemptState, recordConvergeAttemptLaunch,
  recordConvergeAttemptRecoveryResume } from '../../src/converge/attempt-budget.js';
import { withNativeTarget, withOwnedNativeOperation, type NativeTargetOwnership } from '../../src/converge/target-ownership.js';
import { launchSchema } from '../../src/converge/launch-record.js';
import type { GuardedLaunchState } from '../../src/converge/launch-record.js';

const fault = vi.hoisted(() => ({
  file: '', directory: '', renamed: false, fail: false, failures: 0, synced: 0, readOnlySyncs: 0,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => { await fs.rename(...args); if (String(args[1]) === fault.file) fault.renamed = true; },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]) === fault.file && args[1] === 'r') {
        return new Proxy(handle, { get(target, property) {
          if (property === 'sync') return async () => {
            fault.readOnlySyncs++;
            throw Object.assign(new Error('Synthetic Windows read-only fsync refusal.'), { code: 'EACCES' });
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      }
      if (String(args[0]) !== fault.directory) return handle;
      return new Proxy(handle, { get(target, property) {
        if (property === 'sync') return async () => {
          if (fault.renamed && fault.fail) { fault.failures++; throw Object.assign(new Error('Synthetic primitive-directory fsync failure.'), { code: 'EIO' }); }
          await target.sync(); if (fault.renamed) fault.synced++;
        };
        const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  };
});
const roots: string[] = [], children = new Set<ChildProcess>();
async function root() { const p = await realpath(await mkdtemp(join(tmpdir(), 'rcl121-primitive-'))); roots.push(p); return p; }
async function trace(row: object) { if (process.env.RCL_PRIMITIVE_TRACE) await appendFile(process.env.RCL_PRIMITIVE_TRACE, JSON.stringify(row) + '\n'); }
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); const result = await exited; await trace({ event: 'owned-child-exit', pid: child.pid, result }); }
  children.delete(child);
}
afterEach(async () => {
  vi.restoreAllMocks(); Object.assign(fault, {
    file: '', directory: '', renamed: false, fail: false, failures: 0, synced: 0, readOnlySyncs: 0,
  });
  for (const child of children) await stop(child);
  await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
});
type Fixture = Awaited<ReturnType<typeof primitiveFixture>>;
async function childRun(f: Pick<Fixture, 'root' | 'target' | 'nativeJson' | 'native'>, mode: string) {
  const request = join(f.root, `child-${mode}-${Date.now()}.json`);
  await writeFile(request, JSON.stringify({ root: f.root, target: f.target, mode, nativeSha256: sha(f.nativeJson), cycleId: f.native.cycle.id }));
  const child = fork(fileURLToPath(new URL('../fixtures/attempt-recovery-owner-child.ts', import.meta.url)), ['--primitive-child', request],
    { execArgv: ['--import', import.meta.resolve('tsx')], env: { ...process.env }, silent: true });
  children.add(child); let stderr = ''; child.stderr!.on('data', bytes => { stderr += bytes; });
  const exited = once(child, 'exit');
  const message = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Synthetic child timeout: ${stderr}`)), 10000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Synthetic child exit ${code}: ${stderr}`)); });
  });
  await trace({ event: 'owned-child-ready', mode, pid: child.pid, message });
  expect(message.pid).toBe(child.pid);
  if (message.phase === 'complete') { expect(await exited).toEqual([0, null]); children.delete(child); await trace({ event: 'owned-child-exit', pid: child.pid, result: [0, null] }); }
  return child;
}
async function fixture(mode: 'pending' | 'completed' | 'pending-released' = 'pending') {
  const f = await primitiveFixture(await root());
  const child = await childRun(f, mode);
  if (mode === 'pending') await stop(child);
  return { ...f, child, before: (await loadConvergeAttemptState(f.root, f.target))! };
}
function accounting(state: any) { const { lastLaunch, updatedAt, ...rest } = state; return rest; }
function running(launch: GuardedLaunchState): GuardedLaunchState { return { ...launch, status: 'pending', recovery: { ...launch.recovery!, resume: { pid: process.pid, phase: 'running' } } }; }
function finished(launch: GuardedLaunchState): GuardedLaunchState { return { ...terminal(launch), recovery: { ...launch.recovery!, resume: { pid: process.pid, phase: 'finished' } } }; }
async function protectedBytes(f: Fixture) { return Promise.all([f.runPath, f.snapshotPath, f.archivePath].map(p => readFile(p, 'utf8'))); }
async function resume(f: Fixture, expected: GuardedLaunchState, next: GuardedLaunchState, extra: Record<string, unknown> = {}) {
  return withNativeTarget(f.root, f.target, owner => recordConvergeAttemptRecoveryResume(f.root, f.target,
    { expected, next, nativeSha256: sha(f.nativeJson), cycleId: f.native.cycle.id, ...extra }, owner));
}
async function delivery(f: Fixture, launch: GuardedLaunchState, mutation: any = 'delivery') {
  return withNativeTarget(f.root, f.target, owner => recordConvergeAttemptLaunch(f.root, f.target, launch, owner, mutation));
}

it('cold delivery retains the original claimant, configured M and all immutable completion fields', async () => {
  const f = await fixture('completed'), beforeNative = await protectedBytes(f), before = await readFile(f.attemptPath, 'utf8');
  const next = { ...f.before.lastLaunch!, deliveryPending: false };
  expect(next.pid).toBe(f.child.pid); expect(next.pid).not.toBe(process.pid);
  expect(next.reviewerHealth).toMatchObject({ policy: { seatCount: 3, minimumSuccessful: 3 }, successfulSeats: 2 });
  await expect(delivery(f, next, 'completion')).rejects.toThrow(/this process/);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(before);
  await delivery(f, next);
  const bytes = await readFile(f.attemptPath, 'utf8'), inode = (await stat(f.attemptPath)).ino;
  await delivery(f, next);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(bytes); expect((await stat(f.attemptPath)).ino).toBe(inode);
  const after = (await loadConvergeAttemptState(f.root, f.target))!;
  expect(after.lastLaunch).toEqual(next); expect(accounting(after)).toEqual(accounting(f.before));
  expect(await protectedBytes(f)).toEqual(beforeNative);
});

it('refuses delivery changes outside the exact completed flag across independent binding categories', async () => {
  const f = await fixture('completed'), retained = await readFile(f.attemptPath, 'utf8'), native = await protectedBytes(f);
  const changes: Record<string, (v: any) => void> = {
    run: v => { v.runId = uuid(950); }, report: v => { v.reportJsonSha256 = 'd'.repeat(64); },
    operation: v => { v.recovery.operationId = uuid(950); }, source: v => { v.recovery.sourceRunId = uuid(950); },
    claim: v => { v.recovery.originalNativeClaim.round++; }, sourceClaim: v => { v.recovery.sourceNativeClaim.attempt++; },
    originalPid: v => { v.pid = process.pid; }, currentAttempt: v => { v.attempt++; }, round: v => { v.round++; },
    input: v => { v.inputSha256 = 'e'.repeat(64); }, head: v => { v.headSha = 'e'.repeat(40); },
    time: v => { v.startedAt = '2026-01-01T00:00:00.000Z'; }, reason: v => { v.retryReason = 'different'; },
    health: v => { v.reviewerHealth.policy.fraction = 2 / 3; v.reviewerHealth.policy.minimumSuccessful = 2; },
    counters: v => { v.successfulReviews = 1; v.reviewerHealth.successfulSeats = 1; },
    terminal: v => { v.hardFailure = true; }, path: v => { v.reportPath = '/another'; }, exit: v => { v.exitCode = 1; },
  };
  for (const [kind, mutate] of Object.entries(changes)) {
    const next = structuredClone(f.before.lastLaunch!); next.deliveryPending = false; mutate(next);
    await expect(delivery(f, next), kind).rejects.toThrow();
    expect(await readFile(f.attemptPath, 'utf8'), kind).toBe(retained);
  }
  await expect(delivery(f, f.before.lastLaunch!, 'other')).rejects.toThrow(/Unsupported/);
  expect(await protectedBytes(f)).toEqual(native);
});

it('resumes in an actual new process and replays exact completion without another claim', async () => {
  const f = await fixture(), native = await protectedBytes(f), before = f.before;
  expect(before.lastLaunch).toMatchObject({ status: 'pending', pid: f.child.pid });
  const successor = await childRun(f, 'resume-complete');
  const after = (await loadConvergeAttemptState(f.root, f.target))!;
  expect(successor.pid).not.toBe(f.child.pid);
  expect(after.lastLaunch).toMatchObject({ status: 'completed', pid: f.child.pid, runId: before.lastLaunch!.runId,
    recovery: { ...before.lastLaunch!.recovery, resume: { pid: successor.pid, phase: 'finished' } } });
  expect(accounting(after)).toEqual(accounting(before)); expect(await protectedBytes(f)).toEqual(native);
  expect(after.lastLaunch!.reportJsonSha256).toBe('c'.repeat(64));
  await expect(delivery(f, { ...after.lastLaunch!, deliveryPending: false }, 'completion')).rejects.toThrow(/this process/);
}, 20000);

it('refuses resume binding substitutions before changing the original spent ledger', async () => {
  const f = await fixture(), expected = f.before.lastLaunch!, retained = await readFile(f.attemptPath, 'utf8');
  const mutations: Record<string, (v: any) => void> = {
    run: v => { v.runId = uuid(952); }, operation: v => { v.recovery.operationId = uuid(952); },
    source: v => { v.recovery.sourceRunId = uuid(952); }, rootClaim: v => { v.recovery.originalNativeClaim.round++; },
    parentClaim: v => { v.recovery.sourceNativeClaim.attempt++; }, attempt: v => { v.attempt++; }, round: v => { v.round++; },
    head: v => { v.headSha = 'd'.repeat(40); }, input: v => { v.inputSha256 = 'd'.repeat(64); },
    pid: v => { v.pid = process.pid; }, time: v => { v.startedAt = '2026-01-01T00:00:00.000Z'; },
    reason: v => { v.retryReason = 'different'; }, resumeOwner: v => { v.recovery.resume.pid = f.child.pid; },
  };
  for (const [kind, mutate] of Object.entries(mutations)) {
    const next = running(structuredClone(expected)); mutate(next);
    await expect(resume(f, expected, next), kind).rejects.toThrow(/binding_mismatch/);
    expect(await readFile(f.attemptPath, 'utf8'), kind).toBe(retained);
  }
  for (const key of ['operationId', 'runId']) {
    const missing: any = structuredClone(expected); if (key === 'operationId') delete missing.recovery.operationId; else delete missing.runId;
    await expect(resume(f, missing, running(missing))).rejects.toThrow(/binding_mismatch/);
  }
});

it('validates source, cycle, pair and archive before resume or delivery replay', async () => {
  const f = await fixture(), expected = f.before.lastLaunch!, next = running(expected), retained = await readFile(f.attemptPath, 'utf8');
  for (const extra of [{ nativeSha256: 'f'.repeat(64) }, { cycleId: uuid(959) }, { cycleId: undefined }]) {
    await expect(resume(f, expected, next, extra)).rejects.toThrow(/source_mismatch/);
    expect(await readFile(f.attemptPath, 'utf8')).toBe(retained);
  }
  await resume(f, expected, next); await resume(f, next, finished(next));
  const done = (await loadConvergeAttemptState(f.root, f.target))!.lastLaunch!, doneBytes = await readFile(f.attemptPath, 'utf8');
  const wrongPair = JSON.parse(doneBytes); wrongPair.cycle.id = uuid(959); await writeFile(f.attemptPath, JSON.stringify(wrongPair));
  for (const action of [() => resume(f, next, done), () => delivery(f, done)]) await expect(action()).rejects.toThrow(/state_pair_mismatch/);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(JSON.stringify(wrongPair));
  await writeFile(f.attemptPath, doneBytes); await writeFile(f.archivePath, f.archiveJson + ' ');
  for (const action of [() => resume(f, next, done), () => delivery(f, done)]) await expect(action()).rejects.toThrow(/archive_changed/);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(doneBytes);
});

it('refuses a genuine unrecovered cycle source without manufacturing v3 authority', async () => {
  const p = await root(), f = await releasedCycleFixture(p), nativeJson = await readFile(f.runPath, 'utf8');
  const base = { ...f, root: p, target: f.selection.target, nativeJson };
  const child = await childRun(base, 'pending'); await stop(child);
  const state = (await loadConvergeAttemptState(p, base.target))!, retained = await readFile(f.attemptPath, 'utf8');
  await expect(withNativeTarget(p, base.target, owner => recordConvergeAttemptRecoveryResume(p, base.target,
    { expected: state.lastLaunch!, next: running(state.lastLaunch!), nativeSha256: sha(nativeJson), cycleId: f.native.cycle.id }, owner))).rejects.toThrow(/source_mismatch/);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(retained); expect(await readFile(f.runPath, 'utf8')).toBe(nativeJson);
});

it('refuses alive or unverifiable prior claimants and permits only a dead-owner continuation', async () => {
  const f = await fixture('pending-released'), expected = f.before.lastLaunch!, next = running(expected), retained = await readFile(f.attemptPath, 'utf8');
  await expect(resume(f, expected, next)).rejects.toThrow(/owner_alive/);
  const kill = process.kill.bind(process); const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === f.child.pid && signal === 0) throw Object.assign(new Error('Synthetic liveness permission refusal'), { code: 'EPERM' });
    return kill(pid, signal);
  });
  await expect(resume(f, expected, next)).rejects.toThrow(/owner_unverifiable/); spy.mockRestore();
  expect(await readFile(f.attemptPath, 'utf8')).toBe(retained);
  await stop(f.child);
  const resumeOwner = await childRun(f, 'resume-running-released');
  const owned = (await loadConvergeAttemptState(f.root, f.target))!.lastLaunch!;
  await expect(resume(f, owned, running(owned))).rejects.toThrow(/owner_alive/);
  const ownedBytes = await readFile(f.attemptPath, 'utf8');
  expect((await loadConvergeAttemptState(f.root, f.target))!.lastLaunch!.recovery!.resume!.pid).toBe(resumeOwner.pid);
  await stop(resumeOwner); await resume(f, owned, running(owned));
  expect(await readFile(f.attemptPath, 'utf8')).not.toBe(ownedBytes);
  expect(accounting((await loadConvergeAttemptState(f.root, f.target))!)).toEqual(accounting(f.before));
});

it('refuses forged, wrong-target, wrong-repository and released ownership for both primitives', async () => {
  const f = await fixture(), expected = f.before.lastLaunch!, next = running(expected), retained = await readFile(f.attemptPath, 'utf8');
  let released!: NativeTargetOwnership; await withNativeTarget(f.root, f.target, owner => { released = owner; return Promise.resolve(); });
  const request = (owner: NativeTargetOwnership) => recordConvergeAttemptRecoveryResume(f.root, f.target,
    { expected, next, nativeSha256: sha(f.nativeJson), cycleId: f.native.cycle.id }, owner);
  const flag = (owner: NativeTargetOwnership) => recordConvergeAttemptLaunch(f.root, f.target, terminal(expected), owner, 'delivery');
  for (const owner of [{ target: f.target }, released]) for (const operation of [request, flag]) await expect(operation(owner)).rejects.toThrow(/not_owned/);
  for (const [p, target] of [[await root(), f.target], [f.root, 'another-target']]) {
    let callbackCompleted = false;
    try {
      await withNativeTarget(p!, target!, async owner => {
        for (const operation of [request, flag]) await expect(operation(owner)).rejects.toThrow(/not_owned/);
        callbackCompleted = true;
      });
    } catch (error) {
      if (!callbackCompleted) throw error;
      expect(String(error)).toMatch(/not_owned|operations_failed/);
    }
    expect(callbackCompleted).toBe(true);
  }
  expect(await readFile(f.attemptPath, 'utf8')).toBe(retained);
});

it('preserves terminal immutability and rejects stale launches, unsupported transitions and later claims', async () => {
  const f = await fixture(), expected = f.before.lastLaunch!, next = running(expected);
  await expect(delivery(f, terminal(expected))).rejects.toThrow(/exact completed launch delivery flag/);
  await expect(resume(f, expected, finished(expected))).rejects.toThrow(/invalid_finish/);
  await resume(f, expected, next);
  const altered = { ...next, reportPath: '/unexpected' };
  await expect(resume(f, expected, altered)).rejects.toThrow(/stale_launch/);
  await expect(resume(f, next, { ...next, status: 'failed', reportPath: '/unexpected', recovery: { ...next.recovery!, resume: { pid: process.pid, phase: 'finished' } } })).rejects.toThrow(/invalid_finish/);
  const failed = { ...next, status: 'failed' as const, recovery: { ...next.recovery!, resume: { pid: process.pid, phase: 'finished' as const } } };
  await resume(f, next, failed); const restarted = running(failed); await resume(f, failed, restarted);
  const complete = finished(restarted); await resume(f, restarted, complete);
  const bytes = await readFile(f.attemptPath, 'utf8');
  const pending = running(complete);
  expect(launchSchema.safeParse(pending).success).toBe(false);
  delete pending.reviewerHealth;
  expect(launchSchema.parse(pending)).toEqual(pending);
  await expect(resume(f, complete, pending)).rejects.toThrow(/invalid_begin/);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(bytes);
  await expect(resume(f, restarted, { ...complete, reportJsonSha256: 'd'.repeat(64) })).rejects.toThrow(/stale_launch/);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(bytes);
  await claimConvergeAttempt({ gitCommonDir: f.root, target: f.target });
  const later = await readFile(f.attemptPath, 'utf8');
  await expect(resume(f, restarted, complete)).rejects.toThrow(/claim_mismatch/);
  await expect(delivery(f, { ...complete, deliveryPending: false })).rejects.toThrow(/latest durable attempt/);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(later);
});

it('pins nested resume and delivery inputs before an earlier owned operation drains', async () => {
  const f = await fixture(), expected = f.before.lastLaunch!, native = await protectedBytes(f);
  await withNativeTarget(f.root, f.target, async owner => {
    let release!: () => void, entered!: () => void; const ready = new Promise<void>(done => { entered = done; });
    const earlier = withOwnedNativeOperation(owner, f.root, f.target, async () => { entered(); await new Promise<void>(done => { release = done; }); });
    await ready; const request = { expected: structuredClone(expected), next: running(expected), nativeSha256: sha(f.nativeJson), cycleId: f.native.cycle.id };
    const pinned = structuredClone(request.next), action = recordConvergeAttemptRecoveryResume(f.root, f.target, request, owner);
    request.expected.recovery!.sourceRunId = uuid(959); request.next.recovery!.operationId = uuid(959); request.nativeSha256 = 'f'.repeat(64); request.cycleId = uuid(959);
    release(); await Promise.all([earlier, action]); expect((await loadConvergeAttemptState(f.root, f.target))!.lastLaunch).toEqual(pinned);
  });
  const pending = (await loadConvergeAttemptState(f.root, f.target))!.lastLaunch!; await resume(f, pending, finished(pending));
  await withNativeTarget(f.root, f.target, async owner => {
    let release!: () => void, entered!: () => void; const ready = new Promise<void>(done => { entered = done; });
    const earlier = withOwnedNativeOperation(owner, f.root, f.target, async () => { entered(); await new Promise<void>(done => { release = done; }); });
    await ready; const next = { ...(await loadConvergeAttemptState(f.root, f.target))!.lastLaunch!, deliveryPending: false };
    const pinned = structuredClone(next), action = recordConvergeAttemptLaunch(f.root, f.target, next, owner, 'delivery');
    next.reviewerHealth!.policy.minimumSuccessful = 1; next.recovery!.operationId = uuid(959);
    release(); await Promise.all([earlier, action]); expect((await loadConvergeAttemptState(f.root, f.target))!.lastLaunch).toEqual(pinned);
  });
  expect(accounting((await loadConvergeAttemptState(f.root, f.target))!)).toEqual(accounting(f.before)); expect(await protectedBytes(f)).toEqual(native);
});

it.runIf(process.platform !== 'win32').each(['delivery', 'resume-begin', 'resume-finish'] as const)
('re-establishes %s durability after rename while retaining exact committed bytes', async phase => {
  const f = await fixture(phase === 'delivery' ? 'completed' : 'pending'), original = f.before.lastLaunch!;
  let expected = original, next = phase === 'delivery' ? { ...original, deliveryPending: false } : running(original);
  if (phase === 'resume-finish') { await resume(f, expected, next); expected = next; next = finished(next); }
  const persist = () => phase === 'delivery' ? delivery(f, next) : resume(f, expected, next);
  Object.assign(fault, { file: f.attemptPath, directory: dirname(f.attemptPath), fail: true });
  await expect(persist()).rejects.toThrow(/fsync|sync|durab/);
  expect(fault.renamed).toBe(true); expect(fault.failures).toBe(1);
  const bytes = await readFile(f.attemptPath, 'utf8'), inode = (await stat(f.attemptPath)).ino;
  expect((await loadConvergeAttemptState(f.root, f.target))!.lastLaunch).toEqual(next);
  await expect(persist()).rejects.toThrow(/fsync|sync|durab/);
  expect(fault.failures + fault.readOnlySyncs).toBe(2);
  fault.fail = false; await persist(); expect(fault.readOnlySyncs).toBe(0); expect(fault.synced).toBeGreaterThan(0);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(bytes); expect((await stat(f.attemptPath)).ino).toBe(inode);
  expect(accounting((await loadConvergeAttemptState(f.root, f.target))!)).toEqual(accounting(f.before));
});

it('refuses malformed recovery metadata while retaining legacy schema compatibility', () => {
  const valid: any = { status: 'pending', attempt: 2, round: 2, headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64), startedAt: new Date().toISOString(), pid: process.pid,
    runId: uuid(931), recovery: { operationId: uuid(932), sourceRunId: uuid(401), originalNativeClaim: { attempt: 1, round: 1 }, sourceNativeClaim: { attempt: 1, round: 1 }, resume: { pid: process.pid, phase: 'running' } } };
  expect(launchSchema.parse(valid)).toEqual(valid);
  const legacy = structuredClone(valid); delete legacy.recovery.operationId; expect(launchSchema.parse(legacy)).toEqual(legacy);
  for (const mutate of [(v: any) => { v.recovery.sourceRunId = 'invalid'; }, (v: any) => { v.recovery.operationId = 'invalid'; },
    (v: any) => { v.recovery.originalNativeClaim.attempt = 0; }, (v: any) => { v.recovery.sourceNativeClaim.round = 1.5; },
    (v: any) => { v.recovery.originalNativeClaim.round = Number.MAX_SAFE_INTEGER + 1; },
    (v: any) => { v.recovery.resume.pid = 0; }, (v: any) => { v.recovery.resume.phase = 'unknown'; },
    (v: any) => { v.recovery.extra = true; }, (v: any) => { v.recovery.originalNativeClaim.extra = true; },
    (v: any) => { v.recovery.resume.extra = true; }]) {
    const corrupt = structuredClone(valid); mutate(corrupt); expect(launchSchema.safeParse(corrupt).success).toBe(false);
  }
});

for (const status of ['completed', 'failed'] as const) {
  it.each(['run', 'operation', 'drop-recovery'] as const)(`preserves prebound identity on ${status} rather than accepting %s replacement`, async kind => {
    const f = await primitiveFixture(await root()), pending = await spendAndRecord(f.root, f.target, 'pending');
    const before = await readFile(f.attemptPath, 'utf8'), native = await protectedBytes(f);
    const next = status === 'completed' ? terminal(pending) : { ...pending, status };
    if (kind === 'run') next.runId = uuid(971);
    else if (kind === 'operation') next.recovery = { ...next.recovery!, operationId: uuid(971) };
    else delete next.recovery;
    await expect(delivery(f, next, 'completion')).rejects.toThrow(/completion.*pending launch/i);
    expect(await readFile(f.attemptPath, 'utf8')).toBe(before); expect(await protectedBytes(f)).toEqual(native);
  });
}

it('retains exact prebound completion and lets an ordinary unbound launch learn its run ID', async () => {
  const f = await primitiveFixture(await root()), pending = await spendAndRecord(f.root, f.target, 'pending');
  const before = (await loadConvergeAttemptState(f.root, f.target))!, native = await protectedBytes(f);
  await delivery(f, terminal(pending), 'completion');
  expect((await loadConvergeAttemptState(f.root, f.target))!.lastLaunch).toEqual(terminal(pending));
  expect(accounting((await loadConvergeAttemptState(f.root, f.target))!)).toEqual(accounting(before));
  const claim = await claimConvergeAttempt({ gitCommonDir: f.root, target: f.target });
  const ordinary: GuardedLaunchState = { status: 'pending', attempt: claim.attempt, round: 2, headSha: 'a'.repeat(40),
    inputSha256: 'b'.repeat(64), startedAt: new Date().toISOString(), pid: process.pid };
  await delivery(f, ordinary, 'completion');
  await delivery(f, terminal(ordinary), 'completion');
  expect((await loadConvergeAttemptState(f.root, f.target))!.lastLaunch).toEqual(terminal(ordinary));
  expect(await protectedBytes(f)).toEqual(native);
});

it('does not let an ordinary pending launch acquire a recovery identity at completion', async () => {
  const f = await primitiveFixture(await root()), claim = await claimConvergeAttempt({ gitCommonDir: f.root, target: f.target });
  const pending: GuardedLaunchState = { status: 'pending', attempt: claim.attempt, round: 2, headSha: 'a'.repeat(40),
    inputSha256: 'b'.repeat(64), startedAt: new Date().toISOString(), pid: process.pid };
  await delivery(f, pending, 'completion'); const bytes = await readFile(f.attemptPath, 'utf8');
  const next = { ...terminal(pending), recovery: { operationId: uuid(972), sourceRunId: uuid(401),
    originalNativeClaim: { attempt: 1, round: 1 }, sourceNativeClaim: { attempt: 1, round: 1 } } };
  await expect(delivery(f, next, 'completion')).rejects.toThrow(/completion.*pending launch/i);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(bytes);
});
