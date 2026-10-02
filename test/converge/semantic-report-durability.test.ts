import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const trace = vi.hoisted(() => [] as string[]);
const opens = vi.hoisted(() => [] as Array<{ path: string; flags: string | number }>);
const faults = vi.hoisted(() => ({ partialWrite: false, linkCompetitor: null as Buffer | null }));
vi.mock('../../src/converge/native-lock.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/converge/native-lock.js')>();
  return { ...original, syncNativeDirectory: async (path: string) => {
    trace.push(`directory:${path}`);
    await original.syncNativeDirectory(path);
  } };
});
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original,
    link: async (...args: Parameters<typeof original.link>) => {
      if (faults.linkCompetitor) {
        const competitor = faults.linkCompetitor; faults.linkCompetitor = null;
        await original.writeFile(args[1], competitor, { flag: 'wx', mode: 0o400 });
      }
      return original.link(...args);
    },
    open: async (...args: Parameters<typeof original.open>) => {
    opens.push({ path: String(args[0]), flags: args[1] });
    const handle = await original.open(...args);
    return new Proxy(handle, { get(target, property) {
      if (property === 'sync') return async () => { trace.push(`file:${String(args[0])}`); await target.sync(); };
      if (property === 'writeFile' && faults.partialWrite) return async (bytes: string | Uint8Array) => {
        faults.partialWrite = false;
        const value = typeof bytes === 'string' ? bytes : Buffer.from(bytes);
        await target.writeFile(value.slice(0, Math.max(1, Math.floor(value.length / 2))));
        throw new Error('injected_partial_write');
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});

import { retainReportEvidence, verifyRoundBinding } from '../../src/converge/semantic-state.js';
import { MAX_REPORT_BYTES } from '../../src/telemetry/recovery/files.js';

const roots: string[] = [];
afterEach(async () => {
  trace.splice(0);
  opens.splice(0);
  faults.partialWrite = false;
  faults.linkCompetitor = null;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('does not publish a partial report and permits an exact retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'semantic-report-retry-')); roots.push(root);
  const raw = '{"run":{"id":"00000000-0000-7000-8000-000000000001"},"findings":[]}';
  const digest = createHash('sha256').update(raw).digest('hex');
  const sourcePath = join(root, 'rcl-converge-runs', `target.evidence/${digest}.json`);
  const binding = { runId: '00000000-0000-7000-8000-000000000001', target: 'target', round: 1,
    reportSha256: digest, sourcePath };
  faults.partialWrite = true;
  await expect(retainReportEvidence(raw, binding)).rejects.toThrow('injected_partial_write');
  await expect(access(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
  await retainReportEvidence(raw, binding);
  expect(await readFile(sourcePath, 'utf8')).toBe(raw);
});

it.each(['different', 'oversized', 'invalid-utf8'] as const)
('reports a stable digest conflict for an existing %s retained file', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'semantic-report-conflict-')); roots.push(root);
  const raw = '{"run":{"id":"00000000-0000-7000-8000-000000000001"},"findings":[]}';
  const digest = createHash('sha256').update(raw).digest('hex');
  const sourcePath = join(root, 'rcl-converge-runs', `target.evidence/${digest}.json`);
  await mkdir(dirname(sourcePath), { recursive: true });
  const competitor = kind === 'oversized' ? `${raw}x` : kind === 'invalid-utf8' ? Buffer.alloc(raw.length, 0xff) : raw.replace('findings', 'findinx');
  await writeFile(sourcePath, competitor, { mode: 0o400 });
  await expect(retainReportEvidence(raw, { runId: '00000000-0000-7000-8000-000000000001', target: 'target', round: 1,
    reportSha256: digest, sourcePath })).rejects.toThrow('Original report digest changed.');
  expect(await readFile(sourcePath)).toEqual(Buffer.from(competitor));
});

it.each(['identical', 'different'] as const)('resolves a hard-link EEXIST race against %s bytes', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'semantic-report-link-race-')); roots.push(root);
  const raw = '{"run":{"id":"00000000-0000-7000-8000-000000000001"},"findings":[]}';
  const digest = createHash('sha256').update(raw).digest('hex');
  const sourcePath = join(root, 'rcl-converge-runs', `target.evidence/${digest}.json`);
  const competitor = Buffer.from(kind === 'identical' ? raw : raw.replace('findings', 'findinx'));
  faults.linkCompetitor = competitor;
  const operation = retainReportEvidence(raw, { runId: '00000000-0000-7000-8000-000000000001', target: 'target', round: 1,
    reportSha256: digest, sourcePath });
  if (kind === 'identical') await expect(operation).resolves.toBeUndefined();
  else await expect(operation).rejects.toThrow('Original report digest changed.');
  expect(await readFile(sourcePath)).toEqual(competitor);
  expect((await readdir(dirname(sourcePath))).filter(entry => entry.endsWith('.pending'))).toEqual([]);
});

it('reuses an exact read-only retained report without another file flush', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'semantic-report-reuse-'))); roots.push(root);
  const raw = '{"run":{"id":"00000000-0000-7000-8000-000000000001"},"findings":[]}';
  const digest = createHash('sha256').update(raw).digest('hex');
  const sourcePath = join(root, 'rcl-converge-runs', `target.evidence/${digest}.json`);
  const binding = { runId: '00000000-0000-7000-8000-000000000001', target: 'target', round: 1,
    reportSha256: digest, sourcePath };
  await retainReportEvidence(raw, binding);
  const firstFileSyncs = trace.filter(entry => entry.startsWith(`file:${sourcePath}.`)).length;
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  try { await retainReportEvidence(raw, binding); } finally { platform.mockRestore(); }
  expect(trace.filter(entry => entry.startsWith(`file:${sourcePath}.`))).toHaveLength(firstFileSyncs);
  const finalReads = opens.filter(entry => entry.path === sourcePath && typeof entry.flags === 'number');
  expect(finalReads.length).toBeGreaterThan(0);
  expect(finalReads.every(entry => ((entry.flags as number) & (constants.O_WRONLY | constants.O_RDWR)) === constants.O_RDONLY)).toBe(true);
});

it('bounds immutable report verification before decoding retained bytes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'semantic-report-bound-'))); roots.push(root);
  const raw = '{"run":{"id":"00000000-0000-7000-8000-000000000001"},"findings":[]}';
  const digest = createHash('sha256').update(raw).digest('hex');
  const sourcePath = join(root, 'rcl-converge-runs', `target.evidence/${digest}.json`);
  const binding = { runId: '00000000-0000-7000-8000-000000000001', target: 'target', round: 1,
    reportSha256: digest, sourcePath };
  await retainReportEvidence(raw, binding);
  await chmod(sourcePath, 0o600);
  await truncate(sourcePath, MAX_REPORT_BYTES + 1);
  await expect(verifyRoundBinding(binding, 'target', 1, binding.runId))
    .rejects.toThrow('Original bound report bytes unavailable');
});

it('refuses oversized immutable report bytes before publishing them', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'semantic-report-oversized-source-'))); roots.push(root);
  const raw = 'x'.repeat(MAX_REPORT_BYTES + 1);
  const digest = createHash('sha256').update(raw).digest('hex');
  const sourcePath = join(root, 'rcl-converge-runs', `target.evidence/${digest}.json`);
  await expect(retainReportEvidence(raw, { runId: '00000000-0000-7000-8000-000000000001', target: 'target', round: 1,
    reportSha256: digest, sourcePath })).rejects.toThrow('Immutable report exceeds the retained byte limit.');
  await expect(access(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('flushes report bytes and their directory entry before native state may reference them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'semantic-report-durability-')); roots.push(root);
  const raw = '{"run":{"id":"00000000-0000-7000-8000-000000000001"},"findings":[]}';
  const digest = createHash('sha256').update(raw).digest('hex');
  const sourcePath = join(root, 'rcl-converge-runs', `target.evidence/${digest}.json`);
  await retainReportEvidence(raw, { runId: '00000000-0000-7000-8000-000000000001', target: 'target', round: 1,
    reportSha256: digest, sourcePath });
  expect(await readFile(sourcePath, 'utf8')).toBe(raw);
  expect(trace.filter(entry => entry.startsWith('directory:'))).toEqual([
    `directory:${dirname(dirname(sourcePath))}`,
    `directory:${dirname(sourcePath)}`,
  ]);
  const fileSyncs = trace.filter(entry => entry.startsWith(`file:${sourcePath}.`));
  expect(fileSyncs).toHaveLength(1);
  expect(fileSyncs[0]).toMatch(/\.pending$/);
});
