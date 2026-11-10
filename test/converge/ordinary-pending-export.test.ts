import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportOrdinaryPendingPackage, retainOrdinaryLaunchInputs } from '../../src/converge/ordinary-pending-export.js';
import { guardedInputSha256, sha256Hex } from '../../src/report/run-header.js';
import { claimConvergeAttempt, convergeAttemptStatePath } from '../../src/converge/attempt-budget.js';
import { convergeRunStatePath } from '../../src/converge/run-state.js';
import { retainGuardedInput, restoreGuardedInput, MAX_GUARDED_INPUT_CAPACITY } from '../../src/converge/guarded-input-retention.js';
import { ordinaryPendingGuardedInput } from '../../src/converge/ordinary-pending-package.js';

const fault = vi.hoisted(() => ({ partialWrite: false, directoryMode: null as number | null, windowsDirectoryOpen: false, windowsFileFlags: false }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, constants: { ...fs.constants,
    get O_NOFOLLOW() { return fault.windowsFileFlags ? undefined : fs.constants.O_NOFOLLOW; },
    get O_NONBLOCK() { return fault.windowsFileFlags ? undefined : fs.constants.O_NONBLOCK; },
  } };
});
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const info = await fs.lstat(...args);
      if (fault.directoryMode !== null && String(args[0]).replaceAll('\\', '/').endsWith('/rcl-ordinary-inputs')) {
        return new Proxy(info, { get(target, property, receiver) {
          if (property === 'mode') return fault.directoryMode;
          if (property === 'uid' && fault.windowsDirectoryOpen) return 0;
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      }
      return info;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      if (fault.windowsDirectoryOpen && args[1] === 'r' && (await fs.stat(args[0])).isDirectory()) {
        throw Object.assign(new Error('simulated Windows directory open refusal'), { code: 'EPERM' });
      }
      const handle = await fs.open(...args);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => {
        if (fault.partialWrite && String(args[0]).includes('rcl-ordinary-inputs')) {
          fault.partialWrite = false;
          await write('{"version":');
          throw new Error('simulated interrupted write');
        }
        return write(...values);
      };
      return handle;
    } };
});

const dirs: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(async () => {
  fault.partialWrite = false;
  fault.directoryMode = null;
  fault.windowsDirectoryOpen = false;
  fault.windowsFileFlags = false;
  Object.defineProperty(process, 'platform', platform);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('ordinary launch input retention', () => {
  it('retains ordinary inputs with Windows directory permissions and no directory fsync', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'ordinary-windows-retention-')); dirs.push(gitCommonDir);
    const options = { gitCommonDir, target: 'owner-repo-1', headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40), guardedInput: { head: 'a'.repeat(40), kind: 'pr' }, attempt: 1, round: 1 };
    // Simulate Node's Windows stat result, not Windows ACL qualification.
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    fault.directoryMode = 0o40777;
    fault.windowsDirectoryOpen = true;
    fault.windowsFileFlags = true;
    const retained = await retainOrdinaryLaunchInputs(options);
    const bytes = await readFile(retained.path, 'utf8');
    const packet = JSON.parse(bytes);
    expect(packet.version).toBe(2);
    expect(restoreGuardedInput(packet.guardedInput)).toEqual(options.guardedInput);
    expect(retained.sha256).toBe(sha256Hex(bytes));
    expect(await retainOrdinaryLaunchInputs(options)).toEqual(retained);
    expect(await readFile(retained.path, 'utf8')).toBe(bytes);
    if (platform.value !== 'win32') expect((await stat(retained.path)).mode & 0o777).toBe(0o600);
  });

  it('refuses unsafe POSIX directory permission bits before publishing ordinary inputs', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'ordinary-posix-retention-')); dirs.push(gitCommonDir);
    const options = { gitCommonDir, target: 'owner-repo-1', headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40), guardedInput: { head: 'a'.repeat(40), kind: 'pr' }, attempt: 1, round: 1 };
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    fault.directoryMode = 0o40755;
    await expect(retainOrdinaryLaunchInputs(options)).rejects.toThrow('ordinary_retained_input_directory_unsafe');
    expect(await readdir(join(gitCommonDir, 'rcl-ordinary-inputs'))).toEqual([]);
  });

  it('refuses to export a pending bound-fix recovery claim as an ordinary launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ordinary-bound-fix-')); dirs.push(root);
    const gitCommonDir = join(root, 'native');
    await mkdir(gitCommonDir);
    const target = 'owner-repo-1', headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
    const descriptor = { model: 'openai/async', role: 'general', provider: 'openai' };
    const guardedInput = { head: headSha, kind: 'pr', repo: 'owner/repo', pr: 1,
      diff: 'c'.repeat(64), config: 'd'.repeat(64),
      roster: [{ ...descriptor, lane: 'async' }], prompts: [], asyncRoles: [{ name: 'general' }] };
    const inputSha256 = guardedInputSha256(guardedInput);
    await claimConvergeAttempt({ gitCommonDir, target, recordPid: 999_999 });
    await claimConvergeAttempt({ gitCommonDir, target, recordPid: 999_999,
      beforeClaim: async () => ({ boundFixRecoverySource: { version: 1, runId: '019921a0-0000-7000-8000-000000000002',
        target, repo: 'owner/repo', prNumber: 1, headSha, inputSha256, round: 1, attempt: 1,
        verifiedAt: '2026-10-02T00:00:00.000Z', serverProof: { status: 'fixes_pending',
          conclusive: true, actionableCount: 0, classificationPending: false, legacyPendingCount: 0,
          statusSha256: 'e'.repeat(64), runSha256: 'f'.repeat(64) } } }) });
    const nativePath = convergeRunStatePath(gitCommonDir, target);
    await mkdir(join(gitCommonDir, 'rcl-converge-runs'), { recursive: true });
    await writeFile(nativePath, JSON.stringify({ version: 1, target, roundCap: 15, rounds: [],
      findings: {}, updatedAt: '2026-10-02T00:00:00.000Z', lastLaunch: { status: 'pending',
        attempt: 2, round: 2, headSha, inputSha256, startedAt: '2026-10-02T00:00:00.000Z', pid: 999_999 } }));
    const asyncStoreDir = join(root, 'async');
    await mkdir(asyncStoreDir);
    const asyncPath = join(asyncStoreDir, 'result-bound-fix-fixture.json');
    const asyncBytes = JSON.stringify({ ...descriptor, status: 'success', findings: [], raw: '', durationMs: 1, async: true });
    await writeFile(asyncPath, asyncBytes);
    const attemptPath = convergeAttemptStatePath(gitCommonDir, target);
    const nativeBefore = await readFile(nativePath), attemptsBefore = await readFile(attemptPath);
    expect(JSON.parse(attemptsBefore.toString()).attempts[1].boundFixRecoverySource)
      .toMatchObject({ target, attempt: 1, headSha, inputSha256 });
    const path = join(root, 'pending.json');
    await expect(exportOrdinaryPendingPackage({ gitCommonDir, target, headSha, baseSha,
      expectedBaseSha: baseSha, guardedInput, asyncStoreDir, asyncTargetKey: 'bound-fix',
      asyncDescriptors: [descriptor], path, preview: false })).rejects.toThrow('pending_export_input_mismatch');
    expect(await readFile(nativePath)).toEqual(nativeBefore);
    expect(await readFile(attemptPath)).toEqual(attemptsBefore);
    expect(await readFile(asyncPath, 'utf8')).toBe(asyncBytes);
    expect(await readdir(root)).not.toContain('pending.json');
  });

  it('refuses repeated async descriptor bytes that would exceed the recovery package ceiling', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'ordinary-descriptor-boundary-')); dirs.push(gitCommonDir);
    const descriptor = { model: 'openai/' + 'x'.repeat(9 * 1024 * 1024), role: 'general', provider: 'openai' };
    const guardedInput = { head: 'a'.repeat(40), kind: 'pr',
      roster: [{ ...descriptor, lane: 'async' }], prompts: [] };
    const options = { gitCommonDir, target: 'owner-repo-1', headSha: guardedInput.head,
      baseSha: 'b'.repeat(40), guardedInput, attempt: 1, round: 1,
      // One async seat reviewing two chunks repeats its identifier in two artifacts.
      asyncDescriptors: [descriptor, descriptor] };
    const retainedBytes = JSON.stringify({ version: 2, target: options.target, headSha: options.headSha,
      baseSha: options.baseSha, attempt: 1, round: 1, inputSha256: guardedInputSha256(guardedInput),
      guardedInput: retainGuardedInput(guardedInput) }, null, 2) + '\n';
    expect(Buffer.byteLength(retainedBytes, 'utf8')).toBeLessThan(20 * 1024 * 1024);
    await expect(retainOrdinaryLaunchInputs(options)).rejects.toThrow('retained_review_work_too_large');
    expect(await readdir(gitCommonDir)).toEqual([]);
  }, 20_000);

  it('exports a legacy v1 raw retained capture into the compact pending-package format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ordinary-legacy-capture-')); dirs.push(root);
    const gitCommonDir = join(root, 'native');
    await mkdir(gitCommonDir);
    const target = 'owner-repo-1', headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
    const descriptor = { model: 'openai/async', role: 'general', provider: 'openai' };
    const guardedInput = { head: headSha, kind: 'pr', repo: 'owner/repo', pr: 1,
      diff: 'c'.repeat(64), config: 'd'.repeat(64),
      roster: [{ ...descriptor, lane: 'async' }], prompts: [], asyncRoles: [{ name: 'general' }] };
    const inputSha256 = guardedInputSha256(guardedInput);
    await claimConvergeAttempt({ gitCommonDir, target, recordPid: 999_999 });

    const legacyPacket = { version: 1, target, headSha, baseSha, attempt: 1, round: 1,
      inputSha256, guardedInput };
    const legacyBytes = JSON.stringify(legacyPacket, null, 2) + '\n';
    const packetSha256 = sha256Hex(legacyBytes);
    const captureDir = join(gitCommonDir, 'rcl-ordinary-inputs');
    await mkdir(captureDir, { mode: 0o700 });
    const namespace = sha256Hex(JSON.stringify([target, null]));
    await writeFile(join(captureDir, `${namespace}-attempt-1-${packetSha256}.json`), legacyBytes,
      { mode: 0o600 });

    await mkdir(join(gitCommonDir, 'rcl-converge-runs'));
    await writeFile(convergeRunStatePath(gitCommonDir, target), JSON.stringify({ version: 1, target,
      roundCap: 15, rounds: [], findings: {}, updatedAt: '2026-10-04T00:00:00.000Z',
      lastLaunch: { status: 'pending', attempt: 1, round: 1, headSha, inputSha256,
        startedAt: '2026-10-04T00:00:00.000Z', pid: 999_999,
        ordinaryInputs: { version: 1, packetSha256, baseSha } } }));

    const asyncStoreDir = join(root, 'async');
    await mkdir(asyncStoreDir);
    const retainedBytes = JSON.stringify({ ...descriptor, status: 'success', findings: [], raw: '',
      durationMs: 1, async: true });
    await writeFile(join(asyncStoreDir, 'result-legacy-fixture.json'), retainedBytes);
    const outputPath = join(root, 'pending.json');
    const result = await exportOrdinaryPendingPackage({ gitCommonDir, target, headSha, baseSha,
      expectedBaseSha: baseSha, guardedInput, asyncStoreDir, asyncTargetKey: 'legacy',
      asyncDescriptors: [descriptor], path: outputPath, preview: false });

    expect(result.baseBinding).toBe('retained-launch-inputs');
    const exportedBytes = await readFile(outputPath, 'utf8');
    const exported = JSON.parse(exportedBytes);
    expect(result.packageSha256).toBe(sha256Hex(exportedBytes));
    expect(exported.guardedInputRepresentation)
      .toEqual({ version: 1, encoding: 'json-string-table-v1' });
    expect(ordinaryPendingGuardedInput(exported)).toEqual(guardedInput);
    expect(exported.guardedInput).toEqual(retainGuardedInput(guardedInput));

    const changedInput = { ...guardedInput, config: 'e'.repeat(64) };
    const changedPacket = { ...legacyPacket, inputSha256: guardedInputSha256(changedInput),
      guardedInput: changedInput };
    const changedBytes = JSON.stringify(changedPacket, null, 2) + '\n';
    const changedSha256 = sha256Hex(changedBytes);
    await writeFile(join(captureDir, `${namespace}-attempt-1-${changedSha256}.json`), changedBytes,
      { mode: 0o600 });
    const native = JSON.parse(await readFile(convergeRunStatePath(gitCommonDir, target), 'utf8'));
    native.lastLaunch.ordinaryInputs.packetSha256 = changedSha256;
    await writeFile(convergeRunStatePath(gitCommonDir, target), JSON.stringify(native));
    await expect(exportOrdinaryPendingPackage({ gitCommonDir, target, headSha, baseSha,
      expectedBaseSha: baseSha, guardedInput, asyncStoreDir, asyncTargetKey: 'legacy',
      asyncDescriptors: [descriptor], path: join(root, 'changed-pending.json'), preview: true }))
      .rejects.toThrow('pending_export_retained_input_mismatch');
  });

  it('accepts the 20 MiB byte boundary and refuses one extra byte before publishing any capture', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'ordinary-size-boundary-')); dirs.push(gitCommonDir);
    const guardedInput = { head: 'a'.repeat(40), kind: 'pr', prompts: [{ system: '', user: '€' }] };
    const options = { gitCommonDir, target: 'owner-repo-1', headSha: guardedInput.head,
      baseSha: 'b'.repeat(40), guardedInput, attempt: 1, round: 1 };
    const probePacket = JSON.stringify({ version: 2, target: options.target, headSha: options.headSha,
      baseSha: options.baseSha, attempt: 1, round: 1, inputSha256: guardedInputSha256(guardedInput),
      guardedInput: retainGuardedInput(guardedInput) }, null, 2) + '\n';
    const limit = 20 * 1024 * 1024;
    const available = limit - Buffer.byteLength(probePacket, 'utf8');
    // A byte limit must account for UTF-8, not the shorter JS string length.
    guardedInput.prompts[0]!.user += '€'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3);
    const retained = await retainOrdinaryLaunchInputs(options);
    expect((await stat(retained.path)).size).toBe(limit);
    expect(await retainOrdinaryLaunchInputs(options)).toEqual(retained);
    const directory = join(gitCommonDir, 'rcl-ordinary-inputs');
    const before = await readdir(directory);
    guardedInput.prompts[0]!.user += 'x';
    await expect(retainOrdinaryLaunchInputs(options)).rejects.toThrow('retained_review_work_too_large');
    expect(await readdir(directory)).toEqual(before);
    expect((await stat(retained.path)).size).toBe(limit);
  }, 20_000);

  it('admits a selected encoded budget above 20 MiB and binds it in immutable packet bytes', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'ordinary-opted-size-')); dirs.push(gitCommonDir);
    const guardedInput = { head: 'a'.repeat(40), kind: 'pr',
      prompts: [{ system: 'review', user: 'x'.repeat(21 * 1024 * 1024) }] };
    const options = { gitCommonDir, target: 'owner-repo-1', headSha: guardedInput.head,
      baseSha: 'b'.repeat(40), guardedInput, attempt: 1, round: 1 };
    await expect(retainOrdinaryLaunchInputs(options)).rejects.toThrow('retained_review_work_too_large');
    expect(await readdir(gitCommonDir)).toEqual([]);
    const first = await retainOrdinaryLaunchInputs({ ...options,
      guardedInputCapacity: MAX_GUARDED_INPUT_CAPACITY });
    const bytes = await readFile(first.path, 'utf8');
    expect(Buffer.byteLength(bytes)).toBeGreaterThan(20 * 1024 * 1024);
    expect(JSON.parse(bytes).guardedInput.capacity).toEqual(MAX_GUARDED_INPUT_CAPACITY);
    const narrower = { ...MAX_GUARDED_INPUT_CAPACITY, retainedBytes: 24 * 1024 * 1024 };
    const second = await retainOrdinaryLaunchInputs({ ...options, guardedInputCapacity: narrower });
    expect(second.path).not.toBe(first.path);
    expect(await readFile(first.path, 'utf8')).toBe(bytes);
    await expect(retainOrdinaryLaunchInputs({ ...options,
      guardedInputCapacity: { ...narrower, retainedBytes: 21 * 1024 * 1024 } }))
      .rejects.toThrow('retained_review_work_too_large');
  }, 30_000);

  it('preserves the authenticated selected capacity when exporting a pending capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ordinary-opted-export-')); dirs.push(root);
    const gitCommonDir = join(root, 'native'); await mkdir(gitCommonDir);
    const target = 'owner-repo-1', headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
    const descriptor = { model: 'openai/async', role: 'general', provider: 'openai' };
    const guardedInput = { head: headSha, kind: 'pr', repo: 'owner/repo', pr: 1,
      diff: 'c'.repeat(64), config: 'd'.repeat(64),
      roster: [{ ...descriptor, lane: 'async' }], prompts: [], asyncRoles: [{ name: 'general' }] };
    const inputSha256 = guardedInputSha256(guardedInput);
    const retained = await retainOrdinaryLaunchInputs({ gitCommonDir, target, headSha, baseSha,
      guardedInput, attempt: 1, round: 1, guardedInputCapacity: MAX_GUARDED_INPUT_CAPACITY });
    await claimConvergeAttempt({ gitCommonDir, target, recordPid: 999_999 });
    await mkdir(join(gitCommonDir, 'rcl-converge-runs'));
    await writeFile(convergeRunStatePath(gitCommonDir, target), JSON.stringify({ version: 1, target,
      roundCap: 15, rounds: [], findings: {}, updatedAt: '2026-10-04T00:00:00.000Z',
      lastLaunch: { status: 'pending', attempt: 1, round: 1, headSha, inputSha256,
        startedAt: '2026-10-04T00:00:00.000Z', pid: 999_999,
        ordinaryInputs: { version: 1, packetSha256: retained.sha256, baseSha } } }));
    const asyncStoreDir = join(root, 'async'); await mkdir(asyncStoreDir);
    await writeFile(join(asyncStoreDir, 'result-opted-fixture.json'), JSON.stringify({ ...descriptor,
      status: 'success', findings: [], raw: '', durationMs: 1, async: true }));
    const options = { gitCommonDir, target, headSha, baseSha, expectedBaseSha: baseSha,
      guardedInput, asyncStoreDir, asyncTargetKey: 'opted', asyncDescriptors: [descriptor],
      path: join(root, 'pending.json'), preview: false };
    const receipt = await exportOrdinaryPendingPackage({ ...options,
      guardedInputCapacity: MAX_GUARDED_INPUT_CAPACITY });
    const bytes = await readFile(options.path, 'utf8');
    const packet = JSON.parse(bytes);
    expect(receipt.packageSha256).toBe(sha256Hex(bytes));
    expect(packet.guardedInput.capacity).toEqual(MAX_GUARDED_INPUT_CAPACITY);
    expect(ordinaryPendingGuardedInput(packet)).toEqual(guardedInput);
    await expect(exportOrdinaryPendingPackage({ ...options, preview: true,
      guardedInputCapacity: { ...MAX_GUARDED_INPUT_CAPACITY, retainedBytes: 32 * 1024 * 1024 } }))
      .rejects.toThrow('pending_export_retained_input_mismatch');
  });

  it('preserves the abandoned capture when only the base changes before the claim', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'ordinary-base-orphan-')); dirs.push(gitCommonDir);
    const options = { gitCommonDir, target: 'owner-repo-1', headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40), guardedInput: { head: 'a'.repeat(40), kind: 'pr' }, attempt: 1, round: 1 };
    const { path: firstPath } = await retainOrdinaryLaunchInputs(options);
    const firstBytes = await readFile(firstPath, 'utf8');
    const movedBase = { ...options, baseSha: 'c'.repeat(40) };
    expect(guardedInputSha256(movedBase.guardedInput)).toBe(guardedInputSha256(options.guardedInput));
    const { path: nextPath } = await retainOrdinaryLaunchInputs(movedBase);
    expect(nextPath).not.toBe(firstPath);
    expect(await readFile(firstPath, 'utf8')).toBe(firstBytes);
    expect(JSON.parse(await readFile(nextPath, 'utf8')).baseSha).toBe(movedBase.baseSha);
  });

  it('does not publish partial bytes and allows a retry after an interrupted preclaim write', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'ordinary-torn-orphan-')); dirs.push(gitCommonDir);
    const options = { gitCommonDir, target: 'owner-repo-1', headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40), guardedInput: { head: 'a'.repeat(40), kind: 'pr' }, attempt: 1, round: 1 };
    fault.partialWrite = true;
    await expect(retainOrdinaryLaunchInputs(options)).rejects.toThrow('simulated interrupted write');
    const directory = join(gitCommonDir, 'rcl-ordinary-inputs');
    const interrupted = await readdir(directory);
    expect(interrupted.filter(name => name.endsWith('.json'))).toEqual([]);
    const { path } = await retainOrdinaryLaunchInputs(options);
    expect(restoreGuardedInput(JSON.parse(await readFile(path, 'utf8')).guardedInput))
      .toEqual(options.guardedInput);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('preserves unspent captures while allowing changed head and config at the same upcoming attempt', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'ordinary-orphan-')); dirs.push(gitCommonDir);
    const options = { gitCommonDir, target: 'owner-repo-1', headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40), guardedInput: { head: 'a'.repeat(40), kind: 'pr', config: 'c'.repeat(64) },
      attempt: 1, round: 1 };
    // The coordinator exits after this preclaim capture; no attempt has been spent.
    const { path: originalPath } = await retainOrdinaryLaunchInputs(options);
    const originalBytes = await readFile(originalPath, 'utf8');
    const changedHead = { ...options, headSha: 'd'.repeat(40),
      guardedInput: { ...options.guardedInput, head: 'd'.repeat(40) } };
    const { path: headPath } = await retainOrdinaryLaunchInputs(changedHead);
    const changedConfig = { ...changedHead,
      guardedInput: { ...changedHead.guardedInput, config: 'e'.repeat(64) } };
    const { path: committedPath } = await retainOrdinaryLaunchInputs(changedConfig);
    expect(new Set([originalPath, headPath, committedPath]).size).toBe(3);
    expect(await readFile(originalPath, 'utf8')).toBe(originalBytes);
    expect(JSON.parse(await readFile(headPath, 'utf8')).inputSha256)
      .toBe(guardedInputSha256(changedHead.guardedInput));
    expect(JSON.parse(await readFile(committedPath, 'utf8')).inputSha256)
      .toBe(guardedInputSha256(changedConfig.guardedInput));
    expect((await retainOrdinaryLaunchInputs(changedConfig)).path).toBe(committedPath);
  });

  it('durably retains exact input and base privately before a claim, and refuses changed retry bytes', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'ordinary-retention-')); dirs.push(gitCommonDir);
    const guardedInput = { head: 'a'.repeat(40), kind: 'pr', spec: undefined };
    const options = { gitCommonDir, target: 'owner-repo-1', headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40), guardedInput, attempt: 1, round: 1 };
    const { path } = await retainOrdinaryLaunchInputs(options);
    const bytes = await readFile(path, 'utf8');
    expect(JSON.parse(bytes)).toEqual({ version: 2, target: options.target, headSha: options.headSha,
      baseSha: options.baseSha, attempt: 1, round: 1, inputSha256: guardedInputSha256(guardedInput),
      guardedInput: retainGuardedInput({ head: guardedInput.head, kind: 'pr' }) });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await retainOrdinaryLaunchInputs(options)).toEqual({ path, sha256: sha256Hex(bytes), baseSha: options.baseSha });
    await writeFile(path, 'preserved conflicting capture');
    await expect(retainOrdinaryLaunchInputs(options)).rejects.toThrow('ordinary_retained_input_mismatch');
    expect(await readFile(path, 'utf8')).toBe('preserved conflicting capture');
  });
});
