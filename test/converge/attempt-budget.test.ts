import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_CONVERGE_ATTEMPT_CAP,
  claimConvergeAttempt,
  ConvergeAttemptBudgetExceededError,
  ConvergeAttemptStateError,
  convergeAttemptStatePath,
  loadConvergeAttemptState,
  resolveGitCommonDir,
} from '../../src/converge/attempt-budget.js';

const dirs: string[] = [];

async function tempGitDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rcl-attempt-budget-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('convergence attempt budget', () => {
  it('persists every claimed attempt under the common Git directory', async () => {
    const gitCommonDir = await tempGitDir();

    const first = await claimConvergeAttempt({
      gitCommonDir,
      target: 'rcl-18',
      now: () => new Date('2026-08-15T12:00:00Z'),
      pid: 101,
    });
    const second = await claimConvergeAttempt({
      gitCommonDir,
      target: 'rcl-18',
      now: () => new Date('2026-08-15T12:01:00Z'),
      pid: 202,
    });

    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
    const state = await loadConvergeAttemptState(gitCommonDir, 'rcl-18');
    expect(state).toMatchObject({
      target: 'rcl-18',
      cap: 7,
      migratedAttempts: 0,
      attemptsUsed: 2,
      attempts: [
        { attempt: 1, pid: 101, source: 'claim' },
        { attempt: 2, pid: 202, source: 'claim' },
      ],
    });
  });

  it('treats every claim as spent and rejects the next one before work starts', async () => {
    const gitCommonDir = await tempGitDir();

    for (let attempt = 1; attempt <= DEFAULT_CONVERGE_ATTEMPT_CAP; attempt++) {
      await expect(claimConvergeAttempt({ gitCommonDir, target: 'repo-7559' })).resolves.toMatchObject({
        attempt,
        cap: DEFAULT_CONVERGE_ATTEMPT_CAP,
      });
    }

    const refused = claimConvergeAttempt({ gitCommonDir, target: 'repo-7559' });
    await expect(refused).rejects.toMatchObject({
      name: 'ConvergeAttemptBudgetExceededError',
      attemptsUsed: 7,
      cap: 7,
    });
    await expect(refused).rejects.toThrow('Ask the user whether to continue');
    expect((await loadConvergeAttemptState(gitCommonDir, 'repo-7559'))?.attemptsUsed).toBe(7);
  });

  it('preserves the configured cap when a resumed run omits an override', async () => {
    const gitCommonDir = await tempGitDir();
    await claimConvergeAttempt({ gitCommonDir, target: 'rcl-18', maxAttempts: 2 });
    await claimConvergeAttempt({ gitCommonDir, target: 'rcl-18', maxAttempts: 2 });

    await expect(
      claimConvergeAttempt({ gitCommonDir, target: 'rcl-18' })
    ).rejects.toMatchObject({ attemptsUsed: 2, cap: 2 });
    expect((await loadConvergeAttemptState(gitCommonDir, 'rcl-18'))?.cap).toBe(2);
  });

  it('allows an explicit invocation to raise the cap above the default', async () => {
    const gitCommonDir = await tempGitDir();
    for (let attempt = 1; attempt <= 7; attempt++) {
      await claimConvergeAttempt({ gitCommonDir, target: 'rcl-18' });
    }
    await expect(claimConvergeAttempt({ gitCommonDir, target: 'rcl-18' })).rejects.toMatchObject({
      attemptsUsed: 7,
      cap: 7,
    });

    await expect(
      claimConvergeAttempt({ gitCommonDir, target: 'rcl-18', maxAttempts: 9 })
    ).resolves.toMatchObject({ attempt: 8, cap: 9 });
    await expect(claimConvergeAttempt({ gitCommonDir, target: 'rcl-18' })).resolves.toMatchObject({
      attempt: 9,
      cap: 9,
    });
    await expect(claimConvergeAttempt({ gitCommonDir, target: 'rcl-18' })).rejects.toMatchObject({
      attemptsUsed: 9,
      cap: 9,
    });
  });

  it('allows an explicit invocation to tighten a cap and validates overrides', async () => {
    const gitCommonDir = await tempGitDir();
    await claimConvergeAttempt({ gitCommonDir, target: 'rcl-18' });
    await claimConvergeAttempt({ gitCommonDir, target: 'rcl-18', maxAttempts: 2 });

    await expect(claimConvergeAttempt({ gitCommonDir, target: 'rcl-18' })).rejects.toMatchObject({
      attemptsUsed: 2,
      cap: 2,
    });
    await expect(
      claimConvergeAttempt({ gitCommonDir, target: 'other', maxAttempts: 0 })
    ).rejects.toThrow('--max-attempts must be a positive safe integer');
    await expect(
      claimConvergeAttempt({
        gitCommonDir,
        target: 'other',
        maxAttempts: Number.MAX_SAFE_INTEGER + 1,
      })
    ).rejects.toThrow('--max-attempts must be a positive safe integer');
  });

  it('serializes concurrent starters so no process can race past the cap', async () => {
    const gitCommonDir = await tempGitDir();
    const claims = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        claimConvergeAttempt({ gitCommonDir, target: 'repo-7559', lockRetryMs: 1 })
      )
    );

    const successful = claims.filter((claim) => claim.status === 'fulfilled');
    const rejected = claims.filter((claim) => claim.status === 'rejected');
    expect(successful).toHaveLength(7);
    expect(rejected).toHaveLength(5);
    expect(
      rejected.every(
        (claim) =>
          claim.status === 'rejected' && claim.reason instanceof ConvergeAttemptBudgetExceededError
      )
    ).toBe(true);
    expect((await loadConvergeAttemptState(gitCommonDir, 'repo-7559'))?.attemptsUsed).toBe(7);
  });

  it('fails closed when persisted accounting is corrupt', async () => {
    const gitCommonDir = await tempGitDir();
    const stateFile = convergeAttemptStatePath(gitCommonDir, 'rcl-18');
    await mkdir(join(gitCommonDir, 'rcl-converge-attempts'), { recursive: true });
    await writeFile(stateFile, '{"attemptsUsed":0}\n');

    await expect(claimConvergeAttempt({ gitCommonDir, target: 'rcl-18' })).rejects.toBeInstanceOf(
      ConvergeAttemptStateError
    );
  });

  it('seeds a missing machine counter from an existing evidence ledger', async () => {
    const gitCommonDir = await tempGitDir();
    await writeFile(
      join(gitCommonDir, 'rcl-converge-repo-42-ledger.md'),
      '# RCL converge ledger — repo-42\n\n## Round 1 — HEAD aaa\n\n## Round 2 — HEAD bbb\n'
    );

    const claim = await claimConvergeAttempt({ gitCommonDir, target: 'repo-42' });

    expect(claim.attempt).toBe(3);
    const state = await loadConvergeAttemptState(gitCommonDir, 'repo-42');
    expect(state?.attemptsUsed).toBe(3);
    expect(state?.migratedAttempts).toBe(2);
    expect(state?.attempts).toEqual([
      expect.objectContaining({ attempt: 3, source: 'claim' }),
    ]);
  });

  it('refuses immediately when an existing ledger already reaches the cap', async () => {
    const gitCommonDir = await tempGitDir();
    await writeFile(
      join(gitCommonDir, 'rcl-converge-repo-42-ledger.md'),
      Array.from({ length: 7 }, (_, index) => `## Round ${index + 1} — HEAD abc`).join('\n')
    );

    await expect(claimConvergeAttempt({ gitCommonDir, target: 'repo-42' })).rejects.toMatchObject({
      attemptsUsed: 7,
      cap: 7,
    });
    expect((await loadConvergeAttemptState(gitCommonDir, 'repo-42'))?.attemptsUsed).toBe(7);
  });

  it('preserves an existing ledger above the default and continues only with an explicit override', async () => {
    const gitCommonDir = await tempGitDir();
    await writeFile(
      join(gitCommonDir, 'rcl-converge-repo-42-ledger.md'),
      '# RCL converge ledger\n\n## Round 19 — HEAD abc\n'
    );

    await expect(claimConvergeAttempt({ gitCommonDir, target: 'repo-42' })).rejects.toMatchObject({
      attemptsUsed: 19,
      cap: 7,
    });
    expect(await loadConvergeAttemptState(gitCommonDir, 'repo-42')).toMatchObject({
      migratedAttempts: 19,
      attemptsUsed: 19,
      attempts: [],
    });

    await expect(
      claimConvergeAttempt({ gitCommonDir, target: 'repo-42', maxAttempts: 20 })
    ).resolves.toMatchObject({ attempt: 20, cap: 20 });
  });

  it('hashes an untrusted target instead of allowing it to escape the state directory', async () => {
    const gitCommonDir = await tempGitDir();
    const claim = await claimConvergeAttempt({ gitCommonDir, target: '../../outside target' });

    expect(claim.stateFile.startsWith(join(gitCommonDir, 'rcl-converge-attempts'))).toBe(true);
    expect(claim.stateFile).not.toContain('../');
  });

  it('resolves the current repository common Git directory', async () => {
    await expect(resolveGitCommonDir()).resolves.toMatch(/\.git$/);
  });

  it('shares persisted accounting across linked worktrees', async () => {
    const root = await tempGitDir();
    const repository = join(root, 'repository');
    const worktree = join(root, 'worktree');
    execFileSync('git', ['init', '-q', repository]);
    execFileSync(
      'git',
      ['-c', 'user.name=RCL Test', '-c', 'user.email=rcl@example.test', 'commit', '--allow-empty', '-qm', 'seed'],
      { cwd: repository }
    );
    execFileSync('git', ['worktree', 'add', '-qb', 'linked-test', worktree], { cwd: repository });

    const repositoryCommonDir = await resolveGitCommonDir(repository);
    const worktreeCommonDir = await resolveGitCommonDir(worktree);
    expect(worktreeCommonDir).toBe(repositoryCommonDir);

    await claimConvergeAttempt({ gitCommonDir: repositoryCommonDir, target: 'repo-42' });
    await claimConvergeAttempt({ gitCommonDir: worktreeCommonDir, target: 'repo-42' });
    expect((await loadConvergeAttemptState(repositoryCommonDir, 'repo-42'))?.attemptsUsed).toBe(2);
  });
});
