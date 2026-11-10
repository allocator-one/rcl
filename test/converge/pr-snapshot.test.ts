import { afterEach, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PR_SNAPSHOT_MAX_AGE_MS, prSnapshotFrom, readPrSnapshot, writePrSnapshot } from '../../src/converge/pr-snapshot.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const pr = { head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40), ref: 'main' }, merged: false, state: 'open' };

async function snapshotFile(fetchedAt = new Date()) {
  const root = await mkdtemp(join(tmpdir(), 'rcl-pr-snapshot-'));
  roots.push(root);
  const path = join(root, 'pr.json');
  await writePrSnapshot(path, prSnapshotFrom('Allocator-One/RCL', 42, pr, fetchedAt));
  return path;
}

it('answers the live state a parent captured, for the same pull request', async () => {
  const path = await snapshotFile();
  expect(await readPrSnapshot(path, 'allocator-one/rcl', 42)).toEqual({ headSha: 'a'.repeat(40), merged: false, state: 'open' });
});

it('refuses a snapshot of another pull request', async () => {
  const path = await snapshotFile();
  await expect(readPrSnapshot(path, 'allocator-one/rcl', 43)).rejects.toThrow('pr_snapshot_pull_request_mismatch');
  await expect(readPrSnapshot(path, 'allocator-one/other', 42)).rejects.toThrow('pr_snapshot_pull_request_mismatch');
});

it('refuses a reading too old to stand in for the live check', async () => {
  const path = await snapshotFile(new Date(Date.now() - PR_SNAPSHOT_MAX_AGE_MS - 1000));
  await expect(readPrSnapshot(path, 'allocator-one/rcl', 42)).rejects.toThrow('pr_snapshot_stale');
});

it.skipIf(process.platform === 'win32')('refuses a file another user could have written', async () => {
  const path = await snapshotFile();
  await chmod(path, 0o666);
  await expect(readPrSnapshot(path, 'allocator-one/rcl', 42)).rejects.toThrow('pr_snapshot_unsafe_file');
});

it('refuses a file that is not a snapshot, and never overwrites one', async () => {
  const path = await snapshotFile();
  await expect(writePrSnapshot(path, prSnapshotFrom('allocator-one/rcl', 42, pr))).rejects.toThrow();
  const other = join(path, '..', 'other.json');
  await writeFile(other, JSON.stringify({ headSha: 'a'.repeat(40) }), { mode: 0o600 });
  await expect(readPrSnapshot(other, 'allocator-one/rcl', 42)).rejects.toThrow('pr_snapshot_invalid');
});
