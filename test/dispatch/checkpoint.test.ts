import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withNativeTarget, type NativeTargetOwnership } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, checkpointPath, freezeCheckpointPlan, type CheckpointPlanInput } from '../../src/dispatch/checkpoint.js';

const durability = vi.hoisted(() => ({ failPath: '', synced: [] as string[], pauseStagedWrite: false, stagedWriteStarted: undefined as (() => void) | undefined, stagedWriteRelease: undefined as Promise<void> | undefined, stagedWriteUsed: false }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), sync = handle.sync.bind(handle), path = String(args[0]);
    handle.sync = async () => {
      durability.synced.push(path);
      if (durability.failPath === path) {
        durability.failPath = '';
        throw Object.assign(new Error('synthetic fsync failure'), { code: 'EIO' });
      }
      return sync();
    };
    return new Proxy(handle, {
      get(file, property) {
        if (property === 'writeFile') return async (...writeArgs: Parameters<typeof file.writeFile>) => {
          if (durability.pauseStagedWrite && !durability.stagedWriteUsed && (path.includes('/.staging/') || path.includes('/events/'))) {
            durability.stagedWriteUsed = true;
            durability.stagedWriteStarted?.();
            await durability.stagedWriteRelease;
          }
          return file.writeFile(...writeArgs);
        };
        const value = Reflect.get(file, property, file);
        return typeof value === 'function' ? value.bind(file) : value;
      },
    });
  } };
});

const roots: string[] = [];
afterEach(async () => { durability.failPath = ''; durability.synced = []; durability.pauseStagedWrite = false; durability.stagedWriteStarted = undefined; durability.stagedWriteRelease = undefined; durability.stagedWriteUsed = false; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await realpath(await mkdtemp(join(tmpdir(), 'rcl-checkpoint-'))); roots.push(path); return path; }
const target = 'allocator-one/rcl#105', namespace = 'rcl-105-fixture';
function plan(overrides: Partial<CheckpointPlanInput> = {}): CheckpointPlanInput {
  return { target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: 'c'.repeat(64), configSha256: 'd'.repeat(64), specSha256: 'e'.repeat(64), contextSha256: '3'.repeat(64), toolsSha256: '4'.repeat(64), parser: { name: 'findings-json', version: 1 }, roster: [{ seat: 'blocking/general', model: 'openai/gpt-6-sol', role: 'general', route: 'openai' }], chunks: [{ index: 0, total: 1, digest: 'f'.repeat(64) }], prompts: [{ seat: 'blocking/general', chunk: 0, systemSha256: '1'.repeat(64), userSha256: '2'.repeat(64) }], ...overrides };
}
function failure(status = 'error') { return { kind: 'failure' as const, chunk: 0, possiblyBilled: true, reviewBytes: JSON.stringify({ model: 'openai/gpt-6-sol', role: 'general', provider: 'openai', status, durationMs: 7, findings: [], error: 'network', usage: { inputTokens: 2 } }) }; }
async function withStore<T>(work: (store: CheckpointJournal, ownership: NativeTargetOwnership, commonDir: string) => Promise<T>) { const commonDir = await root(); return withNativeTarget(commonDir, target, async ownership => work(await CheckpointJournal.create({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership }), ownership, commonDir)); }

describe('checkpoint plan', () => {
  it('freezes a complete per-seat prompt matrix and rejects missing/aliased identity inputs', () => {
    const input = plan(); const frozen = freezeCheckpointPlan(input);
    input.prompts[0]!.systemSha256 = '9'.repeat(64);
    expect(frozen.cells[0]?.systemPromptSha256).toBe('1'.repeat(64));
    expect(() => freezeCheckpointPlan(plan({ prompts: [] }))).toThrow('checkpoint_missing_prompt');
    expect(() => freezeCheckpointPlan(plan({ chunks: [{ index: 1, total: 2, digest: 'f'.repeat(64) }] }))).toThrow('checkpoint_incomplete_chunks');
    expect(() => freezeCheckpointPlan(plan({ headSha: 'short' }))).toThrow('checkpoint_invalid_head');
    expect(() => freezeCheckpointPlan(plan({ roster: [{ seat: 'blocking/general', model: 'openai/gpt-6-sol', role: 'general', route: 'openai' }, { seat: 'blocking/general', model: 'google/gemini-3.8-flash', role: 'general', route: 'google' }] }))).toThrow('checkpoint_duplicate_cell');
  });
  it('refuses a changed frozen plan before read reuse', async () => { const commonDir = await root(), path = checkpointPath(commonDir, target, namespace); await withNativeTarget(commonDir, target, ownership => CheckpointJournal.create({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership })); await expect(CheckpointJournal.openRead(path, freezeCheckpointPlan(plan({ specSha256: '9'.repeat(64) })))).rejects.toThrow('checkpoint_plan_mismatch'); });
});

describe('checkpoint journal', () => {
  it('retains a failed attempt then accepts a new successful paid attempt without overwriting history', async () => { const commonDir = await root(); let store!: CheckpointJournal; const bytes = JSON.stringify({ model: 'openai/gpt-6-sol', role: 'general', provider: 'openai', status: 'success', durationMs: 1, findings: [{ id: 'f1', file: 'a.ts', startLine: 1, endLine: 1, severity: 'important', category: 'correctness', title: 'Original title', description: 'Original finding' }] }); await withNativeTarget(commonDir, target, async ownership => { store = await CheckpointJournal.create({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership }); await store.recordIntent('blocking/general:0', { id: 'one', kind: 'paid' }, ownership); await store.recordResult('blocking/general:0', { id: 'one', kind: 'paid' }, failure(), ownership); await store.recordIntent('blocking/general:0', { id: 'two', kind: 'paid' }, ownership); await store.recordResult('blocking/general:0', { id: 'two', kind: 'paid' }, { kind: 'success', chunk: 0, reviewBytes: bytes }, ownership); const state = await store.read(); expect(state.successes[0]?.reviewBytes).toBe(bytes); expect(state.records.filter(record => record.type === 'result')).toHaveLength(2); }); await expect(withNativeTarget(commonDir, target, ownership => store.recordResult('blocking/general:0', { id: 'three', kind: 'paid' }, failure(), ownership))).rejects.toThrow('checkpoint_success_immutable'); });
  it('keeps interrupted intent uncertain and changed duplicate identities refuse', async () => { const commonDir = await root(); let store!: CheckpointJournal; await withNativeTarget(commonDir, target, async ownership => { store = await CheckpointJournal.create({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership }); await store.recordIntent('blocking/general:0', { id: 'possibly-billed', kind: 'unknown' }, ownership); expect((await store.read()).uncertain).toEqual([{ cell: 'blocking/general:0', paidAttempt: { id: 'possibly-billed', kind: 'unknown' } }]); }); await expect(withNativeTarget(commonDir, target, ownership => store.recordIntent('blocking/general:0', { id: 'possibly-billed', kind: 'paid' }, ownership))).rejects.toThrow('checkpoint_duplicate_attempt'); });
  it('serializes appends and rejects released/cross-target ownership', async () => { const commonDir = await root(); let released!: NativeTargetOwnership, writable!: CheckpointJournal; await withNativeTarget(commonDir, target, async ownership => { released = ownership; writable = await CheckpointJournal.create({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership }); await Promise.all([writable.recordIntent('blocking/general:0', { id: 'one', kind: 'paid' }, ownership), writable.recordUncertain('blocking/general:0', { id: 'one', kind: 'paid' }, 'interrupted', ownership)]); expect((await writable.read()).records.map(record => record.sequence)).toEqual([1, 2]); }); await expect(writable.recordIntent('blocking/general:0', { id: 'late', kind: 'paid' }, released)).rejects.toThrow('native_target_not_owned'); await expect(withNativeTarget(commonDir, 'another-target', other => writable.recordIntent('blocking/general:0', { id: 'bad', kind: 'paid' }, other))).rejects.toThrow('native_target_not_owned'); });
  it('does not expose an incomplete staged event to a concurrent read', async () => {
    const commonDir = await root();
    await withNativeTarget(commonDir, target, async ownership => {
      const store = await CheckpointJournal.create({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership });
      let started!: () => void, release!: () => void;
      const writingStarted = new Promise<void>(resolve => { started = resolve; });
      durability.pauseStagedWrite = true;
      durability.stagedWriteStarted = started;
      durability.stagedWriteRelease = new Promise<void>(resolve => { release = resolve; });
      const writing = store.recordIntent('blocking/general:0', { id: 'one', kind: 'paid' }, ownership);
      await writingStarted;
      try {
        const reader = await CheckpointJournal.openRead(checkpointPath(commonDir, target, namespace), freezeCheckpointPlan(plan()));
        expect((await reader.read()).records).toEqual([]);
      } finally { release(); await writing; }
      expect((await store.read()).records).toHaveLength(1);
    });
  });

  it('reads without writes and rejects symlink, partial, and result-path escape data', async () => { const commonDir = await root(), path = checkpointPath(commonDir, target, namespace); await withNativeTarget(commonDir, target, async ownership => { const store = await CheckpointJournal.create({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership }); await store.recordIntent('blocking/general:0', { id: 'one', kind: 'paid' }, ownership); }); const before = await readdir(path); await CheckpointJournal.openRead(path, freezeCheckpointPlan(plan())); expect(await readdir(path)).toEqual(before); const events = join(path, 'events'); await unlink(join(events, '00000001.json')); await symlink('../plan.json', join(events, '00000001.json')); await expect(CheckpointJournal.openRead(path, freezeCheckpointPlan(plan()))).rejects.toThrow('checkpoint_symlink'); await rm(path, { recursive: true, force: true }); await withNativeTarget(commonDir, target, async ownership => { const store = await CheckpointJournal.create({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership }); await store.recordIntent('blocking/general:0', { id: 'one', kind: 'paid' }, ownership); await store.recordResult('blocking/general:0', { id: 'one', kind: 'paid' }, { kind: 'success', chunk: 0, reviewBytes: JSON.stringify({ model: 'openai/gpt-6-sol', role: 'general', provider: 'openai', status: 'success', durationMs: 1, findings: [] }) }, ownership); }); const event = join(path, 'events', '00000002.json'); await writeFile(event, (await (await import('node:fs/promises')).readFile(event, 'utf8')).replace(/"resultFile":"[^"]+"/, '"resultFile":"../plan.json"')); await expect(CheckpointJournal.openRead(path, freezeCheckpointPlan(plan()))).rejects.toThrow('checkpoint_invalid_record'); });
  it('seals incomplete evidence with uncertain work intact and rejects all later writes', async () => { const commonDir = await root(); let store!: CheckpointJournal; await withNativeTarget(commonDir, target, async ownership => { store = await CheckpointJournal.create({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership }); await store.recordIntent('blocking/general:0', { id: 'one', kind: 'unknown' }, ownership); await store.finalize(ownership); const sealed = await store.read(); expect(sealed.finalized).toBe(true); expect(sealed.uncertain).toEqual([{ cell: 'blocking/general:0', paidAttempt: { id: 'one', kind: 'unknown' } }]); }); await expect(withNativeTarget(commonDir, target, ownership => store.recordIntent('blocking/general:0', { id: 'two', kind: 'paid' }, ownership))).rejects.toThrow('checkpoint_finalized'); });
});

describe('checkpoint retained-review validation', () => {
  it('rejects raw reviews that do not match the planned provider, role, status, or chunk', async () => {
    const commonDir = await root(); let store!: CheckpointJournal;
    await withNativeTarget(commonDir, target, async ownership => { store = await CheckpointJournal.create({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership }); await store.recordIntent('blocking/general:0', { id: 'one', kind: 'paid' }, ownership); });
    await expect(withNativeTarget(commonDir, target, ownership => store.recordResult('blocking/general:0', { id: 'one', kind: 'paid' }, { kind: 'success', chunk: 1, reviewBytes: JSON.stringify({ model: 'openai/gpt-6-sol', role: 'general', provider: 'openai', status: 'success', durationMs: 1, findings: [] }) }, ownership))).rejects.toThrow('checkpoint_result_cell_mismatch');
  });

  it('retains validated raw failure bytes in additive outcomes across a writer restart', async () => {
    const commonDir = await root(); let path = '';
    await withNativeTarget(commonDir, target, async ownership => {
      const store = await CheckpointJournal.create({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership });
      path = checkpointPath(commonDir, target, namespace);
      await store.recordIntent('blocking/general:0', { id: 'one', kind: 'paid' }, ownership);
      await store.recordResult('blocking/general:0', { id: 'one', kind: 'paid' }, failure(), ownership);
    });
    await withNativeTarget(commonDir, target, async ownership => {
      const resumed = await CheckpointJournal.openWrite({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership });
      expect(resumed.getPlan()).toEqual(freezeCheckpointPlan(plan()));
      expect(Object.isFrozen(resumed.getPlan())).toBe(true);
      expect((await resumed.read()).outcomes).toEqual([{ cell: 'blocking/general:0', paidAttempt: { id: 'one', kind: 'paid' }, result: failure() }]);
    });
    expect(path).toContain('rcl-checkpoints');
  });
});


function completeReview(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ model: 'openai/gpt-6-sol', role: 'general', provider: 'openai', status: 'success', durationMs: 1, findings: [], ...overrides });
}

describe('checkpoint source and durability boundaries', () => {
  it.each([
    ['incomplete finding', { findings: [{ id: 'f1' }] }],
    ['invalid location', { findings: [{ id: 'f1', file: 'a.ts', startLine: 2, endLine: 1, severity: 'important', category: 'correctness', title: 'T', description: 'D' }] }],
    ['invalid usage shape', { usage: [1, 2] }],
    ['invalid warning', { warnings: [1] }],
    ['invalid error', { error: { message: 'lost' } }],
    ['invalid async marker', { async: 'false' }],
  ])('rejects %s without persisting an accepted result', async (_name, overrides) => {
    const commonDir = await root();
    await withNativeTarget(commonDir, target, async ownership => {
      const store = await CheckpointJournal.create({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership });
      await store.recordIntent('blocking/general:0', { id: 'one', kind: 'paid' }, ownership);
    });
    await expect(withNativeTarget(commonDir, target, async ownership => {
      const store = await CheckpointJournal.openWrite({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership });
      await store.recordResult('blocking/general:0', { id: 'one', kind: 'paid' }, { kind: 'success', chunk: 0, reviewBytes: completeReview(overrides) }, ownership);
    })).rejects.toThrow(/checkpoint_.*result/);
    const read = await CheckpointJournal.openRead(checkpointPath(commonDir, target, namespace), freezeCheckpointPlan(plan()));
    expect((await read.read()).outcomes).toEqual([]);
    expect(await readdir(join(checkpointPath(commonDir, target, namespace), 'results'))).toEqual([]);
  });

  it('preserves complete valid findings, normalized location provenance, diagnostics and usage byte for byte', async () => {
    const bytes = completeReview({ findings: [{ id: 'f1', file: 'a.ts', startLine: 1, endLine: 2, severity: 'important', category: 'correctness', title: 'Title', description: 'Description', suggestedFix: 'Fix', locationProvenance: { version: 1, source: 'parser', reason: 'reversed_range', originalStartLine: 2, originalEndLine: 1 } }], droppedFindings: 1, warnings: ['preserved warning'], usage: { inputTokens: 4, outputTokens: 7, reasoningTokens: 3 } });
    await withStore(async (store, ownership) => {
      await store.recordIntent('blocking/general:0', { id: 'one', kind: 'paid' }, ownership);
      await store.recordResult('blocking/general:0', { id: 'one', kind: 'paid' }, { kind: 'success', chunk: 0, reviewBytes: bytes }, ownership);
      expect((await store.read()).successes[0]!.reviewBytes).toBe(bytes);
    });
  });

  it('rejects a writable namespace alias to another private root before changing either journal', async () => {
    const commonDir = await root(), other = await root(), frozen = freezeCheckpointPlan(plan());
    await withNativeTarget(other, target, ownership => CheckpointJournal.create({ commonDir: other, namespace, plan: frozen, ownership }));
    const original = checkpointPath(other, target, namespace), alias = checkpointPath(commonDir, target, namespace);
    await mkdir(join(alias, '..'), { recursive: true, mode: 0o700 });
    await symlink(original, alias);
    const before = await readdir(join(original, 'events'));
    await expect(withNativeTarget(commonDir, target, ownership => CheckpointJournal.openWrite({ commonDir, namespace, plan: frozen, ownership }))).rejects.toThrow(/checkpoint_.*(?:alias|directory)/);
    expect(await readdir(join(original, 'events'))).toEqual(before);
  });

  it('captures creation namespace before awaiting ownership', async () => {
    const commonDir = await root();
    await withNativeTarget(commonDir, target, async ownership => {
      const input = { commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership };
      const creating = CheckpointJournal.create(input);
      input.namespace = 'changed-after-call';
      await creating;
      expect(await readFile(join(checkpointPath(commonDir, target, namespace), 'plan.json'), 'utf8')).toContain(input.plan.digest);
      await expect(readdir(checkpointPath(commonDir, target, 'changed-after-call'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('snapshots queued attempt and result inputs before ownership awaits', async () => {
    await withStore(async (store, ownership) => {
      const attempt = { id: 'original', kind: 'paid' as const };
      const pending = store.recordIntent('blocking/general:0', attempt, ownership);
      attempt.id = 'mutated';
      await pending;
      expect((await store.read()).records[0]!.paidAttempt).toEqual({ id: 'original', kind: 'paid' });
      const bytes = completeReview(), result = { kind: 'success' as const, chunk: 0, reviewBytes: bytes };
      const saving = store.recordResult('blocking/general:0', { id: 'original', kind: 'paid' }, result, ownership);
      result.reviewBytes = completeReview({ warnings: ['late caller mutation'] });
      await saving;
      expect((await store.read()).successes[0]!.reviewBytes).toBe(bytes);
    });
  });

  it('does not permit one physical attempt identity to fill two different cells', async () => {
    const commonDir = await root(), input = plan();
    input.roster.push({ ...input.roster[0]!, seat: 'blocking/second' });
    input.prompts.push({ ...input.prompts[0]!, seat: 'blocking/second' });
    const frozen = freezeCheckpointPlan(input);
    await withNativeTarget(commonDir, target, async ownership => {
      const store = await CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership });
      await store.recordIntent('blocking/general:0', { id: 'same-physical-attempt', kind: 'paid' }, ownership);
    });
    await expect(withNativeTarget(commonDir, target, async ownership => {
      const store = await CheckpointJournal.openWrite({ commonDir, namespace, plan: frozen, ownership });
      await store.recordIntent('blocking/second:0', { id: 'same-physical-attempt', kind: 'paid' }, ownership);
    })).rejects.toThrow(/checkpoint_duplicate_attempt/);
  });

  it('rejects an oversized plan before creating its namespace', async () => {
    const commonDir = await root(), frozen = freezeCheckpointPlan(plan({ parser: { name: 'x'.repeat(8 * 1024 * 1024), version: 1 } }));
    await expect(withNativeTarget(commonDir, target, ownership => CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership }))).rejects.toThrow('checkpoint_file_too_large');
    await expect(readdir(checkpointPath(commonDir, target, namespace))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['intent-file', 'result-file', 'result-directory', 'result-event', 'finalization-directory'] as const)(
    're-establishes durability after %s fsync failure without duplicating history', async point => {
      const commonDir = await root(), frozen = freezeCheckpointPlan(plan()), path = checkpointPath(commonDir, target, namespace);
      const attempt = { id: 'one', kind: 'paid' as const }, cell = 'blocking/general:0';
      const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
      const resultPath = join(path, 'results', `${hash(cell)}-${hash(attempt.id)}.json`);
      const result = { kind: 'success' as const, chunk: 0, reviewBytes: completeReview() };
      await withNativeTarget(commonDir, target, async ownership => {
        const store = await CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership });
        if (point !== 'intent-file') await store.recordIntent(cell, attempt, ownership);
      });
      const faultPath = point === 'intent-file' ? join(path, 'events', '00000001.json')
        : point === 'result-file' ? resultPath
        : point === 'result-directory' ? join(path, 'results')
        : point === 'result-event' ? join(path, 'events', '00000002.json') : join(path, 'events');
      await expect(withNativeTarget(commonDir, target, async ownership => {
        const store = await CheckpointJournal.openWrite({ commonDir, namespace, plan: frozen, ownership });
        durability.failPath = faultPath;
        if (point === 'intent-file') await store.recordIntent(cell, attempt, ownership);
        else if (point === 'finalization-directory') await store.finalize(ownership);
        else await store.recordResult(cell, attempt, result, ownership);
      })).rejects.toMatchObject({ code: 'EIO' });
      const prior = await readdir(join(path, 'events'));
      durability.synced = [];
      await withNativeTarget(commonDir, target, async ownership => {
        const store = await CheckpointJournal.openWrite({ commonDir, namespace, plan: frozen, ownership });
        if (point === 'intent-file') await store.recordIntent(cell, attempt, ownership);
        else if (point === 'finalization-directory') await store.finalize(ownership);
        else await store.recordResult(cell, attempt, result, ownership);
        const state = await store.read();
        expect(state.records.filter(row => row.type === 'intent')).toHaveLength(1);
        if (point.startsWith('result')) expect(state.successes).toEqual([{ cell, paidAttempt: attempt, reviewBytes: result.reviewBytes }]);
        if (point === 'finalization-directory') expect(state.finalized).toBe(true);
      });
      expect(durability.synced).toContain(faultPath);
      const after = await readdir(join(path, 'events'));
      expect(after.length).toBe(point === 'result-file' || point === 'result-directory' ? prior.length + 1 : prior.length);
    },
  );
});


describe('checkpoint interrupted files', () => {
  it.each(['event', 'orphan-result'] as const)('refuses a partial %s without changing its bytes or accepting a review', async kind => {
    const commonDir = await root(), frozen = freezeCheckpointPlan(plan()), path = checkpointPath(commonDir, target, namespace);
    const attempt = { id: 'one', kind: 'paid' as const }, cell = 'blocking/general:0';
    await withNativeTarget(commonDir, target, async ownership => {
      const store = await CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership });
      await store.recordIntent(cell, attempt, ownership);
    });
    const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
    const partial = kind === 'event' ? join(path, 'events', '00000002.json') : join(path, 'results', `${hash(cell)}-${hash(attempt.id)}.json`);
    await writeFile(partial, '{', { mode: 0o600 });
    if (kind === 'event') await expect(CheckpointJournal.openRead(path, frozen)).rejects.toThrow('checkpoint_invalid_record');
    else {
      await expect(withNativeTarget(commonDir, target, async ownership => {
        const store = await CheckpointJournal.openWrite({ commonDir, namespace, plan: frozen, ownership });
        await store.recordResult(cell, attempt, { kind: 'success', chunk: 0, reviewBytes: completeReview() }, ownership);
      })).rejects.toThrow('checkpoint_changing_source');
      const state = await (await CheckpointJournal.openRead(path, frozen)).read();
      expect(state.successes).toEqual([]);
      expect(state.uncertain).toEqual([{ cell, paidAttempt: attempt }]);
    }
    expect(await readFile(partial, 'utf8')).toBe('{');
  });

  it('refuses oversized outcome bytes without publishing a result file or event', async () => {
    const commonDir = await root(), frozen = freezeCheckpointPlan(plan()), path = checkpointPath(commonDir, target, namespace);
    await withNativeTarget(commonDir, target, async ownership => {
      const store = await CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership });
      await store.recordIntent('blocking/general:0', { id: 'one', kind: 'paid' }, ownership);
    });
    await expect(withNativeTarget(commonDir, target, async ownership => {
      const store = await CheckpointJournal.openWrite({ commonDir, namespace, plan: frozen, ownership });
      await store.recordResult('blocking/general:0', { id: 'one', kind: 'paid' }, { kind: 'failure', chunk: 0, possiblyBilled: true, reviewBytes: completeReview({ status: 'error', error: 'x'.repeat(8 * 1024 * 1024) }) }, ownership);
    })).rejects.toThrow('checkpoint_file_too_large');
    expect(await readdir(join(path, 'results'))).toEqual([]);
    expect(await readdir(join(path, 'events'))).toEqual(['00000001.json']);
  });
});


describe('immutable checkpoint metadata bindings', () => {
  it('reads an existing journal without bindings as empty without writing anything', async () => {
    await withStore(async (store, _ownership, commonDir) => {
      const path = checkpointPath(commonDir, target, namespace), before = await readdir(path);
      expect(await store.readBindings()).toEqual({});
      expect(await readdir(path)).toEqual(before);
      expect((await store.read()).records).toEqual([]);
    });
  });

  it('serializes all closed names and identical concurrent replays into one immutable record each', async () => {
    await withStore(async (store, ownership, commonDir) => {
      let args = { name: 'captured-inputs' as const, bytes: 'captured exact bytes\n' };
      const first = store.bind(args.name, args.bytes, ownership);
      args = { name: 'captured-inputs', bytes: 'changed caller value' };
      await Promise.all([first, store.bind('source', '', ownership), store.bind('operation', '\uFEFFoperation bytes', ownership), store.bind('source', '', ownership)]);
      expect(await store.readBindings()).toEqual({ 'captured-inputs': 'captured exact bytes\n', source: '', operation: '\uFEFFoperation bytes' });
      const state = await store.read();
      expect(state.records.map(row => row.type)).toEqual(['binding', 'binding', 'binding']);
      expect(state.records[0]!.previousDigest).toBe(store.getPlan().digest);
      for (let index = 1; index < state.records.length; index++) expect(state.records[index]!.previousDigest).toBe(state.records[index - 1]!.digest);
      const path = checkpointPath(commonDir, target, namespace);
      for (const record of state.records) {
        const binding = record.binding!;
        const bytes = await readFile(join(path, binding.file), 'utf8');
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(binding.sha256);
      }
    });
  });

  it('rejects concurrent conflicting bytes while preserving the first binding and history', async () => {
    const commonDir = await root(), frozen = freezeCheckpointPlan(plan());
    await expect(withNativeTarget(commonDir, target, async ownership => {
      const store = await CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership });
      const results = await Promise.allSettled([store.bind('source', 'original', ownership), store.bind('source', 'different', ownership)]);
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    })).rejects.toThrow('checkpoint_binding_conflict');
    const store = await CheckpointJournal.openRead(checkpointPath(commonDir, target, namespace), frozen);
    expect(await store.readBindings()).toEqual({ source: 'original' });
    expect((await store.read()).records).toHaveLength(1);
  });

  it.each(['intent', 'finalization'] as const)('prevents a new binding after %s but permits identical durable replay', async phase => {
    const commonDir = await root(), frozen = freezeCheckpointPlan(plan());
    await withNativeTarget(commonDir, target, async ownership => {
      const store = await CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership });
      await store.bind('source', 'original', ownership);
      if (phase === 'intent') await store.recordIntent('blocking/general:0', { id: 'one', kind: 'unknown' }, ownership);
      else await store.finalize(ownership);
      const before = JSON.stringify(await store.read());
      durability.synced = [];
      await store.bind('source', 'original', ownership);
      expect(JSON.stringify(await store.read())).toBe(before);
      expect(durability.synced).toContain(join(checkpointPath(commonDir, target, namespace), 'binding-source.data'));
    });
    await expect(withNativeTarget(commonDir, target, async ownership => {
      const store = await CheckpointJournal.openWrite({ commonDir, namespace, plan: frozen, ownership });
      await store.bind('operation', 'new', ownership);
    })).rejects.toThrow(phase === 'intent' ? 'checkpoint_binding_closed' : 'checkpoint_finalized');
    await expect(withNativeTarget(commonDir, target, async ownership => {
      const store = await CheckpointJournal.openWrite({ commonDir, namespace, plan: frozen, ownership });
      await store.bind('source', 'changed', ownership);
    })).rejects.toThrow('checkpoint_binding_conflict');
    const read = await CheckpointJournal.openRead(checkpointPath(commonDir, target, namespace), frozen);
    expect(await read.readBindings()).toEqual({ source: 'original' });
    expect((await read.read()).records).toHaveLength(2);
  });

  it.each(['../source', '__proto__', 'constructor', 'unknown', ''])(
    'refuses unsupported binding name %s before publishing bytes', async name => {
      const commonDir = await root();
      await expect(withNativeTarget(commonDir, target, async ownership => {
        const store = await CheckpointJournal.create({ commonDir, namespace, plan: freezeCheckpointPlan(plan()), ownership });
        const before = await readdir(checkpointPath(commonDir, target, namespace));
        await expect(store.bind(name as never, 'bytes', ownership)).rejects.toThrow('checkpoint_invalid_binding');
        expect(await readdir(checkpointPath(commonDir, target, namespace))).toEqual(before);
      })).resolves.toBeUndefined();
    },
  );

  it('requires primitive round-trippable UTF-8 strings and enforces the existing byte bound', async () => {
    await withStore(async (store, ownership, commonDir) => {
      await expect(store.bind('source', new String('object') as never, ownership)).rejects.toThrow('checkpoint_invalid_binding');
      await expect(store.bind('source', '\uD800', ownership)).rejects.toThrow('checkpoint_invalid_binding');
      await expect(store.bind('source', 'é'.repeat(4 * 1024 * 1024 + 1), ownership)).rejects.toThrow('checkpoint_file_too_large');
      expect(await store.readBindings()).toEqual({});
      expect(await readdir(checkpointPath(commonDir, target, namespace))).toEqual(['events', 'plan.json', 'results']);
      const bytes = 'x'.repeat(8 * 1024 * 1024);
      await store.bind('captured-inputs', bytes, ownership);
      expect((await store.readBindings())['captured-inputs']).toBe(bytes);
    });
  });

  it('preserves stale-owner and read-only-store refusal for metadata writes', async () => {
    const commonDir = await root(), frozen = freezeCheckpointPlan(plan()); let expired!: NativeTargetOwnership; let store!: CheckpointJournal;
    await withNativeTarget(commonDir, target, async ownership => { expired = ownership; store = await CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership }); });
    await expect(store.bind('source', 'bytes', expired)).rejects.toThrow('native_target_not_owned');
    const read = await CheckpointJournal.openRead(checkpointPath(commonDir, target, namespace), frozen);
    await expect(withNativeTarget(commonDir, target, ownership => read.bind('source', 'bytes', ownership))).rejects.toThrow('checkpoint_read_only');
  });

  it.each(['file', 'file-directory', 'event', 'event-directory'] as const)(
    'resumes binding publication after %s fsync failure without adding a duplicate record', async point => {
      const commonDir = await root(), frozen = freezeCheckpointPlan(plan()), path = checkpointPath(commonDir, target, namespace);
      await withNativeTarget(commonDir, target, ownership => CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership }));
      const faultPath = point === 'file' ? join(path, 'binding-source.data') : point === 'file-directory' ? path
        : point === 'event' ? join(path, 'events', '00000001.json') : join(path, 'events');
      await expect(withNativeTarget(commonDir, target, async ownership => {
        const store = await CheckpointJournal.openWrite({ commonDir, namespace, plan: frozen, ownership });
        durability.failPath = faultPath;
        await store.bind('source', 'exact source bytes', ownership);
      })).rejects.toMatchObject({ code: 'EIO' });
      const before = await CheckpointJournal.openRead(path, frozen);
      expect(await before.readBindings()).toEqual(point === 'file' || point === 'file-directory' ? {} : { source: 'exact source bytes' });
      durability.synced = [];
      await withNativeTarget(commonDir, target, async ownership => {
        const resumed = await CheckpointJournal.openWrite({ commonDir, namespace, plan: frozen, ownership });
        await resumed.bind('source', 'exact source bytes', ownership);
        expect(await resumed.readBindings()).toEqual({ source: 'exact source bytes' });
        expect((await resumed.read()).records).toHaveLength(1);
        await resumed.finalize(ownership);
        expect((await resumed.read()).finalized).toBe(true);
      });
      expect(durability.synced).toContain(faultPath);
    },
  );

  it.each(['changed bytes', 'symlink', 'unsafe mode'] as const)('rejects %s in a referenced binding on read and finalization', async change => {
    const commonDir = await root(), frozen = freezeCheckpointPlan(plan()), path = checkpointPath(commonDir, target, namespace);
    let store!: CheckpointJournal;
    await withNativeTarget(commonDir, target, async ownership => { store = await CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership }); await store.bind('source', 'original', ownership); });
    const file = join(path, 'binding-source.data');
    if (change === 'changed bytes') await writeFile(file, 'modified');
    else if (change === 'unsafe mode') await chmod(file, 0o644);
    else { await writeFile(join(commonDir, 'other'), 'original', { mode: 0o600 }); await unlink(file); await symlink(join(commonDir, 'other'), file); }
    await expect(store.readBindings()).rejects.toThrow(/checkpoint_(?:binding_tampered|symlink)/);
    await expect(withNativeTarget(commonDir, target, ownership => store.finalize(ownership))).rejects.toThrow(/checkpoint_(?:binding_tampered|symlink)/);
    expect(await readdir(join(path, 'events'))).toEqual(['00000001.json']);
  });

  it('refuses conflicting or partial unpublished binding bytes without overwriting them', async () => {
    const commonDir = await root(), frozen = freezeCheckpointPlan(plan()), path = checkpointPath(commonDir, target, namespace);
    await withNativeTarget(commonDir, target, ownership => CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership }));
    await writeFile(join(path, 'binding-source.data'), '{', { mode: 0o600 });
    await expect(withNativeTarget(commonDir, target, async ownership => {
      const store = await CheckpointJournal.openWrite({ commonDir, namespace, plan: frozen, ownership });
      await store.bind('source', '{"complete":true}', ownership);
    })).rejects.toThrow('checkpoint_binding_conflict');
    expect(await readFile(join(path, 'binding-source.data'), 'utf8')).toBe('{');
    expect(await readdir(join(path, 'events'))).toEqual([]);
  });

  it('reflushes referenced binding bytes on initial and repeated finalization', async () => {
    await withStore(async (store, ownership, commonDir) => {
      await store.bind('source', 'original', ownership);
      const path = checkpointPath(commonDir, target, namespace);
      for (let index = 0; index < 2; index++) {
        durability.synced = [];
        await store.finalize(ownership);
        expect(durability.synced).toContain(join(path, 'binding-source.data'));
        expect(durability.synced).toContain(join(path, 'events', '00000001.json'));
        expect((await store.read()).records).toHaveLength(2);
      }
    });
  });

  it.each(['duplicate', 'after intent', 'wrong filename', 'unknown name', 'extra metadata', 'binding on intent'] as const)(
    'rejects a recomputed hash chain containing %s rather than trusting the writer API', async mutation => {
      const commonDir = await root(), frozen = freezeCheckpointPlan(plan()), path = checkpointPath(commonDir, target, namespace);
      await withNativeTarget(commonDir, target, async ownership => {
        const store = await CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership });
        await store.bind('source', 'original', ownership);
        await store.recordIntent('blocking/general:0', { id: 'one', kind: 'unknown' }, ownership);
      });
      const binding = JSON.parse(await readFile(join(path, 'events', '00000001.json'), 'utf8'));
      const intent = JSON.parse(await readFile(join(path, 'events', '00000002.json'), 'utf8'));
      let records = [binding, intent];
      if (mutation === 'duplicate') records = [binding, structuredClone(binding)];
      else if (mutation === 'after intent') records = [intent, binding];
      else if (mutation === 'wrong filename') binding.binding.file = '../plan.json';
      else if (mutation === 'unknown name') binding.binding.name = '__proto__';
      else if (mutation === 'extra metadata') binding.binding.ignored = true;
      else intent.binding = binding.binding;
      const canonical = (value: any): string => value === null || typeof value !== 'object' ? JSON.stringify(value)
        : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
          : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
      let previousDigest = frozen.digest;
      for (const [index, record] of records.entries()) {
        delete record.digest;
        record.sequence = index + 1;
        record.previousDigest = previousDigest;
        record.digest = createHash('sha256').update(canonical(record)).digest('hex');
        previousDigest = record.digest;
        await writeFile(join(path, 'events', `${String(index + 1).padStart(8, '0')}.json`), canonical(record) + '\n');
      }
      await expect(CheckpointJournal.openRead(path, frozen)).rejects.toThrow(/checkpoint_(?:invalid_binding|binding_closed|duplicate_binding|invalid_record)/);
    },
  );
});
