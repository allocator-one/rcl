import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readStable } from '../../src/telemetry/recovery/files.js';
import { convergeRunStatePath } from '../../src/converge/run-state.js';
import { MAX_NATIVE_RECOVERY_SNAPSHOT_BYTES as MAX, readNativeRecoveryMaterials, readNativeRecoverySourceJsons,
  verifyNativeRecoveryLineage } from '../../src/converge/recovery-state.js';
import { packNativeMaterial } from '../../src/evidence/claim-recovery/validation/native-material.js';
import { sha, uuid } from '../evidence/recovery-validation/fixtures.js';

const boundary = vi.hoisted(() => ({
  limits: [] as Array<{ path: string; limit: number | undefined }>,
  reads: [] as Array<{ path: string; bytes: number; forbidden: boolean }>,
  forbidden: new Set<string>(),
}));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), read = handle.read.bind(handle), path = String(args[0]);
    handle.read = (async (...params: any[]) => {
      if (boundary.forbidden.has(path)) {
        boundary.reads.push({ path, bytes: 0, forbidden: true });
        throw new Error('test_tripwire_excess_content_read');
      }
      const result = await (read as any)(...params);
      boundary.reads.push({ path, bytes: result.bytesRead, forbidden: false });
      return result;
    }) as typeof handle.read;
    return handle;
  } };
});
vi.mock('../../src/telemetry/recovery/files.js', async original => {
  const actual = await original<typeof import('../../src/telemetry/recovery/files.js')>();
  return { ...actual, readStable: async (...args: Parameters<typeof actual.readStable>) => {
    boundary.limits.push({ path: args[0], limit: args[1] });
    return actual.readStable(...args);
  } };
});

const roots: string[] = [];
afterEach(async () => {
  if (process.env.RCL_BOUNDARY_LOG) await appendFile(process.env.RCL_BOUNDARY_LOG, JSON.stringify({
    test: expect.getState().currentTestName, limits: boundary.limits, reads: boundary.reads,
  }) + '\n');
  boundary.limits.length = 0; boundary.reads.length = 0; boundary.forbidden.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const target = 'native-read-budget';
const legacy = () => ({ version: 1, target, roundCap: 15, rounds: [], findings: {}, updatedAt: 'café😀' });
const operation = (text: string, n: number) => ({ operationId: uuid(n), sourceVersion: JSON.parse(text).version,
  sourceSha256: sha(text), anchors: [], sourceReceipts: [] });
const recovered = (source: any, op: any) => ({ ...source, version: 3, sightings: source.sightings ?? [],
  recovery: { version: 1, operations: [...(source.recovery?.operations ?? []), op] } });
async function context() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-preread-'))); roots.push(root);
  const path = convergeRunStatePath(root, target); return { root, path };
}
async function file(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { flag: 'wx', mode: 0o600 });
}
const snapshot = (path: string, digest: string) => `${path}.recovery-sources/${digest}.json`;
async function sparse(path: string, size: number) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'wx', 0o600);
  try { await handle.truncate(size); } finally { await handle.close(); }
}
function zeroDigest(size: number) {
  const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024);
  for (let left = size; left > 0; left -= chunk.length) hash.update(chunk.subarray(0, Math.min(left, chunk.length)));
  return hash.digest('hex');
}

it('keeps empty predecessor and material reads valid without any content reads', async () => {
  const { root } = await context();
  expect(await readNativeRecoverySourceJsons(root, legacy() as any)).toEqual([]);
  expect(await readNativeRecoveryMaterials(root, legacy() as any)).toEqual([]);
  expect(boundary.limits).toEqual([]); expect(boundary.reads).toEqual([]);
});

it('passes remaining UTF-8 bytes for a real two-snapshot ancestry', async () => {
  const { root, path } = await context(), leaf = JSON.stringify(legacy());
  const first = JSON.stringify(recovered(legacy(), operation(leaf, 1)));
  const current = recovered(JSON.parse(first), operation(first, 2));
  await file(snapshot(path, sha(first)), first); await file(snapshot(path, sha(leaf)), leaf);
  const sources = await readNativeRecoverySourceJsons(root, current);
  expect(sources).toEqual([first, leaf]);
  expect(() => verifyNativeRecoveryLineage(JSON.stringify(current), target, sources)).not.toThrow();
  expect(Buffer.byteLength(first)).toBeGreaterThan(first.length);
  expect(boundary.limits.map(row => row.limit)).toEqual([MAX, MAX - Buffer.byteLength(first)]);
});

it('charges migration bytes to the same ancestry budget', async () => {
  const { root, path } = await context(), leaf = JSON.stringify(legacy());
  const migration = { sourceSha256: sha(leaf), snapshotPath: `${path}.v1-${sha(leaf)}.snapshot` };
  const semantic = { ...legacy(), version: 2, sightings: [], migration }, first = JSON.stringify(semantic);
  const current = recovered(semantic, operation(first, 1));
  await file(snapshot(path, sha(first)), first); await file(migration.snapshotPath, leaf);
  expect(await readNativeRecoverySourceJsons(root, current)).toEqual([first, leaf]);
  expect(boundary.limits.map(row => row.limit)).toEqual([MAX, MAX - Buffer.byteLength(first)]);
});

it('accepts exactly64MiB of retained snapshot bytes separately from the current document', async () => {
  const { root, path } = await context(), text = JSON.stringify(legacy()), hash = createHash('sha256');
  const temporary = join(root, 'padded-source'), handle = await open(temporary, 'wx', 0o600);
  const chunk = Buffer.alloc(64 * 1024, 32), first = Buffer.from(text);
  try {
    await handle.write(first); hash.update(first);
    for (let left = MAX - first.length; left > 0; left -= chunk.length) {
      const part = chunk.subarray(0, Math.min(left, chunk.length)); await handle.write(part); hash.update(part);
    }
  } finally { await handle.close(); }
  const digest = hash.digest('hex'), sourcePath = snapshot(path, digest);
  // A hard link keeps the exact streamed bytes without a second large allocation.
  const fs = await import('node:fs/promises'); await mkdir(dirname(sourcePath), { recursive: true, mode: 0o700 });
  await fs.link(temporary, sourcePath);
  const current = recovered(legacy(), { ...operation(text, 1), sourceSha256: digest });
  expect(Buffer.byteLength(JSON.stringify(current))).toBeGreaterThan(0);
  const sources = await readNativeRecoverySourceJsons(root, current);
  expect(sources).toHaveLength(1); expect(Buffer.byteLength(sources[0]!)).toBe(MAX);
  expect(sources[0]!.startsWith(text)).toBe(true); expect(sha(sources[0]!)).toBe(digest);
  expect(boundary.limits.map(row => row.limit)).toEqual([MAX]);
  expect(boundary.reads.filter(row => row.path === sourcePath).reduce((n, row) => n + row.bytes, 0)).toBe(MAX);
}, 60_000);

it.each([6, 5])('real reader honors exact UTF-8 byte equality before consuming excess content (limit%s)', async limit => {
  const { root } = await context(), path = join(root, 'utf8'); await file(path, 'é😀');
  if (limit === 5) {
    boundary.forbidden.add(path);
    await expect(readStable(path, limit)).rejects.toThrow('oversized');
    expect(boundary.reads).toEqual([]);
  } else {
    expect((await readStable(path, limit)).raw.length).toBe(6);
    expect(boundary.reads.reduce((n, row) => n + row.bytes, 0)).toBe(6);
  }
});

it.each(['predecessor', 'migration'])('refuses excess %s bytes before any content read', async kind => {
  const { root, path } = await context();
  const makeFirst = (digest: string): any => kind === 'predecessor'
    ? recovered(legacy(), { ...operation(JSON.stringify(legacy()), 1), sourceSha256: digest })
    : { ...legacy(), version: 2, sightings: [], migration: { sourceSha256: digest, snapshotPath: `${path}.v1-${digest}.snapshot` } };
  const firstSize = Buffer.byteLength(JSON.stringify(makeFirst('0'.repeat(64))));
  const size = MAX - firstSize + 1, digest = zeroDigest(size), first = JSON.stringify(makeFirst(digest));
  expect(Buffer.byteLength(first)).toBe(firstSize);
  const excessPath = kind === 'predecessor' ? snapshot(path, digest) : JSON.parse(first).migration.snapshotPath;
  await sparse(excessPath, size); await file(snapshot(path, sha(first)), first);
  const current = recovered(JSON.parse(first), operation(first, 2));
  boundary.forbidden.add(excessPath);
  await expect(readNativeRecoverySourceJsons(root, current)).rejects.toThrow('oversized');
  expect(boundary.reads.filter(row => row.path === excessPath)).toEqual([]);
  expect(boundary.limits.at(-1)!.limit).toBe(MAX - firstSize);
});

it.each(['predecessor', 'migration'])('enforces the existing snapshot-count bound before excess %s reads', async kind => {
  const { root, path } = await context(), leaf = JSON.stringify(legacy()), digest = sha(leaf);
  const firstState: any = kind === 'predecessor' ? recovered(legacy(), operation(leaf, 1)) :
    { ...legacy(), version: 2, sightings: [], migration: { sourceSha256: digest, snapshotPath: `${path}.v1-${digest}.snapshot` } };
  const first = JSON.stringify(firstState), current = recovered(legacy(), operation(first, 2));
  const excessPath = kind === 'predecessor' ? snapshot(path, digest) : firstState.migration.snapshotPath;
  await file(excessPath, leaf); await file(snapshot(path, sha(first)), first); boundary.forbidden.add(excessPath);
  await expect(readNativeRecoverySourceJsons(root, current)).rejects.toThrow('native_recovery_source_conflict');
  expect(boundary.limits).toHaveLength(1);
  expect(boundary.reads.filter(row => row.path === excessPath)).toEqual([]);
});

it('reads canonical material with remaining UTF-8 bytes and deduplicates shared references', async () => {
  const { root, path } = await context(), first = packNativeMaterial({});
  const second = packNativeMaterial({ occurrences: { version: 1, transfers: [], dispositions: [], carriers: [],
    projection: { qualification: 'supplied-content-only', readProvenance: 'unavailable', carriers: [], dispositions: [],
      readRequirements: [{ kind: 'eligible-confirmation', target: 'café😀', claimIdentity: 'a'.repeat(16), afterRound: 1,
        afterReceivedAt: '2026-09-22T00:00:00Z', assertionEventId: uuid(4), scope: {
          base_url: 'https://synthetic.example', org_id: uuid(5), run_id: uuid(6), repo: 'synthetic/repo', pr_number: 1 } }] } } });
  const rows = [...first.materials, ...second.materials], lookup = new Map(rows.map(row => [row.sha256, row]));
  const state: any = { ...legacy(), version: 3, recovery: { version: 2,
    operations: [first.reference, second.reference, first.reference].map(material => ({ material })) } };
  for (const row of lookup.values()) await file(`${path}.recovery-materials/${row.sha256}`, row.text);
  const result = await readNativeRecoveryMaterials(root, state); expect(result).toHaveLength(lookup.size);
  let remaining = MAX;
  for (const [index, row] of result.entries()) {
    expect(boundary.limits[index]!.limit).toBe(remaining); remaining -= Buffer.byteLength(row.text);
    expect(row).toEqual(lookup.get(row.sha256));
  }
  expect(result.some(row => Buffer.byteLength(row.text) > row.text.length)).toBe(true);
});

it('refuses aggregate material overflow before the excess content read', async () => {
  const { root, path } = await context(), first = packNativeMaterial({}).materials[0]!;
  const size = MAX - Buffer.byteLength(first.text) + 1, digest = zeroDigest(size);
  const excessPath = `${path}.recovery-materials/${digest}`;
  await file(`${path}.recovery-materials/${first.sha256}`, first.text); await sparse(excessPath, size);
  const state: any = { ...legacy(), version: 3, recovery: { version: 2, operations: [{ material: {
    version: 1, rootSha256: first.sha256, sha256s: [first.sha256, digest], pendingIdentities: [] } }] } };
  boundary.forbidden.add(excessPath);
  await expect(readNativeRecoveryMaterials(root, state)).rejects.toThrow('oversized');
  expect(boundary.reads.filter(row => row.path === excessPath)).toEqual([]);
  expect(boundary.limits.at(-1)!.limit).toBe(MAX - Buffer.byteLength(first.text));
});
