import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withNativeTarget, type NativeTargetOwnership } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, checkpointPath, exportCheckpointProof, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { MAX_ARTIFACT_BYTES } from '../../src/telemetry/envelope-validation.js';

const durability = vi.hoisted(() => ({ failPath: '', synced: [] as string[] }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), sync = handle.sync.bind(handle), path = String(args[0]);
    handle.sync = async () => { durability.synced.push(path); if (durability.failPath === path) { durability.failPath = ''; throw Object.assign(new Error('synthetic fsync failure'), { code: 'EIO' }); } return sync(); };
    return handle;
  } };
});
const roots: string[] = [];
afterEach(async () => { durability.failPath = ''; durability.synced = []; await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const target = 'allocator-one/rcl#105', namespace = 'late-audit';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function plan() {
  return freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: 'c'.repeat(64), configSha256: 'd'.repeat(64), specSha256: 'e'.repeat(64), contextSha256: '3'.repeat(64), toolsSha256: '4'.repeat(64), parser: { name: 'findings-json', version: 1 },
    roster: [{ seat: 'general', model: 'openai/gpt-6-sol', role: 'general', route: 'openai' }], chunks: [0, 1].map(index => ({ index, total: 2, digest: hash(`chunk-${index}`) })),
    prompts: [0, 1].map(chunk => ({ seat: 'general', chunk, systemSha256: hash('system'), userSha256: hash(`user-${chunk}`) })) });
}
function review(status = 'success', extra = {}) {
  return JSON.stringify({ model: 'openai/gpt-6-sol', role: 'general', provider: 'openai', status, durationMs: 17,
    findings: [{ id: 'late-finding', file: 'a.ts', startLine: 1, endLine: 1, severity: 'important', category: 'correctness', title: '\uFEFFLate title', description: 'Retained raw description' }], usage: { inputTokens: 11, outputTokens: 7 }, ...extra }, null, 2) + '\n';
}
async function fixture(sealed = true) {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-late-audit-'))); roots.push(commonDir);
  const frozen = plan(); let journal!: CheckpointJournal; let expired!: NativeTargetOwnership;
  await withNativeTarget(commonDir, target, async owner => {
    expired = owner; journal = await CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership: owner });
    await journal.recordIntent('general:0', { id: 'original', kind: 'unknown' }, owner);
    await journal.recordIntent('general:1', { id: 'other', kind: 'paid' }, owner);
    if (sealed) await journal.finalize(owner);
  });
  return { commonDir, frozen, journal, expired, path: checkpointPath(commonDir, target, namespace) };
}
async function mainFiles(path: string) {
  const names = ['plan.json', ...(await readdir(join(path, 'events'))).map(name => `events/${name}`), ...(await readdir(join(path, 'results'))).map(name => `results/${name}`)];
  return Promise.all(names.map(async name => ({ name, sha256: hash(await readFile(join(path, name))) })));
}

describe('checkpoint late-result audit segment', () => {
  it('binds an opaque original launch before intent and preserves it in sealed proof', async () => {
    const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-late-audit-'))); roots.push(commonDir);
    await withNativeTarget(commonDir, target, async owner => {
      const journal = await CheckpointJournal.create({ commonDir, namespace, plan: plan(), ownership: owner });
      await journal.bind('launch', 'opaque launch bytes', owner);
      await journal.recordIntent('general:0', { id: 'original', kind: 'unknown' }, owner);
      await journal.finalize(owner);
      const proof = await exportCheckpointProof(journal);
      expect(proof.bindings.launch).toBe('opaque launch bytes');
      await journal.bind('launch', 'opaque launch bytes', owner);
      expect(await exportCheckpointProof(journal)).toEqual(proof);
    });
  });
  it.each(['success', 'timeout', 'error', 'parse_failed', 'canceled'])(
    'retains exact late %s bytes without changing sealed proof, main files or counted outcomes', async status => {
      const { commonDir, journal, path } = await fixture(), before = await mainFiles(path), state = await journal.read(), proof = await exportCheckpointProof(journal), bytes = review(status);
      expect(await journal.readLateAudit()).toEqual([]); expect(await readdir(path)).not.toContain('late-audit');
      await withNativeTarget(commonDir, target, owner => journal.recordLateResult('general:0', { id: 'original', kind: 'unknown' }, bytes, owner));
      const rows = await journal.readLateAudit();
      expect(rows).toHaveLength(1); expect(rows[0]?.reviewBytes).toBe(bytes); expect(rows[0]?.reviewSha256).toBe(hash(bytes));
      expect(rows[0]?.planDigest).toBe(journal.getPlan().digest);
      expect(rows[0]?.intentDigest).toBe(state.records[0]?.digest);
      expect(rows[0]?.finalizationDigest).toBe(state.records.at(-1)?.digest);
      expect(rows[0]?.previousDigest).toBe(state.records.at(-1)?.digest);
      expect(Object.isFrozen(rows)).toBe(true); expect(Object.isFrozen(rows[0]?.paidAttempt)).toBe(true);
      expect(await journal.read()).toEqual(state); expect(await exportCheckpointProof(journal)).toEqual(proof); expect(await mainFiles(path)).toEqual(before);
      expect(state.successes).toEqual([]); expect(state.uncertain).toHaveLength(2);
    },
  );

  it('snapshots attempt arguments and serializes concurrent identical replay with a second cell', async () => {
    const { commonDir, journal } = await fixture();
    await withNativeTarget(commonDir, target, async owner => {
      const attempt = { id: 'original', kind: 'unknown' as const };
      const first = journal.recordLateResult('general:0', attempt, review(), owner); attempt.id = 'changed after call';
      await Promise.all([first, journal.recordLateResult('general:0', { id: 'original', kind: 'unknown' }, review(), owner), journal.recordLateResult('general:1', { id: 'other', kind: 'paid' }, review('error'), owner)]);
    });
    const rows = await journal.readLateAudit(); expect(rows).toHaveLength(2);
    expect(rows.map(row => row.sequence)).toEqual([1, 2]); expect(rows[1]?.previousDigest).toBe(rows[0]?.digest);
    expect(rows.map(row => row.paidAttempt.id)).toEqual(['original', 'other']);
  });

  it.each(['missing intent', 'wrong cell', 'wrong kind', 'wrong model', 'wrong provider', 'wrong role', 'async lane', 'malformed findings', 'oversize'])(
    'refuses %s before creating any late-audit files', async mutation => {
      const { commonDir, journal, path } = await fixture();
      const cell = mutation === 'wrong cell' ? 'general:1' : 'general:0';
      const attempt = { id: mutation === 'missing intent' ? 'invented' : 'original', kind: mutation === 'wrong kind' ? 'paid' as const : 'unknown' as const };
      const extra = mutation === 'wrong model' ? { model: 'other' } : mutation === 'wrong provider' ? { provider: 'google' }
        : mutation === 'wrong role' ? { role: 'security' } : mutation === 'async lane' ? { async: true }
          : mutation === 'malformed findings' ? { findings: [{ id: 'incomplete' }] } : mutation === 'oversize' ? { error: 'x'.repeat(8 * 1024 * 1024) } : {};
      await expect(withNativeTarget(commonDir, target, owner => journal.recordLateResult(cell, attempt, review('error', extra), owner))).rejects.toThrow();
      expect(await readdir(path)).not.toContain('late-audit'); expect(await journal.readLateAudit()).toEqual([]);
    },
  );

  it('requires a sealed main journal and preserves stale, foreign and read-only ownership refusals', async () => {
    const { commonDir, journal, path, expired, frozen } = await fixture(false);
    await expect(withNativeTarget(commonDir, target, owner => journal.recordLateResult('general:0', { id: 'original', kind: 'unknown' }, review(), owner))).rejects.toThrow('checkpoint_late_requires_finalization');
    await expect(journal.recordLateResult('general:0', { id: 'original', kind: 'unknown' }, review(), expired)).rejects.toThrow('native_target_not_owned');
    await expect(withNativeTarget(commonDir, 'foreign-target', owner => journal.recordLateResult('general:0', { id: 'original', kind: 'unknown' }, review(), owner))).rejects.toThrow('native_target_not_owned');
    const readOnly = await CheckpointJournal.openRead(path, frozen);
    await expect(withNativeTarget(commonDir, target, owner => readOnly.recordLateResult('general:0', { id: 'original', kind: 'unknown' }, review(), owner))).rejects.toThrow('checkpoint_read_only');
    expect(await readdir(path)).not.toContain('late-audit');
  });

  it('refuses conflicting bytes for an already audited attempt, including concurrent submissions', async () => {
    const { commonDir, journal } = await fixture();
    await expect(withNativeTarget(commonDir, target, async owner => {
      const rows = await Promise.allSettled([journal.recordLateResult('general:0', { id: 'original', kind: 'unknown' }, review(), owner), journal.recordLateResult('general:0', { id: 'original', kind: 'unknown' }, review('error'), owner)]);
      expect(rows.map(row => row.status)).toEqual(['fulfilled', 'rejected']);
    })).rejects.toThrow('checkpoint_late_conflict');
    expect((await journal.readLateAudit()).map(row => row.reviewBytes)).toEqual([review()]);
  });

  it('retains an entire raw 8 MiB review even when its encoded audit record is larger', async () => {
    const { commonDir, journal, path } = await fixture();
    const raw = review('error'), bytes = raw + ' '.repeat(8 * 1024 * 1024 - Buffer.byteLength(raw));
    await withNativeTarget(commonDir, target, owner => journal.recordLateResult('general:0', { id: 'original', kind: 'unknown' }, bytes, owner));
    expect((await journal.readLateAudit())[0]?.reviewBytes).toBe(bytes);
    const encoded = await readFile(join(path, 'late-audit', '00000001.json'));
    expect(encoded.length).toBeGreaterThan(8 * 1024 * 1024); expect(encoded.length).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);
    await writeFile(join(path, 'late-audit', '00000001.json'), ' '.repeat(MAX_ARTIFACT_BYTES + 1));
    await expect(journal.readLateAudit()).rejects.toThrow('checkpoint_symlink');
  });

  it.each(['unchanged', 'plan', 'finalization', 'intent', 'cell', 'attempt kind', 'extra key', 'duplicate attempt'])(
    'validates a rehashed audit record with %s binding', async mutation => {
      const { commonDir, journal, path } = await fixture();
      await withNativeTarget(commonDir, target, owner => journal.recordLateResult('general:0', { id: 'original', kind: 'unknown' }, review(), owner));
      const file = join(path, 'late-audit', '00000001.json'), record = JSON.parse(await readFile(file, 'utf8'));
      if (mutation === 'plan') record.planDigest = '9'.repeat(64);
      else if (mutation === 'finalization') record.finalizationDigest = '9'.repeat(64);
      else if (mutation === 'intent') record.intentDigest = '9'.repeat(64);
      else if (mutation === 'cell') record.cell = 'general:1';
      else if (mutation === 'attempt kind') record.paidAttempt.kind = 'paid';
      else if (mutation === 'extra key') record.authoritative = true;
      else if (mutation === 'duplicate attempt') { record.sequence = 2; record.previousDigest = record.digest; }
      const canonical = (value: any): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
        ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
      delete record.digest; record.digest = hash(canonical(record));
      await writeFile(mutation === 'duplicate attempt' ? join(path, 'late-audit', '00000002.json') : file, canonical(record) + '\n', { mode: 0o600 });
      if (mutation === 'unchanged') {
        const rows = await journal.readLateAudit();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual(record);
      } else await expect(journal.readLateAudit()).rejects.toThrow();
    },
  );

  it.each(['directory', 'record', 'record-directory'] as const)('replays after %s fsync failure without duplicate audit or changed main proof', async point => {
    const { commonDir, journal, path, frozen } = await fixture(), proof = await exportCheckpointProof(journal);
    const fault = point === 'directory' ? path : point === 'record' ? join(path, 'late-audit', '00000001.json') : join(path, 'late-audit');
    await expect(withNativeTarget(commonDir, target, async owner => {
      const writer = await CheckpointJournal.openWrite({ commonDir, namespace, plan: frozen, ownership: owner });
      durability.failPath = fault; await writer.recordLateResult('general:0', { id: 'original', kind: 'unknown' }, review(), owner);
    })).rejects.toMatchObject({ code: 'EIO' });
    durability.synced = [];
    await withNativeTarget(commonDir, target, async owner => {
      const writer = await CheckpointJournal.openWrite({ commonDir, namespace, plan: frozen, ownership: owner });
      await writer.recordLateResult('general:0', { id: 'original', kind: 'unknown' }, review(), owner);
    });
    expect(durability.synced).toContain(fault); expect(await journal.readLateAudit()).toHaveLength(1); expect(await exportCheckpointProof(journal)).toEqual(proof);
  });

  it.each(['changed bytes', 'partial record', 'unknown entry', 'sequence gap', 'symlink', 'hardlink', 'unsafe mode', 'directory symlink'] as const)(
    'refuses %s in the audit segment without changing the already sealed main proof', async mutation => {
      const { commonDir, journal, path } = await fixture(), proof = await exportCheckpointProof(journal);
      await withNativeTarget(commonDir, target, owner => journal.recordLateResult('general:0', { id: 'original', kind: 'unknown' }, review(), owner));
      const directory = join(path, 'late-audit'), file = join(directory, '00000001.json');
      if (mutation === 'changed bytes') await writeFile(file, (await readFile(file, 'utf8')).replace('Late title', 'Changed title'));
      else if (mutation === 'partial record') await writeFile(file, '{');
      else if (mutation === 'unknown entry') await writeFile(join(directory, 'extra.txt'), 'unknown', { mode: 0o600 });
      else if (mutation === 'sequence gap') { await writeFile(join(directory, '00000003.json'), await readFile(file), { mode: 0o600 }); }
      else if (mutation === 'symlink') { const bytes = await readFile(file); await writeFile(join(commonDir, 'alias-source'), bytes, { mode: 0o600 }); await unlink(file); await symlink(join(commonDir, 'alias-source'), file); }
      else if (mutation === 'hardlink') await link(file, join(commonDir, 'extra-link'));
      else if (mutation === 'unsafe mode') await chmod(file, 0o644);
      else { await rm(directory, { recursive: true }); await mkdir(join(commonDir, 'alias-dir'), { mode: 0o700 }); await symlink(join(commonDir, 'alias-dir'), directory); }
      await expect(journal.readLateAudit()).rejects.toThrow();
      await expect(withNativeTarget(commonDir, target, owner => journal.recordLateResult('general:1', { id: 'other', kind: 'paid' }, review(), owner))).rejects.toThrow();
      expect(await exportCheckpointProof(journal)).toEqual(proof);
    },
  );
});
