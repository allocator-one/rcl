import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const reads = vi.hoisted(() => ({ fullFile: 0, handleFullFile: 0, handleChunk: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      reads.fullFile += 1;
      return fs.readFile(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'readFile') return (...readArgs: unknown[]) => {
            reads.handleFullFile += 1;
            return Reflect.apply(target.readFile, target, readArgs);
          };
          if (property === 'read') return (...readArgs: unknown[]) => {
            reads.handleChunk += 1;
            return Reflect.apply(target.read, target, readArgs);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

import { convergeRunStatePath, initialConvergeRunState, loadConvergeRunStateEvidence, writeState } from '../../src/converge/run-state.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'native-read-bound-')));
  roots.push(commonDir);
  const target = 'fixture-native-read-bound';
  const path = convergeRunStatePath(commonDir, target);
  await mkdir(dirname(path), { mode: 0o700 });
  return { commonDir, target, path };
}

it('refuses an oversized current document before an unbounded whole-file read', async () => {
  const f = await fixture();
  const file = await open(f.path, 'wx', 0o600);
  await file.truncate(64 * 1024 * 1024 + 1);
  await file.close();
  reads.fullFile = 0; reads.handleFullFile = 0; reads.handleChunk = 0;
  const result = await loadConvergeRunStateEvidence(f.commonDir, f.target).catch(error => error);
  expect(reads.fullFile).toBe(0);
  expect(reads.handleFullFile).toBe(0);
  expect(reads.handleChunk).toBe(0);
  expect(result).toMatchObject({ cause: { message: 'oversized' } });
  const retained = await open(f.path, 'r');
  try { expect((await retained.stat()).size).toBe(64 * 1024 * 1024 + 1); }
  finally { await retained.close(); }
});

it('preserves ordinary state and its exact byte digest within the read bound', async () => {
  const f = await fixture();
  const state = initialConvergeRunState(f.target);
  const bytes = Buffer.from(JSON.stringify(state, null, 2) + '\n');
  await writeFile(f.path, bytes, { mode: 0o600 });
  const loaded = await loadConvergeRunStateEvidence(f.commonDir, f.target);
  expect(loaded).toEqual({ state, sha256: createHash('sha256').update(bytes).digest('hex') });
});

it('refuses an oversized replacement without overwriting the retained ordinary state', async () => {
  const f = await fixture();
  const state = initialConvergeRunState(f.target);
  const bytes = Buffer.from(JSON.stringify(state, null, 2) + '\n');
  await writeFile(f.path, bytes, { mode: 0o600 });
  const oversized = { ...state, updatedAt: 'x'.repeat(64 * 1024 * 1024) };
  await expect(withNativeTarget(f.commonDir, f.target,
    ownership => writeState(f.commonDir, oversized, ownership))).rejects.toThrow('recovery_document_too_large');
  expect(await loadConvergeRunStateEvidence(f.commonDir, f.target)).toEqual({
    state, sha256: createHash('sha256').update(bytes).digest('hex'),
  });
});
