import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkDismissalCitations,
  dismissalRequiresCitation,
  gitRevisionReader,
  parseDismissalCitations,
  reviewedRevision,
} from '../../src/converge/dismissal-citations.js';

const source = [
  'export function cancel(call) {',
  '  if (call.status !== "sent") return call;',
  '  return { ...call,',
  '    cancelledAt: now() };',
  '}',
].join('\n');
const read = async (path: string) => (path === 'lib/cancel.ts' ? source : undefined);

describe('dismissal citations (RCL-201)', () => {
  it('parses a path, line range and backtick quote from a reason', () => {
    expect(parseDismissalCitations('Guarded: lib/cancel.ts:2 `if (call.status !== "sent") return call;` and lib/cancel.ts:3-4 `cancelledAt: now()`'))
      .toEqual([
        { path: 'lib/cancel.ts', startLine: 2, endLine: 2, quote: 'if (call.status !== "sent") return call;' },
        { path: 'lib/cancel.ts', startLine: 3, endLine: 4, quote: 'cancelledAt: now()' },
      ]);
  });

  it('accepts a quote that matches the cited lines, across a line break', async () => {
    await expect(checkDismissalCitations('lib/cancel.ts:3-4 `return { ...call, cancelledAt: now() };`', read))
      .resolves.toBeUndefined();
  });

  it('refuses a reason without a quoted citation', async () => {
    await expect(checkDismissalCitations('The status check already guards this path.', read))
      .resolves.toMatch(/cite at least one/);
    await expect(checkDismissalCitations('See lib/cancel.ts:2 for the guard.', read))
      .resolves.toMatch(/cite at least one/);
  });

  it('refuses a quote that is not on the cited lines', async () => {
    await expect(checkDismissalCitations('lib/cancel.ts:3 `if (call.status !== "sent") return call;`', read))
      .resolves.toMatch(/lib\/cancel\.ts:3 does not contain the quoted text/);
  });

  it('refuses a quote that is only whitespace', async () => {
    await expect(checkDismissalCitations('lib/cancel.ts:2 `   `', read)).resolves.toMatch(/must quote code, not only whitespace/);
  });

  it('refuses a citation of a missing file or a line past its end', async () => {
    await expect(checkDismissalCitations('lib/other.ts:1 `x`', read)).resolves.toMatch(/lib\/other\.ts does not exist/);
    await expect(checkDismissalCitations('lib/cancel.ts:9 `x`', read)).resolves.toMatch(/lib\/cancel\.ts:9 is past the end/);
  });

  it('refuses a path that leaves the repository', async () => {
    await expect(checkDismissalCitations('../secrets.ts:1 `x`', read)).resolves.toMatch(/repository-relative/);
    await expect(checkDismissalCitations('/etc/passwd:1 `root`', read)).resolves.toMatch(/repository-relative/);
  });
});

describe('which dismissals need a citation', () => {
  const state = { lastAnnotations: { round: 2, identities: [
    { identity: 'gated', gating: 'verified' }, { identity: 'quiet', gating: 'none' },
  ] } };

  it('requires one for an identity that gated in the round, and not for a non-gating one', () => {
    expect(dismissalRequiresCitation(state, 2, 'gated')).toBe(true);
    expect(dismissalRequiresCitation(state, 2, 'quiet')).toBe(false);
  });

  it('requires one for an identity the round annotated nowhere', () => {
    expect(dismissalRequiresCitation(state, 2, 'unknown')).toBe(true);
  });

  it('requires one when the round has no recorded annotations', () => {
    expect(dismissalRequiresCitation(state, 1, 'quiet')).toBe(true);
    expect(dismissalRequiresCitation({}, 2, 'quiet')).toBe(true);
  });

  it('checks against the launch head only when the launch belongs to the round', () => {
    const launch = { round: 2, headSha: 'a'.repeat(40) };
    expect(reviewedRevision(launch, 2)).toBe('a'.repeat(40));
    expect(reviewedRevision(launch, 1)).toBe('HEAD');
    expect(reviewedRevision(undefined, 2)).toBe('HEAD');
  });
});

describe('gitRevisionReader', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  it('reads a file at the reviewed commit, not the working tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcl-citations-'));
    dirs.push(dir);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
      { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    await mkdir(join(dir, 'lib'));
    await writeFile(join(dir, 'lib/cancel.ts'), source);
    git('add', '.');
    git('commit', '-q', '-m', 'reviewed');
    const reviewed = git('rev-parse', 'HEAD');
    await writeFile(join(dir, 'lib/cancel.ts'), 'changed after review');

    const reader = gitRevisionReader(dir, reviewed);
    expect(await reader('lib/cancel.ts')).toBe(source);
    expect(await reader('lib/missing.ts')).toBeUndefined();
  });

  it('reports a reviewed commit the local repository does not have', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcl-citations-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await expect(gitRevisionReader(dir, 'a'.repeat(40))('lib/cancel.ts')).rejects.toThrow(/fetch it/);
  });
});
