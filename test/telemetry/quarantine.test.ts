import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Quarantine, type QuarantineInput } from '../../src/telemetry/quarantine.js';
import { Outbox } from '../../src/telemetry/outbox.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { sampleResult } from './fixtures.js';

const fault = vi.hoisted(() => ({ beforeMarkdown: undefined as undefined | (() => Promise<void>) }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (basename(String(args[0])) === 'report.md') await fault.beforeMarkdown?.();
    return fs.open(...args);
  } };
});

describe('immutable quarantine publication', () => {
  let root: string;
  let store: Quarantine;
  let input: QuarantineInput;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rcl-quarantine-'));
    store = new Quarantine(join(root, 'quarantine'));
    const result = sampleResult();
    const artifacts = { report_json: JSON.stringify(result), report_md: '# Unchanged report\n' };
    input = {
      runId: result.run!.id, artifacts,
      envelope: buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' } }),
      events: [], requestedMode: 'asserted', acknowledged: false,
      diagnostics: [{ path: 'delivery', message: 'HTTP 422' }],
    };
  });
  afterEach(async () => { fault.beforeMarkdown = undefined; await rm(root, { recursive: true, force: true }); });

  it('reuses an exact retained run without rewriting its original manifest or bytes', async () => {
    expect(await store.retain(input)).toMatchObject({ status: 'complete' });
    const path = join(store.dir, input.runId, 'manifest.json');
    const before = await readFile(path);
    expect(await store.retain(input)).toMatchObject({ status: 'complete' });
    expect(await readFile(path)).toEqual(before);
    expect(await store.inspect(input.runId)).toMatchObject({ status: 'complete' });
  });

  it('reports a cap refusal without claiming either artifact was retained', async () => {
    const capped = new Quarantine(store.dir, 1);
    expect(await capped.retain(input)).toMatchObject({ status: 'failed', error: 'quarantine_over_cap' });
    expect(await capped.list()).toEqual([]);
  });

  it('leaves EROFS-interrupted bytes visible as incomplete and never automatically retries them', async () => {
    fault.beforeMarkdown = async () => { throw Object.assign(new Error('read-only filesystem'), { code: 'EROFS' }); };
    expect(await store.retain(input)).toMatchObject({ status: 'failed', error: 'EROFS' });
    expect(await store.inspect(input.runId)).toMatchObject({ status: 'incomplete' });
    expect(await readFile(join(store.dir, input.runId, 'report.json'), 'utf8')).toBe(input.artifacts.report_json);
    expect(await new Outbox(join(root, 'outbox')).list()).toEqual([]);
    fault.beforeMarkdown = undefined;
    expect(await store.retain(input)).toMatchObject({ status: 'failed', error: 'existing_retention_incomplete' });
  });

  it('publishes completion only after every artifact, even while another process inspects or flushes', async () => {
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    let resume!: () => void;
    const release = new Promise<void>((resolve) => { resume = resolve; });
    fault.beforeMarkdown = async () => { reached(); await release; };
    const pending = store.retain(input);
    await waiting;
    expect(await store.inspect(input.runId)).toMatchObject({ status: 'incomplete' });
    const sink = { postRun: vi.fn(), putArtifact: vi.fn(), postEvents: vi.fn() };
    const outbox = new Outbox(join(root, 'outbox'));
    await outbox.flush(sink as never);
    expect(sink.postRun).not.toHaveBeenCalled();
    resume();
    expect(await pending).toMatchObject({ status: 'complete' });
    expect(await store.inspect(input.runId)).toMatchObject({ status: 'complete' });
  });

  it('allows only one conflicting concurrent writer and verifies the winning original', async () => {
    const changed = { ...input, artifacts: { ...input.artifacts, report_md: '# Conflicting report\n' } };
    const results = await Promise.all([store.retain(input), store.retain(changed)]);
    expect(results.filter((r) => r.status === 'complete')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'failed')).toHaveLength(1);
    expect(await store.inspect(input.runId)).toMatchObject({ status: 'complete' });
    const winner = results[0]!.status === 'complete' ? input : changed;
    expect(await readFile(join(store.dir, input.runId, 'report.md'), 'utf8')).toBe(winner.artifacts.report_md);
  });

  it('does not treat changed artifact bytes as a complete retained original', async () => {
    await store.retain(input);
    await writeFile(join(store.dir, input.runId, 'report.md'), '# Tampered\n');
    expect(await store.inspect(input.runId)).toMatchObject({ status: 'incomplete' });
    expect(await store.retain(input)).toMatchObject({ status: 'failed', error: 'existing_retention_incomplete' });
  });

  it.each(['wrong-role', 'omitted-markdown'])('refuses a corrupted %s manifest even when its remaining hashes match', async (corruption) => {
    await store.retain(input);
    const dir = join(store.dir, input.runId);
    const path = join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    if (corruption === 'wrong-role') {
      manifest.artifacts.report_json = manifest.artifacts.report_md;
      await rm(join(dir, 'report.json'));
    } else {
      delete manifest.artifacts.report_md;
      await rm(join(dir, 'report.md'));
    }
    await writeFile(path, JSON.stringify(manifest));
    expect(await store.inspect(input.runId)).toMatchObject({ status: 'incomplete' });
  });

  it('appends distinct retry diagnostics and acknowledgment without rewriting the original snapshot', async () => {
    await store.retain(input);
    const dir = join(store.dir, input.runId);
    const original = await readFile(join(dir, 'manifest.json'));
    const next = { ...input, acknowledged: true, diagnostics: [{ path: 'delivery.report_md', message: 'Artifact refused after envelope acknowledgment' }] };
    expect(await store.retain(next)).toMatchObject({ status: 'complete' });
    expect(await store.retain(next)).toMatchObject({ status: 'complete' });
    expect(await readFile(join(dir, 'manifest.json'))).toEqual(original);
    expect((await readdir(dir)).filter((name) => name.startsWith('observation-'))).toHaveLength(1);
    expect(await store.inspect(input.runId)).toMatchObject({
      status: 'complete', manifest: { acknowledged: false, diagnostics: input.diagnostics },
      observations: [{ acknowledged: true, diagnostics: next.diagnostics }],
    });
    expect(await store.retain({ ...next, requestedMode: 'attested' })).toMatchObject({ status: 'failed', error: 'retained_evidence_conflict' });
  });
});
