import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const trace = vi.hoisted(() => [] as string[]);
vi.mock('../../src/converge/native-lock.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/converge/native-lock.js')>();
  return { ...original, syncNativeDirectory: async (path: string) => {
    trace.push(`directory:${path}`);
    await original.syncNativeDirectory(path);
  } };
});
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: async (...args: Parameters<typeof original.open>) => {
    const handle = await original.open(...args);
    return new Proxy(handle, { get(target, property) {
      if (property === 'sync') return async () => { trace.push(`file:${String(args[0])}`); await target.sync(); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});

import { retainReportEvidence } from '../../src/converge/semantic-state.js';

const roots: string[] = [];
afterEach(async () => {
  trace.splice(0);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('flushes report bytes and their directory entry before native state may reference them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'semantic-report-durability-')); roots.push(root);
  const raw = '{"run":{"id":"00000000-0000-7000-8000-000000000001"},"findings":[]}';
  const digest = createHash('sha256').update(raw).digest('hex');
  const sourcePath = join(root, 'rcl-converge-runs', `target.evidence/${digest}.json`);
  await retainReportEvidence(raw, { runId: '00000000-0000-7000-8000-000000000001', target: 'target', round: 1,
    reportSha256: digest, sourcePath });
  expect(await readFile(sourcePath, 'utf8')).toBe(raw);
  expect(trace.filter(entry => entry.startsWith('directory:') || entry === `file:${sourcePath}`)).toEqual([
    `directory:${dirname(dirname(sourcePath))}`,
    `file:${sourcePath}`,
    `directory:${dirname(sourcePath)}`,
  ]);
});
