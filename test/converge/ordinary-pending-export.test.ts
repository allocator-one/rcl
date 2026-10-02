import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retainOrdinaryLaunchInputs } from '../../src/converge/ordinary-pending-export.js';
import { guardedInputSha256, sha256Hex } from '../../src/report/run-header.js';

const fault = vi.hoisted(() => ({ partialWrite: false }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
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
afterEach(async () => { fault.partialWrite = false; for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('ordinary launch input retention', () => {
  it('refuses repeated async descriptor bytes that would exceed the recovery package ceiling', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'ordinary-descriptor-boundary-')); dirs.push(gitCommonDir);
    const descriptor = { model: 'openai/' + 'x'.repeat(9 * 1024 * 1024), role: 'general', provider: 'openai' };
    const guardedInput = { head: 'a'.repeat(40), kind: 'pr',
      roster: [{ ...descriptor, lane: 'async' }], prompts: [] };
    const options = { gitCommonDir, target: 'owner-repo-1', headSha: guardedInput.head,
      baseSha: 'b'.repeat(40), guardedInput, attempt: 1, round: 1,
      // One async seat reviewing two chunks repeats its identifier in two artifacts.
      asyncDescriptors: [descriptor, descriptor] };
    const retainedBytes = JSON.stringify({ version: 1, target: options.target, headSha: options.headSha,
      baseSha: options.baseSha, attempt: 1, round: 1, inputSha256: guardedInputSha256(guardedInput),
      guardedInput }, null, 2) + '\n';
    expect(Buffer.byteLength(retainedBytes, 'utf8')).toBeLessThan(20 * 1024 * 1024);
    await expect(retainOrdinaryLaunchInputs(options)).rejects.toThrow('recovery_document_too_large');
    expect(await readdir(gitCommonDir)).toEqual([]);
  }, 20_000);

  it('accepts the 20 MiB byte boundary and refuses one extra byte before publishing any capture', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'ordinary-size-boundary-')); dirs.push(gitCommonDir);
    const guardedInput = { head: 'a'.repeat(40), kind: 'pr', prompts: [{ system: '', user: '' }] };
    const options = { gitCommonDir, target: 'owner-repo-1', headSha: guardedInput.head,
      baseSha: 'b'.repeat(40), guardedInput, attempt: 1, round: 1 };
    const emptyPacket = JSON.stringify({ version: 1, target: options.target, headSha: options.headSha,
      baseSha: options.baseSha, attempt: 1, round: 1, inputSha256: guardedInputSha256(guardedInput),
      guardedInput }, null, 2) + '\n';
    const limit = 20 * 1024 * 1024;
    const available = limit - Buffer.byteLength(emptyPacket, 'utf8');
    // A byte limit must account for UTF-8, not the shorter JS string length.
    guardedInput.prompts[0]!.user = '€'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3);
    const retained = await retainOrdinaryLaunchInputs(options);
    expect((await stat(retained.path)).size).toBe(limit);
    expect(await retainOrdinaryLaunchInputs(options)).toEqual(retained);
    const directory = join(gitCommonDir, 'rcl-ordinary-inputs');
    const before = await readdir(directory);
    guardedInput.prompts[0]!.user += 'x';
    await expect(retainOrdinaryLaunchInputs(options)).rejects.toThrow('recovery_document_too_large');
    expect(await readdir(directory)).toEqual(before);
    expect((await stat(retained.path)).size).toBe(limit);
  }, 20_000);

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
    expect(JSON.parse(await readFile(path, 'utf8')).guardedInput).toEqual(options.guardedInput);
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
    expect(JSON.parse(bytes)).toEqual({ version: 1, target: options.target, headSha: options.headSha,
      baseSha: options.baseSha, attempt: 1, round: 1, inputSha256: guardedInputSha256(guardedInput),
      guardedInput: { head: guardedInput.head, kind: 'pr' } });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await retainOrdinaryLaunchInputs(options)).toEqual({ path, sha256: sha256Hex(bytes), baseSha: options.baseSha });
    await writeFile(path, 'preserved conflicting capture');
    await expect(retainOrdinaryLaunchInputs(options)).rejects.toThrow('ordinary_retained_input_mismatch');
    expect(await readFile(path, 'utf8')).toBe('preserved conflicting capture');
  });
});
