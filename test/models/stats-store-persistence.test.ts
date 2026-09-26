import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { appendCalls, appendOutcomes, loadModelStats } from '../../src/models/stats-store.js';

const fault = vi.hoisted(() => ({ syncFailures: 0, syncAttempts: 0, readAttempts: 0, partialWrite: false,
  directory: '', openDenied: '', openedPaths: [] as string[] }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (fault.openDenied && String(args[0]) === fault.openDenied) {
      throw Object.assign(new Error('Injected read-only model history'), { code: 'EROFS' });
    }
    const handle = await fs.open(...args);
    fault.openedPaths.push(String(args[0]));
    if (String(args[0]) === fault.directory || ['calls.jsonl', 'outcomes.jsonl'].includes(basename(String(args[0])))) {
      const sync = handle.sync.bind(handle);
      const read = handle.readFile.bind(handle);
      const write = handle.writeFile.bind(handle);
      handle.sync = async () => {
        fault.syncAttempts++;
        if (fault.syncFailures > 0) {
          fault.syncFailures--;
          throw Object.assign(new Error('Injected model history fsync failure'), { code: 'EIO' });
        }
        return sync();
      };
      handle.writeFile = async (...input: Parameters<typeof handle.writeFile>) => {
        if (fault.partialWrite) {
          fault.partialWrite = false;
          const text = String(input[0]);
          await write(text.slice(0, text.indexOf('\n') + 12));
          throw Object.assign(new Error('Injected interrupted append'), { code: 'EIO' });
        }
        return write(...input);
      };
      handle.readFile = async (...input: Parameters<typeof handle.readFile>) => {
        fault.readAttempts++;
        return read(...input);
      };
    }
    return handle;
  } };
});

let dir: string;
const children: ChildProcess[] = [];
const now = new Date('2026-09-22T12:00:00Z');
const call = (recordId: string) => ({ recordId, ts: now.toISOString(), model: 'fixture', role: 'general',
  durationMs: 25, status: 'success', source: 'live' as const });
const outcome = (recordId: string, sequence: number, verdict: 'fixed' | 'dismissed') => ({
  recordId, order: { scope: 'original-repository/target', sequence }, ts: now.toISOString(),
  target: 'target', findingKey: 'finding', models: ['fixture'], verdict, source: 'live' as const,
});

beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-history-persistence-'))); });
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await once(child, 'exit');
    }
  }
  fault.syncFailures = 0; fault.syncAttempts = 0; fault.readAttempts = 0; fault.partialWrite = false;
  fault.directory = ''; fault.openDenied = ''; fault.openedPaths = [];
  await rm(dir, { recursive: true, force: true });
});
const records = async (file: string) => (await readFile(join(dir, file), 'utf8')).trim().split('\n').flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});

type ProtocolEvent = { type: 'rcl-stats-store-protocol'; event: string; path?: string };
type ProtocolChild = { child: ChildProcess; events: ProtocolEvent[]; stderr: () => string };

function protocolChild(path: string, recordId: string, pauseAt?: string, legacy = false): ProtocolChild {
  const events: ProtocolEvent[] = [];
  let stderr = '';
  const child = fork(resolve('test/fixtures/stats-store-protocol-child.ts'), [path, recordId], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', NODE_NO_WARNINGS: '1',
      RCL_TEST_STATS_STORE_TRACE: '1', ...(pauseAt ? { RCL_TEST_STATS_STORE_PAUSE_AT: pauseAt } : {}),
      ...(legacy ? { RCL_TEST_STATS_STORE_LEGACY: '1' } : {}) },
  });
  children.push(child);
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  child.on('message', message => {
    if (message && typeof message === 'object' &&
        (message as { type?: unknown }).type === 'rcl-stats-store-protocol') events.push(message as ProtocolEvent);
  });
  return { child, events, stderr: () => stderr };
}

async function protocolEvent(run: ProtocolChild, event: string): Promise<ProtocolEvent> {
  const seen = run.events.find(value => value.event === event);
  if (seen) return seen;
  return await new Promise<ProtocolEvent>((resolveEvent, reject) => {
    const timeout = setTimeout(() => {
      cleanup(); reject(new Error(`protocol event ${event} timed out; events=${JSON.stringify(run.events)} stderr=${run.stderr()}`));
    }, 10_000);
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const value = message as Partial<ProtocolEvent>;
      if (value.type !== 'rcl-stats-store-protocol' || value.event !== event) return;
      cleanup(); resolveEvent(value as ProtocolEvent);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup(); reject(new Error(`child exited before ${event}: code=${code} signal=${signal} stderr=${run.stderr()}`));
    };
    const cleanup = () => { clearTimeout(timeout); run.child.off('message', onMessage); run.child.off('exit', onExit); };
    run.child.on('message', onMessage); run.child.once('exit', onExit);
  });
}

async function successfulProtocolChild(run: ProtocolChild): Promise<void> {
  if (run.child.exitCode === null && run.child.signalCode === null) await once(run.child, 'exit');
  expect({ code: run.child.exitCode, signal: run.child.signalCode, stderr: run.stderr() })
    .toEqual({ code: 0, signal: null, stderr: '' });
}

function eventIndex(run: ProtocolChild, event: string, path?: string): number {
  const index = run.events.findIndex(value => value.event === event && (path === undefined || value.path === path));
  expect(index, `missing protocol event ${event}${path ? ` at ${path}` : ''}`).toBeGreaterThanOrEqual(0);
  return index;
}

it('retries the same retained call without duplicating physical history', async () => {
  await appendCalls([call('operation:0')], dir);
  const before = await readFile(join(dir, 'calls.jsonl'));
  await appendCalls([call('operation:0')], dir);
  expect(await readFile(join(dir, 'calls.jsonl'))).toEqual(before);
  expect((await loadModelStats({ dir, now }))[0]?.calls).toBe(1);
});

it('retains separate original calls with identical visible model and timing fields', async () => {
  await appendCalls([call('operation:0'), call('operation:1')], dir);
  await appendCalls([call('operation:0'), call('operation:1')], dir);
  expect((await records('calls.jsonl')).map(row => row.recordId)).toEqual(['operation:0', 'operation:1']);
  expect((await loadModelStats({ dir, now }))[0]?.calls).toBe(2);
});

it('rejects mixed retained and legacy batches before creating history', async () => {
  const missing = join(dir, 'mixed');
  await expect(appendCalls([call('operation:0'), { ...call('legacy:0'), recordId: undefined }], missing))
    .rejects.toThrow('mixed_precision_batch');
  await expect(readFile(join(missing, 'calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses an existing record identity reused for different evidence without changing history', async () => {
  await appendCalls([call('operation:0')], dir);
  const before = await readFile(join(dir, 'calls.jsonl'));
  await expect(appendCalls([{ ...call('operation:0'), status: 'error' }], dir)).rejects.toThrow('precision_record_conflict');
  expect(await readFile(join(dir, 'calls.jsonl'))).toEqual(before);
});

it('keeps later logical triage effective when an earlier outcome is persisted last', async () => {
  const later = { ...outcome('later:0', 2, 'dismissed'), ts: '2026-09-22T11:59:00Z' };
  await appendOutcomes([later], dir);
  await appendOutcomes([outcome('earlier:0', 1, 'fixed')], dir);
  const [stats] = await loadModelStats({ dir, now });
  expect(stats).toMatchObject({ outcomes: 1, fixed: 0 });
  expect(await records('outcomes.jsonl')).toHaveLength(2);
});

it('serializes concurrent retries of one retained batch', async () => {
  await Promise.all(Array.from({ length: 4 }, () => appendCalls([call('operation:0')], dir)));
  expect(await records('calls.jsonl')).toHaveLength(1);
});

it('preserves one physical batch across concurrent processes and a later restart', async () => {
  const program = `import {appendCalls} from ${JSON.stringify(new URL('../../src/models/stats-store.ts', import.meta.url).href)};
    await appendCalls(JSON.parse(process.argv[1]), process.argv[2]);`;
  const batch = JSON.stringify([call('operation:0'), call('operation:1')]);
  const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, batch, dir], {
    timeout: 10_000, env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' },
  });
  const concurrent = await Promise.all([run(), run(), run()]);
  expect(concurrent).toHaveLength(3);
  concurrent.forEach(result => expect(result).toMatchObject({ stdout: '', stderr: '' }));
  const before = await readFile(join(dir, 'calls.jsonl'));
  const restarted = await run();
  expect(restarted.stderr).toBe('');
  expect(await readFile(join(dir, 'calls.jsonl'))).toEqual(before);
  expect((await records('calls.jsonl')).map(row => row.recordId)).toEqual(['operation:0', 'operation:1']);
});

it('resumes after an interrupted multi-record append while retaining the torn original tail', async () => {
  fault.partialWrite = true;
  const batch = [call('operation:0'), call('operation:1')];
  await expect(appendCalls(batch, dir)).rejects.toMatchObject({ code: 'EIO' });
  const interrupted = await readFile(join(dir, 'calls.jsonl'), 'utf8');
  await appendCalls(batch, dir);
  expect((await readFile(join(dir, 'calls.jsonl'), 'utf8')).startsWith(interrupted)).toBe(true);
  expect((await records('calls.jsonl')).map(row => row.recordId)).toEqual(['operation:0', 'operation:1']);
  await appendCalls(batch, dir);
  expect((await loadModelStats({ dir, now }))[0]?.calls).toBe(2);
});

it.each(['calls', 'outcomes'] as const)('requires successful fsync before acknowledging existing %s on retry', async kind => {
  const persist = () => kind === 'calls'
    ? appendCalls([call('operation:0')], dir)
    : appendOutcomes([outcome('operation:0', 1, 'fixed')], dir);
  fault.syncFailures = 2;
  await expect(persist()).rejects.toMatchObject({ code: 'EIO' });
  const before = await readFile(join(dir, `${kind}.jsonl`));
  await expect(persist()).rejects.toMatchObject({ code: 'EIO' });
  await persist();
  expect(fault.syncAttempts).toBe(3);
  expect(await readFile(join(dir, `${kind}.jsonl`))).toEqual(before);
});

it('keeps a complete last record without a newline when retry repairs its separator', async () => {
  await writeFile(join(dir, 'calls.jsonl'), JSON.stringify(call('operation:0')));
  await appendCalls([call('operation:0'), call('operation:1')], dir);
  expect((await records('calls.jsonl')).map(row => row.recordId)).toEqual(['operation:0', 'operation:1']);
});

it('keeps legacy writes append-only without rereading retained history', async () => {
  await appendCalls([{ ...call('legacy:0'), recordId: undefined }], dir);
  expect(fault.readAttempts).toBe(0);
});

it('does not sync the filesystem root while making a nested store durable', async () => {
  const nested = join(dir, 'nested', 'store');
  await appendCalls([call('operation:0')], nested);
  expect(fault.openedPaths).not.toContain('/');
  expect(fault.openedPaths).toContain(dir);
  expect(fault.openedPaths).toContain(nested);
});

it('does not sync unrelated existing ancestors while making a nested store durable', async () => {
  const nested = join(dir, 'nested', 'store');
  await appendCalls([call('operation:0')], nested);
  expect(fault.openedPaths).not.toContain(dirname(dir));
});

it('skips malformed retained rows instead of bricking the rest of the history', async () => {
  await writeFile(join(dir, 'calls.jsonl'), [
    JSON.stringify(call('legacy:0')),
    JSON.stringify({ ...call('broken:0'), recordId: 'contains spaces' }),
  ].join('\n'));
  await appendCalls([call('operation:0')], dir);
  expect((await loadModelStats({ dir, now }))[0]?.calls).toBe(2);
});

it('keeps the last physical legacy outcome when its timestamp is older', async () => {
  await appendOutcomes([{ ...outcome('legacy:0', 1, 'fixed'), recordId: undefined, order: undefined,
    ts: '2026-09-22T12:00:00Z' }], dir);
  await appendOutcomes([{ ...outcome('legacy:1', 1, 'dismissed'), recordId: undefined, order: undefined,
    ts: '2026-09-22T11:00:00Z' }], dir);
  expect((await loadModelStats({ dir, now }))[0]).toMatchObject({ outcomes: 1, fixed: 0 });
});

it('does not let a later legacy outcome replace retained original ordering', async () => {
  await appendOutcomes([outcome('ordered:0', 2, 'fixed')], dir);
  await appendOutcomes([{ ...outcome('legacy:0', 1, 'dismissed'), recordId: undefined, order: undefined }], dir);
  expect((await loadModelStats({ dir, now }))[0]).toMatchObject({ outcomes: 1, fixed: 1 });
});

it('keeps physical order when outcomes come from different original operation scopes', async () => {
  await appendOutcomes([{ ...outcome('scope-a:0', 2, 'fixed'), order: { scope: 'scope-a', sequence: 2 } }], dir);
  await appendOutcomes([{ ...outcome('scope-b:0', 1, 'dismissed'), order: { scope: 'scope-b', sequence: 1 } }], dir);
  expect((await loadModelStats({ dir, now }))[0]).toMatchObject({ outcomes: 1, fixed: 0 });
});

it('lets retained original ordering supersede an earlier legacy outcome', async () => {
  await appendOutcomes([{ ...outcome('legacy:0', 1, 'dismissed'), recordId: undefined, order: undefined }], dir);
  await appendOutcomes([outcome('ordered:0', 1, 'fixed')], dir);
  expect((await loadModelStats({ dir, now }))[0]).toMatchObject({ outcomes: 1, fixed: 1 });
});

it('rejects invalid retained ordering before creating a store', async () => {
  const missing = join(dir, 'missing');
  await expect(appendOutcomes([outcome('operation:0', -1, 'fixed')], missing)).rejects.toThrow('invalid_precision_order');
  await expect(readFile(join(missing, 'outcomes.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retries shared creation durability for an actual legacy write after a failed directory flush', async () => {
  const nested = join(dir, 'nested', 'store');
  fault.directory = dir; fault.syncFailures = 2;
  const legacy = [{ ...call('legacy:0'), recordId: undefined }];
  await expect(appendCalls(legacy, nested)).rejects.toMatchObject({ code: 'EIO' });
  await expect(appendCalls(legacy, nested)).rejects.toMatchObject({ code: 'EIO' });
  await expect(readFile(join(nested, 'calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  await appendCalls(legacy, nested);
  expect((await loadModelStats({ dir: nested, now }))[0]?.calls).toBe(1);
});


it.each([
  ['bootstrap root before intent document', 'intent-root-created'],
  ['durable intent before target creation', 'creating-intent-durable'],
  ['partial mkdir chain', 'mkdir-component-visible'],
  ['target visible before published marker', 'target-visible'],
  ['published marker', 'published-intent-durable'],
] as const)('repairs an actual creator crash at %s before retained acknowledgement', async (_phase, crashAt) => {
  const nested = join(dir, 'nested', 'middle', 'store');
  const recordId = `crash:${crashAt}`;
  const creator = protocolChild(nested, recordId, crashAt);
  await protocolEvent(creator, crashAt);
  expect(creator.events.map(event => event.event)).not.toContain('acknowledged');
  creator.child.kill('SIGKILL'); await once(creator.child, 'exit');
  expect(creator.child.signalCode).toBe('SIGKILL');

  const repair = protocolChild(nested, recordId);
  await protocolEvent(repair, 'acknowledged');
  await successfulProtocolChild(repair);
  const fileSync = eventIndex(repair, 'history-file-synced', join(nested, 'calls.jsonl'));
  const directorySync = eventIndex(repair, 'history-directory-synced', nested);
  const acknowledgement = eventIndex(repair, 'acknowledged');
  expect(fileSync).toBeGreaterThanOrEqual(0);
  expect(directorySync).toBeGreaterThan(fileSync);
  expect(acknowledgement).toBeGreaterThan(directorySync);

  if (crashAt === 'intent-root-created') {
    expect(eventIndex(repair, 'intent-root-anchored', dir)).toBeLessThan(fileSync);
  } else if (crashAt !== 'published-intent-durable') {
    expect(eventIndex(repair, 'created-chain-synced', nested)).toBeLessThan(fileSync);
    expect(eventIndex(repair, 'created-chain-synced', dir)).toBeLessThan(fileSync);
  } else {
    expect(eventIndex(creator, 'created-chain-synced', nested)).toBeLessThan(eventIndex(creator, crashAt));
    expect(eventIndex(creator, 'created-chain-synced', dir)).toBeLessThan(eventIndex(creator, crashAt));
  }

  expect((await records('nested/middle/store/calls.jsonl')).map(row => row.recordId)).toEqual([recordId]);
  const intentRoot = (await readdir(dir)).find(name => name.startsWith('.rcl-model-stats-intent-'))!;
  expect(JSON.parse(await readFile(join(dir, intentRoot, 'intent.json'), 'utf8'))).toMatchObject({
    phase: 'published', target: nested, anchor: dir,
  });
}, 20_000);

it('rechecks a target that appears after discovery and blocks acknowledgement until crash repair is durable', async () => {
  const nested = join(dir, 'nested', 'middle', 'store');
  const lateWriter = protocolChild(nested, 'race:0', 'intent-discovery-miss');
  await protocolEvent(lateWriter, 'intent-discovery-miss');

  const creator = protocolChild(nested, 'race:0', 'target-visible');
  await protocolEvent(creator, 'target-visible');
  lateWriter.child.send({ type: 'rcl-stats-store-protocol-continue', event: 'intent-discovery-miss' });
  await protocolEvent(lateWriter, 'existing-target-intent-discovered');
  expect(lateWriter.events.map(event => event.event)).not.toContain('acknowledged');

  creator.child.kill('SIGKILL'); await once(creator.child, 'exit');
  await protocolEvent(lateWriter, 'acknowledged');
  await successfulProtocolChild(lateWriter);
  const chainSync = eventIndex(lateWriter, 'created-chain-synced', nested);
  const fileSync = eventIndex(lateWriter, 'history-file-synced', join(nested, 'calls.jsonl'));
  const directorySync = eventIndex(lateWriter, 'history-directory-synced', nested);
  const acknowledgement = eventIndex(lateWriter, 'acknowledged');
  expect(chainSync).toBeGreaterThan(eventIndex(lateWriter, 'existing-target-intent-discovered'));
  expect(fileSync).toBeGreaterThan(chainSync);
  expect(directorySync).toBeGreaterThan(fileSync);
  expect(acknowledgement).toBeGreaterThan(directorySync);
  expect((await records('nested/middle/store/calls.jsonl')).map(row => row.recordId)).toEqual(['race:0']);
}, 20_000);

it('repairs a current-version legacy creator crash before retained acknowledgement', async () => {
  const nested = join(dir, 'nested', 'middle', 'store');
  const legacy = protocolChild(nested, 'legacy-race:0', 'target-visible', true);
  await protocolEvent(legacy, 'target-visible');
  expect(legacy.events.map(event => event.event)).not.toContain('acknowledged');

  const retained = protocolChild(nested, 'retained-race:0');
  legacy.child.kill('SIGKILL'); await once(legacy.child, 'exit');
  expect(legacy.child.signalCode).toBe('SIGKILL');
  await protocolEvent(retained, 'acknowledged');
  await successfulProtocolChild(retained);

  const anchorSync = eventIndex(retained, 'created-chain-synced', dir);
  const fileSync = eventIndex(retained, 'history-file-synced', join(nested, 'calls.jsonl'));
  const directorySync = eventIndex(retained, 'history-directory-synced', nested);
  expect(fileSync).toBeGreaterThan(anchorSync);
  expect(directorySync).toBeGreaterThan(fileSync);
  expect(eventIndex(retained, 'acknowledged')).toBeGreaterThan(directorySync);
  expect((await records('nested/middle/store/calls.jsonl')).map(row => row.recordId)).toEqual(['retained-race:0']);
}, 20_000);

it('rediscovers the original intent when a partial ancestor appears after the missing-target check', async () => {
  const nested = join(dir, 'nested', 'middle', 'store');
  const lateWriter = protocolChild(nested, 'ancestor-race:0', 'target-missing');
  await protocolEvent(lateWriter, 'target-missing');
  const creator = protocolChild(nested, 'ancestor-race:0', 'mkdir-component-visible');
  await protocolEvent(creator, 'mkdir-component-visible');
  creator.child.kill('SIGKILL'); await once(creator.child, 'exit');
  lateWriter.child.send({ type: 'rcl-stats-store-protocol-continue', event: 'target-missing' });
  await protocolEvent(lateWriter, 'acknowledged');
  await successfulProtocolChild(lateWriter);

  const ancestorSync = eventIndex(lateWriter, 'created-chain-synced', dir);
  const fileSync = eventIndex(lateWriter, 'history-file-synced', join(nested, 'calls.jsonl'));
  const directorySync = eventIndex(lateWriter, 'history-directory-synced', nested);
  expect(fileSync).toBeGreaterThan(ancestorSync);
  expect(directorySync).toBeGreaterThan(fileSync);
  expect(eventIndex(lateWriter, 'acknowledged')).toBeGreaterThan(directorySync);
  expect((await records('nested/middle/store/calls.jsonl')).map(row => row.recordId)).toEqual(['ancestor-race:0']);
  expect((await readdir(join(dir, 'nested'))).filter(name => name.startsWith('.rcl-model-stats-intent-'))).toEqual([]);
}, 20_000);

it('keeps a published retained-creation intent for a later cooperating process', async () => {
  const nested = join(dir, 'nested', 'store');
  await appendCalls([call('operation:0')], nested);
  const intentRoot = (await readdir(dir)).find(name => name.startsWith('.rcl-model-stats-intent-'))!;
  expect(JSON.parse(await readFile(join(dir, intentRoot, 'intent.json'), 'utf8'))).toMatchObject({
    version: 1, target: nested, anchor: dir, phase: 'published',
  });
  await appendCalls([call('operation:1')], nested);
  expect((await loadModelStats({ dir: nested, now }))[0]?.calls).toBe(2);
});

it('rejects a retained store replaced by a symlink after its intent is published', async () => {
  const nested = join(dir, 'nested', 'store');
  const redirected = join(dir, 'redirected');
  await appendCalls([call('operation:0')], nested);
  await mkdir(redirected);
  await rm(nested, { recursive: true, force: true });
  await symlink(redirected, nested);

  await expect(appendCalls([call('operation:1')], nested)).rejects.toThrow('unsafe_precision_store');
  await expect(readFile(join(redirected, 'calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['calls', 'outcomes'] as const)('surfaces a read-only %s store and permits the exact batch in a writable override', async kind => {
  const fallback = join(dir, 'explicit-writable');
  fault.openDenied = join(dir, `${kind}.jsonl`);
  const persist = (path: string) => kind === 'calls'
    ? appendCalls([call('operation:0')], path)
    : appendOutcomes([outcome('operation:0', 1, 'fixed')], path);
  await expect(persist(dir)).rejects.toMatchObject({ code: 'EROFS' });
  await persist(fallback);
  await persist(fallback);
  const [stats] = await loadModelStats({ dir: fallback, now });
  expect(kind === 'calls' ? stats?.calls : stats?.outcomes).toBe(1);
  await expect(readFile(fault.openDenied)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses two different dispositions claiming the same original logical order', async () => {
  await writeFile(join(dir, 'outcomes.jsonl'), [outcome('a:0', 1, 'fixed'), outcome('b:0', 1, 'dismissed')].map(row => JSON.stringify(row)).join('\n'));
  await expect(loadModelStats({ dir, now })).rejects.toThrow('precision_order_conflict');
});

it('rejects a conflicting logical order before appending it', async () => {
  await appendOutcomes([outcome('a:0', 1, 'fixed')], dir);
  const before = await readFile(join(dir, 'outcomes.jsonl'));
  await expect(appendOutcomes([outcome('b:0', 1, 'dismissed')], dir)).rejects.toThrow('precision_order_conflict');
  expect(await readFile(join(dir, 'outcomes.jsonl'))).toEqual(before);
});
