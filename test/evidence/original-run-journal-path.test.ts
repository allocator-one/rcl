import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { openJournal } from '../../src/evidence/original-run/journal.js';

const roots: string[] = [];
const manifest = 'a'.repeat(64);
const operation = '00000000-0000-4000-8000-000000000001';
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'rcl-journal-path-')); roots.push(path); return path; }

it('refuses a nonprivate existing journal on resume without changing it', async () => {
  const path = join(await root(), 'journal'); await mkdir(path); await chmod(path, 0o777);
  await expect(openJournal(path, manifest, operation, 'resume')).rejects.toThrow('unsafe_recovery_journal_root');
  expect(await readdir(path)).toEqual([]);
});

it('keeps apply exclusive and refuses missing resume state without creating it', async () => {
  const parent = await root(); const path = join(parent, 'journal');
  await expect(openJournal(path, manifest, operation, 'resume')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(parent)).toEqual([]);
  const journal = await openJournal(path, manifest, operation, 'apply'); await journal.append('prepared');
  await expect(openJournal(path, manifest, operation, 'apply')).rejects.toMatchObject({ code: 'EEXIST' });
  const resumed = await openJournal(path, manifest, operation, 'resume'); await resumed.append('complete');
  expect(await readdir(path)).toEqual(['00000001.json', '00000002.json']);
});

it('refuses a directory replacement before appending to its replacement', async () => {
  const parent = await root(); const path = join(parent, 'journal'); const retained = join(parent, 'retained');
  const journal = await openJournal(path, manifest, operation, 'apply', async () => {
    await rename(path, retained); await mkdir(path, { mode: 0o700 });
  });
  await expect(journal.append('post_intent')).rejects.toThrow('recovery_journal_replaced');
  expect(await readdir(path)).toEqual([]); expect(await readdir(retained)).toEqual([]);
});

it.runIf(process.platform === 'darwin')('refuses a harmful ACL on a mode0700 journal before resume', async () => {
  const path = join(await root(), 'journal'); await mkdir(path, { mode: 0o700 });
  await promisify(execFile)('/bin/chmod', ['+a', 'everyone allow add_file,delete_child', path]);
  try {
    await expect(openJournal(path, manifest, operation, 'resume')).rejects.toThrow('unsafe_recovery_journal_acl');
    expect(await readdir(path)).toEqual([]);
  } finally { await promisify(execFile)('/bin/chmod', ['-N', path]); }
});
