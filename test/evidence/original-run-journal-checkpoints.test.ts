import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { MAX_RECOVERY_CHECKPOINTS, openJournal } from '../../src/evidence/original-run/journal.js';

const fault = vi.hoisted(() => ({ failures: 0, syncs: 0, entries: undefined as string[] | undefined }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (basename(String(args[0])) === '00000001.json') {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        fault.syncs++;
        if (fault.failures > 0) {
          fault.failures--;
          throw Object.assign(new Error('Injected checkpoint fsync failure'), { code: 'EIO' });
        }
        await sync();
      };
    }
    return handle;
  }, readdir: async (...args: Parameters<typeof fs.readdir>) => fault.entries ?? fs.readdir(...args) };
});

const roots: string[] = [];
const manifest = 'a'.repeat(64);
const operation = '00000000-0000-4000-8000-000000000001';
afterEach(async () => {
  fault.failures = 0; fault.syncs = 0; fault.entries = undefined;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function path() {
  const root = await mkdtemp(join(tmpdir(), 'rcl-journal-checkpoints-')); roots.push(root);
  return join(root, 'journal');
}

it('recovers independently completed persistence steps from the same pinned journal', async () => {
  const file = await path();
  const journal = await openJournal(file, manifest, operation, 'apply');
  await journal.append('native_verified', { after_sha256: 'b'.repeat(64) });
  await journal.append('outcomes_failed', { code: 'EROFS' });
  const resumed = await openJournal(file, manifest, operation, 'resume');
  expect(resumed.checkpoints().map(({ sequence, phase, data }) => ({ sequence, phase, data }))).toEqual([
    { sequence: 1, phase: 'native_verified', data: { after_sha256: 'b'.repeat(64) } },
    { sequence: 2, phase: 'outcomes_failed', data: { code: 'EROFS' } },
  ]);
  await resumed.append('outcomes_verified', { record_ids: ['original-operation:0'] });
  expect(resumed.checkpoints().map(r => r.phase)).toEqual(['native_verified', 'outcomes_failed', 'outcomes_verified']);
});

it('does not let caller mutations change the retained checkpoint facts', async () => {
  const file = await path();
  const journal = await openJournal(file, manifest, operation, 'apply');
  const data = { records: ['original'] };
  await journal.append('calls_verified', data);
  const bytes = await readFile(join(file, '00000001.json'));
  data.records.push('caller-later-change');
  (journal.checkpoints()[0]!.data as typeof data).records.push('reader-change');
  expect(journal.checkpoints()[0]!.data).toEqual({ records: ['original'] });
  expect(await readFile(join(file, '00000001.json'))).toEqual(bytes);
});

it('pins checkpoint data before awaiting a hook or filesystem operation', async () => {
  const data = { record_id: 'original-operation:0' };
  const file = await path();
  const journal = await openJournal(file, manifest, operation, 'apply', async () => { data.record_id = 'changed'; });
  await journal.append('calls_verified', data);
  expect(JSON.parse(await readFile(join(file, '00000001.json'), 'utf8')).data).toEqual({ record_id: 'original-operation:0' });
  expect(journal.checkpoints()[0]!.data).toEqual({ record_id: 'original-operation:0' });
});

it('requires a successful flush before acknowledging a checkpoint retained after failed fsync', async () => {
  const file = await path();
  const journal = await openJournal(file, manifest, operation, 'apply');
  fault.failures = 1;
  await expect(journal.append('native_verified', { after_sha256: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'EIO' });
  fault.failures = 1;
  await expect(openJournal(file, manifest, operation, 'resume')).rejects.toMatchObject({ code: 'EIO' });
  expect(journal.checkpoints()).toEqual([]);
  const resumed = await openJournal(file, manifest, operation, 'resume');
  expect(fault.syncs).toBe(3);
  expect(resumed.checkpoints()).toHaveLength(1);
  expect(resumed.checkpoints()[0]!.phase).toBe('native_verified');
});

it('exposes torn checkpoint bytes only as an explicit retained interruption', async () => {
  const file = await path();
  await openJournal(file, manifest, operation, 'apply');
  await writeFile(join(file, '00000001.json'), '{"phase":"native_verified"');
  const resumed = await openJournal(file, manifest, operation, 'resume');
  expect(resumed.checkpoints()).toHaveLength(1);
  expect(resumed.checkpoints()[0]).toMatchObject({ sequence: 2, phase: 'interrupted_checkpoints_retained' });
  expect(resumed.checkpoints().some(r => r.phase === 'native_verified')).toBe(false);
});

it('refuses a parseable checkpoint with no valid phase instead of treating it as a receipt', async () => {
  const file = await path();
  const journal = await openJournal(file, manifest, operation, 'apply');
  await journal.append('native_verified');
  const checkpoint = join(file, '00000001.json');
  const record = JSON.parse(await readFile(checkpoint, 'utf8'));
  record.phase = { native_verified: true };
  await writeFile(checkpoint, JSON.stringify(record));
  await expect(openJournal(file, manifest, operation, 'resume')).rejects.toThrow('invalid_recovery_checkpoint');
});

it('refuses a non-object checkpoint with the journal validation error', async () => {
  const file = await path();
  const journal = await openJournal(file, manifest, operation, 'apply');
  await journal.append('native_verified');
  await writeFile(join(file, '00000001.json'), 'null');
  await expect(openJournal(file, manifest, operation, 'resume')).rejects.toThrow('invalid_recovery_checkpoint');
});

it('refuses a non-string phase before it can create an unreadable checkpoint', async () => {
  const file = await path();
  const journal = await openJournal(file, manifest, operation, 'apply');
  await expect(journal.append(null as unknown as string)).rejects.toThrow('invalid_recovery_checkpoint');
  expect(await readdir(file)).toEqual([]);
  expect(journal.checkpoints()).toEqual([]);
});

it('resumes a read-only checkpoint where the platform permits read-descriptor synchronization', async () => {
  if (process.platform === 'win32') return;
  const file = await path();
  const journal = await openJournal(file, manifest, operation, 'apply');
  await journal.append('native_verified');
  await chmod(join(file, '00000001.json'), 0o400);
  await expect(openJournal(file, manifest, operation, 'resume')).resolves.toBeDefined();
});

it('refuses an oversized checkpoint count before reading or parsing entries', async () => {
  const file = await path();
  await openJournal(file, manifest, operation, 'apply');
  fault.entries = Array.from({ length: MAX_RECOVERY_CHECKPOINTS + 1 }, (_, index) => `${String(index + 1).padStart(8, '0')}.json`);
  await expect(openJournal(file, manifest, operation, 'resume')).rejects.toThrow('recovery_journal_checkpoint_limit');
});
