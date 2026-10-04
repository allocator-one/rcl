import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { retainOrdinaryLaunchInputs } from '../../src/converge/ordinary-pending-export.js';
import { retainGuardedInput, restoreGuardedInput } from '../../src/converge/guarded-input-retention.js';
import { validateOrdinaryPendingPackage } from '../../src/converge/ordinary-pending-package.js';
import { guardedInputSha256 } from '../../src/report/run-header.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('guarded launch input retention', () => {
  it('retains a large patch once instead of once per reviewer prompt', async () => {
    const gitCommonDir = await mkdtemp(join(tmpdir(), 'rcl-guarded-input-'));
    directories.push(gitCommonDir);
    const patch = 'x'.repeat(1_700_000);
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
        user: `Review this exact patch:\n${patch}`,
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
    expect(packet.guardedInput.strings.filter((value: string) => value.includes(patch))).toHaveLength(1);
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
    const changed = structuredClone(guardedInput);
    mutate(changed);
    const packet = { target: expected.target, headSha: expected.headSha, baseSha: expected.baseSha,
      attempt: 1, round: 1, pid: 999_999, retainedAsyncSha256: [hash],
      retainedAsync: [{ ...descriptor, sha256: hash }], guardedInput: retainGuardedInput(changed) };

    expect(() => validateOrdinaryPendingPackage(packet, expected))
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
});
