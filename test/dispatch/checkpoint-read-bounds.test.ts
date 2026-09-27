import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, checkpointPath, exportCheckpointProof, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { stableStringify } from '../../src/report/run-header.js';

const reads = vi.hoisted(() => [] as string[]);
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    reads.push(String(args[0]));
    return fs.open(...args);
  } };
});
const roots: string[] = [];
afterEach(async () => { reads.length = 0; await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const target = 'allocator-one/rcl#105', namespace = 'read-bounds';
const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: 'c'.repeat(64), configSha256: 'd'.repeat(64),
  specSha256: 'e'.repeat(64), contextSha256: 'f'.repeat(64), toolsSha256: '1'.repeat(64), parser: { name: 'findings-json', version: 1 },
  roster: [{ seat: 'general', model: 'openai/reviewer', role: 'general', route: 'openai' }],
  chunks: [{ index: 0, total: 1, digest: '2'.repeat(64) }], prompts: [{ seat: 'general', chunk: 0, systemSha256: '3'.repeat(64), userSha256: '4'.repeat(64) }] });
const review = (error: string) => JSON.stringify({ model: 'openai/reviewer', role: 'general', provider: 'openai', status: 'error', durationMs: 1, findings: [], error });

async function fixture(attempts = 2, sealed = true) {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-read-bounds-'))); roots.push(commonDir);
  let journal!: CheckpointJournal;
  await withNativeTarget(commonDir, target, async ownership => {
    journal = await CheckpointJournal.create({ commonDir, namespace, plan, ownership });
    for (let i = 0; i < attempts; i++) {
      const attempt = { id: `attempt-${i}`, kind: 'paid' as const };
      await journal.recordIntent('general:0', attempt, ownership);
      await journal.recordResult('general:0', attempt, { kind: 'failure', chunk: 0, possiblyBilled: true, reviewBytes: review('failed') }, ownership);
    }
    if (sealed) await journal.finalize(ownership);
  });
  return { journal, commonDir, path: checkpointPath(commonDir, target, namespace) };
}

describe('checkpoint disk input budgets', () => {
  it('charges raw event whitespace before proof export reads the file into memory', async () => {
    const { journal, path } = await fixture();
    const original = await exportCheckpointProof(journal), events = join(path, 'events'), names = (await readdir(events)).sort();
    for (const name of names.slice(0, 4)) {
      const file = join(events, name), bytes = await readFile(file, 'utf8');
      await writeFile(file, bytes + ' '.repeat(7 * 1024 * 1024 - Buffer.byteLength(bytes)));
    }
    expect((await journal.read()).records).toEqual(original.state.records);
    reads.length = 0;
    await expect(exportCheckpointProof(journal)).rejects.toThrow('checkpoint_proof_too_large');
    expect(reads).not.toContain(join(events, names[3]!));
    expect((await readFile(join(events, names[3]!))).length).toBe(7 * 1024 * 1024);
  });

  it.each([8, 9])('bounds routine reads of %i individually valid large results before allocating the excess file', async attempts => {
    const { journal, path } = await fixture(attempts), records = (await journal.read()).records;
    const bytes = review('x'.repeat(7.5 * 1024 * 1024)), resultFiles: string[] = [];
    let previous = plan.digest;
    for (const [index, record] of records.entries()) {
      if (record.result) {
        const file = join(path, 'results', record.result.resultFile);
        await writeFile(file, bytes); resultFiles.push(file); record.result.reviewSha256 = hash(bytes);
      }
      const { digest: _digest, ...unsigned } = record;
      unsigned.previousDigest = previous;
      if (unsigned.type === 'finalization') unsigned.finalizedDigest = hash(stableStringify(records.slice(0, index)));
      Object.assign(record, unsigned, { digest: hash(stableStringify(unsigned)) }); previous = record.digest;
      await writeFile(join(path, 'events', `${String(index + 1).padStart(8, '0')}.json`), stableStringify(record) + '\n');
    }
    reads.length = 0;
    if (attempts === 8) {
      const state = await journal.read();
      expect(state.outcomes).toHaveLength(8);
      expect(state.outcomes.every(outcome => outcome.result.reviewBytes === bytes)).toBe(true);
      expect(state.finalized).toBe(true);
    } else {
      await expect(journal.read().then(() => undefined)).rejects.toThrow('checkpoint_journal_too_large');
      expect(reads).not.toContain(resultFiles.at(-1));
      expect((await readFile(resultFiles.at(-1)!, 'utf8'))).toBe(bytes);
    }
  });

  it('refuses an append that would make the journal exceed its routine read budget', async () => {
    const { journal, commonDir, path } = await fixture(6, false), events = join(path, 'events');
    for (const name of (await readdir(events)).sort().slice(0, 9)) {
      const file = join(events, name), bytes = await readFile(file, 'utf8');
      await writeFile(file, bytes + ' '.repeat(7 * 1024 * 1024 - Buffer.byteLength(bytes)));
    }
    const attempt = { id: 'extra', kind: 'paid' as const };
    await withNativeTarget(commonDir, target, owner => journal.recordIntent('general:0', attempt, owner));
    const before = await journal.read(), results = join(path, 'results'), files = await readdir(results);
    const bytes = review('x'.repeat(2 * 1024 * 1024));
    await expect(withNativeTarget(commonDir, target, owner => journal.recordResult('general:0', attempt,
      { kind: 'failure', chunk: 0, possiblyBilled: true, reviewBytes: bytes }, owner))).rejects.toThrow('checkpoint_journal_too_large');
    expect(await journal.read()).toEqual(before);
    expect(before.uncertain).toEqual([{ cell: 'general:0', paidAttempt: attempt }]);
    const retained = (await readdir(results)).filter(file => !files.includes(file));
    expect(retained).toHaveLength(1);
    expect(await readFile(join(results, retained[0]!), 'utf8')).toBe(bytes);
  });
});
