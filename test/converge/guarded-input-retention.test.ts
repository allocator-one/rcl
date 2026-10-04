import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { retainOrdinaryLaunchInputs } from '../../src/converge/ordinary-pending-export.js';
import { retainGuardedInput, restoreGuardedInput, DEFAULT_GUARDED_INPUT_CAPACITY,
  MAX_GUARDED_INPUT_CAPACITY, validateGuardedInputCapacity, type GuardedInputCapacity } from '../../src/converge/guarded-input-retention.js';
import { validateOrdinaryPendingPackage } from '../../src/converge/ordinary-pending-package.js';
import { guardedInputSha256, sha256Hex } from '../../src/report/run-header.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('guarded launch input retention', () => {
  it('retains a large patch once instead of once per reviewer prompt', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'rcl-guarded-input-'));
    directories.push(gitCommonDir);
    const patch = 'x'.repeat(1_700_000);
    const userPrompt = `Review this exact patch:\n${patch}`;
    const guardedInput = {
      head: 'a'.repeat(40),
      kind: 'patch',
      repo: 'allocator-one/allocator-one',
      pr: 9889,
      diff: 'b'.repeat(64),
      config: 'c'.repeat(64),
      roster: Array.from({ length: 14 }, (_, index) => ({
        model: `provider/model-${index}`,
        role: `role-${index}`,
        provider: 'provider',
        lane: 'blocking',
      })),
      prompts: Array.from({ length: 14 }, (_, index) => ({
        system: `Review as role ${index}`,
        user: userPrompt,
      })),
      asyncRoles: [],
    };

    const retained = await retainOrdinaryLaunchInputs({
      gitCommonDir,
      target: 'allocator-one-9889',
      headSha: guardedInput.head,
      baseSha: 'd'.repeat(40),
      guardedInput,
      attempt: 9,
      round: 5,
    });

    const bytes = await readFile(retained.path);
    expect(bytes.byteLength).toBeLessThan(20 * 1024 * 1024);
    const packet = JSON.parse(bytes.toString());
    expect(restoreGuardedInput(packet.guardedInput)).toEqual(guardedInput);
    expect(packet.guardedInput.strings.filter((value: string) => value === userPrompt)).toHaveLength(1);
  });

  it('refuses genuinely unique input above the retained packet ceiling before publishing a capture', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'rcl-guarded-input-'));
    directories.push(gitCommonDir);
    const guardedInput = {
      head: 'a'.repeat(40), kind: 'patch', repo: 'allocator-one/allocator-one', pr: 9889,
      diff: 'b'.repeat(64), config: 'c'.repeat(64), roster: [], asyncRoles: [],
      prompts: [{ system: 'general', user: 'x'.repeat(21 * 1024 * 1024) }],
    };

    await expect(retainOrdinaryLaunchInputs({ gitCommonDir, target: 'allocator-one-9889',
      headSha: guardedInput.head, baseSha: 'd'.repeat(40), guardedInput, attempt: 9, round: 5 }))
      .rejects.toThrow('retained_review_work_too_large: retained prompts exceed the recovery limit; split the diff or reduce prompt context or the reviewer roster before retrying');
    expect(await readdir(gitCommonDir)).toEqual([]);
  });

  it('refuses highly repeated work before claim when recovery could not expand it safely', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'rcl-guarded-input-'));
    directories.push(gitCommonDir);
    const patch = 'x'.repeat(9 * 1024 * 1024);
    const guardedInput = {
      head: 'a'.repeat(40), kind: 'patch', repo: 'allocator-one/allocator-one', pr: 9889,
      diff: 'b'.repeat(64), config: 'c'.repeat(64), roster: [], asyncRoles: [],
      prompts: Array.from({ length: 16 }, (_, index) => ({ system: `role-${index}`, user: patch })),
    };

    await expect(retainOrdinaryLaunchInputs({ gitCommonDir, target: 'allocator-one-9889',
      headSha: guardedInput.head, baseSha: 'd'.repeat(40), guardedInput, attempt: 9, round: 5 }))
      .rejects.toThrow('retained_review_work_too_large');
    expect(await readdir(gitCommonDir)).toEqual([]);
  });

  it('retains and restores an opted-in 240-chunk, 17-seat prompt matrix with its exact capacity', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'rcl-full-patch-retention-'));
    directories.push(gitCommonDir);
    const prompts = Array.from({ length: 240 }, (_, chunk) => {
      const userPrompt = `chunk:${chunk}\n${'x'.repeat(62_000)}`;
      return Array.from({ length: 17 }, (_, seat) => ({ systemPrompt: `role:${seat}`, userPrompt }));
    }).flat();
    const guardedInput = { head: 'a'.repeat(40), kind: 'pr', prompts };
    const options = { gitCommonDir, target: 'owner-repo-1', headSha: guardedInput.head,
      baseSha: 'b'.repeat(40), guardedInput, attempt: 1, round: 1 };
    await expect(retainOrdinaryLaunchInputs(options)).rejects.toThrow('retained_review_work_too_large');
    expect(await readdir(gitCommonDir)).toEqual([]);
    const retained = await retainOrdinaryLaunchInputs({ ...options,
      guardedInputCapacity: MAX_GUARDED_INPUT_CAPACITY });
    const bytes = await readFile(retained.path, 'utf8');
    const packet = JSON.parse(bytes);
    expect(packet.guardedInput.capacity).toEqual(MAX_GUARDED_INPUT_CAPACITY);
    expect(retained.sha256).toBe(sha256Hex(bytes));
    const restored = restoreGuardedInput(packet.guardedInput);
    const restoredPrompts = restored.prompts as typeof prompts;
    expect(restoredPrompts).toHaveLength(4080);
    for (let index = 0; index < prompts.length; index++) {
      expect(restoredPrompts[index]!.userPrompt).toBe(prompts[index]!.userPrompt);
      expect(restoredPrompts[index]!.systemPrompt).toBe(prompts[index]!.systemPrompt);
    }
    expect(await retainOrdinaryLaunchInputs({ ...options,
      guardedInputCapacity: MAX_GUARDED_INPUT_CAPACITY })).toEqual(retained);
  }, 30_000);

  it('keeps the default decoded ceiling and enforces an explicitly selected smaller ceiling', () => {
    expect(DEFAULT_GUARDED_INPUT_CAPACITY).toEqual({
      decodedBytes: 128 * 1024 * 1024, retainedBytes: 20 * 1024 * 1024,
    });
    const raw = { prompts: ['x'.repeat(100), 'x'.repeat(100)] };
    const capacity = { ...DEFAULT_GUARDED_INPUT_CAPACITY, decodedBytes: 128 };
    expect(() => retainGuardedInput(raw, capacity)).toThrow('guarded_input_archive_expands_too_large');
    const archive = retainGuardedInput(raw, MAX_GUARDED_INPUT_CAPACITY);
    archive.capacity!.decodedBytes = 128;
    expect(() => restoreGuardedInput(archive)).toThrow('guarded_input_archive_expands_too_large');
  });

  it('enforces the opted decoded hard cap without expanding repeated strings', () => {
    const raw = { prompts: Array<string>(58).fill('x'.repeat(9 * 1024 * 1024)) };
    expect(() => retainGuardedInput(raw, MAX_GUARDED_INPUT_CAPACITY))
      .toThrow('guarded_input_archive_expands_too_large');
  });

  it.each([0, -1, 1.5, Infinity, NaN, '512', undefined])(
    'rejects invalid retention capacity values %s', value => {
      for (const field of ['decodedBytes', 'retainedBytes']) {
        const capacity = { ...DEFAULT_GUARDED_INPUT_CAPACITY, [field]: value } as GuardedInputCapacity;
        expect(() => retainGuardedInput({}, capacity)).toThrow('guarded_input_capacity_invalid');
        const archive = { ...retainGuardedInput({}), capacity };
        expect(() => restoreGuardedInput(archive)).toThrow('guarded_input_capacity_invalid');
      }
    }
  );

  it('rejects unknown or excessive capacity and snapshots the selected limits', () => {
    for (const field of ['decodedBytes', 'retainedBytes'] as const) {
      expect(() => validateGuardedInputCapacity({ ...MAX_GUARDED_INPUT_CAPACITY,
        [field]: MAX_GUARDED_INPUT_CAPACITY[field] + 1 })).toThrow('guarded_input_capacity_invalid');
    }
    expect(() => validateGuardedInputCapacity({ ...MAX_GUARDED_INPUT_CAPACITY,
      unlimited: true } as GuardedInputCapacity)).toThrow('guarded_input_capacity_invalid');
    expect(() => validateGuardedInputCapacity(null as unknown as GuardedInputCapacity))
      .toThrow('guarded_input_capacity_invalid');
    const capacity = { ...MAX_GUARDED_INPUT_CAPACITY };
    const archive = retainGuardedInput({}, capacity);
    capacity.decodedBytes = 1;
    expect(archive.capacity).toEqual(MAX_GUARDED_INPUT_CAPACITY);
    expect(retainGuardedInput({})).not.toHaveProperty('capacity');
  });

  it('round-trips canonical JSON exactly while interning repeated keys and values', () => {
    const guardedInput = {
      head: 'a'.repeat(40), kind: 'patch', prompts: [
        { system: 'same', user: 'same', optional: undefined },
        { system: 'same', user: 'same', values: [null, true, 7] },
      ],
    };
    const expected = JSON.parse(JSON.stringify(guardedInput));
    const retained = retainGuardedInput(guardedInput);

    expect(restoreGuardedInput(retained)).toEqual(expected);
    expect(retained.strings.filter(value => value === 'same')).toHaveLength(1);
    expect(retainGuardedInput(restoreGuardedInput(retained))).toEqual(retained);
  });

  it('rejects deeply nested guarded input with a controlled error before exhausting the stack', () => {
    let guardedInput: Record<string, unknown> = { leaf: 'value' };
    for (let depth = 0; depth < 300; depth++) guardedInput = { child: guardedInput };

    expect(() => retainGuardedInput(guardedInput)).toThrow('guarded_input_too_deep');
    try {
      retainGuardedInput(guardedInput);
    } catch (error) {
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  it('rejects deeply nested fresh launch input before hashing or publishing a capture', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'rcl-guarded-input-'));
    directories.push(gitCommonDir);
    let guardedInput: Record<string, unknown> = { leaf: 'value' };
    for (let depth = 0; depth < 20_000; depth++) guardedInput = { child: guardedInput };

    const error = await retainOrdinaryLaunchInputs({
      gitCommonDir,
      target: 'allocator-one-9889',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      guardedInput,
      attempt: 9,
      round: 5,
    }).then(() => undefined, reason => reason as unknown);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe('guarded_input_too_deep');
    expect(await readdir(gitCommonDir)).toEqual([]);
  });

  it('rejects a deeply nested archive with a controlled error before exhausting the stack', () => {
    let root: unknown = ['v', null];
    for (let depth = 0; depth < 300; depth++) root = ['o', [[0, root]]];
    const retained = {
      version: 1 as const,
      encoding: 'json-string-table-v1' as const,
      strings: ['child'],
      root,
    } as ReturnType<typeof retainGuardedInput>;

    expect(() => restoreGuardedInput(retained)).toThrow('guarded_input_too_deep');
    try {
      restoreGuardedInput(retained);
    } catch (error) {
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  it.each([
    ['an unreferenced string', (value: ReturnType<typeof retainGuardedInput>) => value.strings.push('unused')],
    ['an out-of-range reference', (value: ReturnType<typeof retainGuardedInput>) => {
      value.root = ['s', value.strings.length] as typeof value.root;
    }],
    ['an unexpected archive property', (value: ReturnType<typeof retainGuardedInput>) => {
      (value as unknown as Record<string, unknown>).extra = true;
    }],
  ])('rejects a noncanonical or tampered archive with %s', (_label, mutate) => {
    const retained = retainGuardedInput({ head: 'a'.repeat(40), kind: 'patch' });
    mutate(retained);
    expect(() => restoreGuardedInput(retained)).toThrow('guarded_input_archive_invalid');
  });

  it.each([
    ['prompt', (input: Record<string, any>) => { input.prompts[0].user = 'changed'; }],
    ['roster', (input: Record<string, any>) => { input.roster[0].model = 'other/model'; }],
    ['configuration digest', (input: Record<string, any>) => { input.config = 'f'.repeat(64); }],
  ])('rejects a compact package with a changed %s binding', (_label, mutate) => {
    const descriptor = { model: 'openai/test', role: 'general', provider: 'openai', lane: 'async' as const };
    const guardedInput: Record<string, any> = {
      head: 'a'.repeat(40), kind: 'pr', repo: 'owner/repo', pr: 1,
      diff: 'b'.repeat(64), config: 'c'.repeat(64), roster: [descriptor],
      prompts: [{ system: 'review', user: 'patch' }], asyncRoles: [{ name: 'general' }],
    };
    const hash = 'd'.repeat(64);
    const expected = { target: 'owner-repo-1', headSha: guardedInput.head,
      inputSha256: guardedInputSha256(guardedInput), baseSha: 'e'.repeat(40),
      attempt: 1, round: 1, pid: 999_999, retainedAsyncSha256: [hash] };
    const packet = {
      guardedInputRepresentation: { version: 1 as const, encoding: 'json-string-table-v1' as const },
      target: expected.target, headSha: expected.headSha, baseSha: expected.baseSha,
      attempt: 1, round: 1, pid: 999_999, retainedAsyncSha256: [hash],
      retainedAsync: [{ ...descriptor, sha256: hash }],
      guardedInput: retainGuardedInput(guardedInput),
    };
    expect(validateOrdinaryPendingPackage(packet, expected)).toEqual(packet);

    const changed = structuredClone(guardedInput);
    mutate(changed);
    const changedPacket = { ...packet, guardedInput: retainGuardedInput(changed) };

    expect(() => validateOrdinaryPendingPackage(changedPacket, expected))
      .toThrow('ordinary_pending_package_mismatch');
  });

  it('continues to authenticate legacy raw pending packages', () => {
    const descriptor = { model: 'openai/test', role: 'general', provider: 'openai', lane: 'async' as const };
    const guardedInput = { head: 'a'.repeat(40), kind: 'pr', repo: 'owner/repo', pr: 1,
      diff: 'b'.repeat(64), config: 'c'.repeat(64), roster: [descriptor], prompts: [],
      asyncRoles: [{ name: 'general' }] };
    const hash = 'd'.repeat(64);
    const expected = { target: 'owner-repo-1', headSha: guardedInput.head,
      inputSha256: guardedInputSha256(guardedInput), baseSha: 'e'.repeat(40),
      attempt: 1, round: 1, pid: 999_999, retainedAsyncSha256: [hash] };
    const legacy = { target: expected.target, headSha: expected.headSha, baseSha: expected.baseSha,
      attempt: 1, round: 1, pid: 999_999, retainedAsyncSha256: [hash],
      retainedAsync: [{ ...descriptor, sha256: hash }], guardedInput };

    expect(validateOrdinaryPendingPackage(legacy, expected)).toEqual(legacy);
  });

  it('rejects deeply nested legacy raw pending input before hashing it', () => {
    let deepPrompt: unknown = 'value';
    for (let depth = 0; depth < 20_000; depth++) deepPrompt = { child: deepPrompt };
    const descriptor = { model: 'openai/test', role: 'general', provider: 'openai', lane: 'async' as const };
    const guardedInput = {
      head: 'a'.repeat(40), kind: 'pr', repo: 'owner/repo', pr: 1,
      diff: 'b'.repeat(64), config: 'c'.repeat(64), roster: [descriptor],
      prompts: [deepPrompt], asyncRoles: [{ name: 'general' }],
    };
    const hash = 'd'.repeat(64);
    const legacy = {
      target: 'owner-repo-1', headSha: guardedInput.head, baseSha: 'e'.repeat(40),
      attempt: 1, round: 1, pid: 999_999, retainedAsyncSha256: [hash],
      retainedAsync: [{ ...descriptor, sha256: hash }], guardedInput,
    };
    const expected = {
      target: legacy.target, headSha: legacy.headSha, inputSha256: 'f'.repeat(64),
      baseSha: legacy.baseSha, attempt: 1, round: 1, pid: 999_999,
      retainedAsyncSha256: [hash],
    };

    let error: unknown;
    try {
      validateOrdinaryPendingPackage(legacy, expected);
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe('ordinary_pending_package_mismatch');
  });
});
