import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBackfillRuns } from '../../src/telemetry/backfill.js';
import { buildRunEnvelope, type RunEnvelope } from '../../src/telemetry/envelope.js';
import { inventoryRefutations } from '../../src/telemetry/recovery/discovery.js';
import { applyRecovery, planRecovery } from '../../src/telemetry/recovery/plan.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { fakeFetch, sampleFinding, sampleResult, sampleReview, sampleRunHeader } from './fixtures.js';

const ORG = '919921a0-0000-4000-8000-000000000001';
const BASE = 'https://harness.example.test/nested';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function source() {
  const root = await mkdtemp(join(tmpdir(), 'rcl-recovery-test-'));
  directories.push(root);
  const report = sampleResult({
    run: sampleRunHeader({ rcl_version: '3.6.0' }),
    reviews: [sampleReview()],
    findings: [sampleFinding({
      id: 'duplicated-raw-id',
      gating: { reason: 'none', verification: { verdict: 'refuted', model: 'vendor/actual', note: 'The earlier branch returns.\n```ts\nreturn true;\n```' } },
    })],
    belowThresholdFindings: [sampleFinding({
      id: 'duplicated-raw-id', identity: 'fedcba9876543210', startLine: 24, endLine: 25,
      gating: { reason: 'none', verification: { verdict: 'refuted', model: 'vendor/actual', note: 'Kept original explanation 🙂' } },
    })],
  });
  const bytes = JSON.stringify(report);
  const path = join(root, 'rcl-report-example.json');
  await writeFile(path, bytes);
  return { root, path, bytes, report, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function server(existing?: RunEnvelope) {
  const runs = new Map<string, { envelope: RunEnvelope; stored: boolean }>();
  if (existing) runs.set(existing.run.id, { envelope: structuredClone(existing), stored: false });
  let org: string | undefined = ORG;
  let loseReceipt: 'POST' | 'PUT' | undefined;
  const http = fakeFetch((request) => {
    const path = request.url.slice(BASE.length);
    if (request.method === 'GET' && path === '/api/v1/reviews/runs?page_size=1') {
      return { status: 200, body: { data: [], meta: { org_id: org } } };
    }
    if (request.method === 'POST' && path === '/api/v1/reviews/runs') {
      const envelope = JSON.parse(request.body!) as RunEnvelope;
      const present = runs.has(envelope.run.id);
      if (!present) runs.set(envelope.run.id, { envelope, stored: false });
      if (loseReceipt === 'POST') { loseReceipt = undefined; return new Error('simulated lost receipt'); }
      return { status: present ? 200 : 201, body: { data: { id: envelope.run.id, url: `${BASE}/runs/${envelope.run.id}`, artifacts_expected: ['report_json'] }, meta: { status: present ? 'existing' : 'created' } } };
    }
    const match = /^\/api\/v1\/reviews\/runs\/([^/]+)(\/artifacts\/report_json)?$/.exec(path);
    const record = match ? runs.get(match[1]!) : undefined;
    if (!record) return { status: 404, body: { error: 'not_found' } };
    if (request.method === 'PUT' && match![2]) {
      const wasStored = record.stored;
      record.stored = true;
      if (loseReceipt === 'PUT') { loseReceipt = undefined; return new Error('simulated lost receipt'); }
      return { status: 201, body: { data: { kind: 'report_json', sha256: createHash('sha256').update(request.body!).digest('hex') }, meta: { status: wasStored ? 'existing' : 'created' } } };
    }
    if (request.method === 'GET' && !match![2]) {
      const { envelope, stored } = record;
      return { status: 200, body: { data: {
        ...envelope.run, findings: envelope.findings, calls: envelope.calls,
        artifacts: envelope.artifacts_declared.map((a) => ({ kind: a.kind, declared_sha256: a.sha256, declared_bytes: a.bytes, stored })),
      } } };
    }
    return { status: 400, body: { error: 'unexpected_request' } };
  });
  const sink = new HarnessSink({ credential: { url: BASE, token: 'aone_SYNTHETIC_TEST_TOKEN', source: 'login' }, rclVersion: '3.6.0', fetchImpl: http.fetch });
  return { sink, runs, requests: http.requests, changeOrg: (value: string | undefined) => { org = value; }, loseReceipt: (method: 'POST' | 'PUT') => { loseReceipt = method; } };
}

describe('reviewed refutation recovery', () => {
  it('discovers modern reports and deduplicates copies without using their repeated raw finding ids', async () => {
    const s = await source();
    const copy = join(s.root, 'rcl-report-copy.json');
    await writeFile(copy, s.bytes);
    const inventory = await inventoryRefutations({ roots: [s.root] });
    expect(inventory.kind).toBe('rcl-refutation-inventory');
    expect(inventory.reports).toHaveLength(1);
    expect(inventory.reports[0]).toMatchObject({ sha256: s.sha256, run_id: s.report.run!.id, repo: 'allocator-one/rcl', state: 'ready' });
    expect(inventory.reports[0]!.paths).toEqual(expect.arrayContaining(await Promise.all([s.path, copy].map((path) => realpath(path)))));
    expect(inventory.reports[0]!.refutations.map((f) => [f.ref, f.identity, f.note])).toEqual([
      ['f001', 'abc123def4567890', s.report.findings[0]!.gating!.verification!.note],
      ['f002', 'fedcba9876543210', s.report.belowThresholdFindings![0]!.gating!.verification!.note],
    ]);
  });

  it('plans existing missing evidence with GETs and uploads only its declared original artifact on apply', async () => {
    const s = await source();
    const old = buildRunEnvelope(s.report, { report_json: s.bytes }, { level: 'full', delivery: { mode: 'direct' } });
    for (const f of old.findings) { delete f.verification_note; delete f.verification_model; }
    const remote = server(old);
    const inventory = await inventoryRefutations({ roots: [s.root] });
    const manifest = await planRecovery(inventory, remote.sink);
    expect(manifest.destination).toEqual({ base_url: BASE, org_id: ORG });
    expect(manifest.plans[0]).toMatchObject({ action: 'upload_and_recover', run_id: old.run.id, server: { exists: true, artifact_stored: false, report_sha256: s.sha256 }, delivery: { report_sha256: s.sha256, report_bytes: Buffer.byteLength(s.bytes) } });
    expect(remote.requests.every((r) => r.method === 'GET')).toBe(true);

    const outcome = await applyRecovery(manifest, remote.sink);
    expect(outcome.writes).toEqual({ runs: 0, artifacts: 1 });
    expect(outcome.server_recovery_run_ids).toEqual([old.run.id]);
    expect(remote.requests.filter((r) => r.method !== 'GET').map((r) => [r.method, r.body])).toEqual([['PUT', s.bytes]]);
    expect(remote.runs.get(old.run.id)!.envelope).toEqual(old);
    expect(await readFile(s.path, 'utf8')).toBe(s.bytes);
    const again = await applyRecovery(manifest, remote.sink);
    expect(again.writes).toEqual({ runs: 0, artifacts: 0 });
    expect(again.server_recovery_run_ids).toEqual([old.run.id]);
  });

  it('imports undelivered modern history once with explicit source binding and native notes, without events', async () => {
    const s = await source();
    const remote = server();
    const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    expect(manifest.plans[0]!.action).toBe('import_history');
    expect(remote.requests.every((r) => r.method === 'GET')).toBe(true);
    const outcome = await applyRecovery(manifest, remote.sink);
    expect(outcome.writes).toEqual({ runs: 1, artifacts: 1 });
    const imported = [...remote.runs.values()][0]!.envelope;
    expect(imported.run.id).not.toBe(s.report.run!.id);
    expect(imported.run).toMatchObject({ provenance: 'backfill', historical_source: { original_run_id: s.report.run!.id, report_sha256: s.sha256 }, started_at: s.report.run!.started_at, target: s.report.run!.target });
    expect(imported.findings[0]!.verification_note).toBe(s.report.findings[0]!.gating!.verification!.note);
    expect(outcome.reports[0]!.action).toBe('already_present');
    expect(remote.requests.some((r) => r.url.includes('/events'))).toBe(false);
    const again = await applyRecovery(manifest, remote.sink);
    expect(again.writes).toEqual({ runs: 0, artifacts: 0 });
    expect(remote.runs.size).toBe(1);
  });

  it('refuses changed authenticated organization before any apply writes', async () => {
    const s = await source();
    const remote = server();
    const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    remote.changeOrg('919921a0-0000-4000-8000-000000000002');
    await expect(applyRecovery(manifest, remote.sink)).rejects.toThrow(/organization|destination/i);
    expect(remote.requests.every((r) => r.method === 'GET')).toBe(true);
  });
  it('fails closed on an old receiver without organization metadata', async () => {
    const s = await source();
    const remote = server();
    remote.changeOrg(undefined);
    await expect(planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink)).rejects.toThrow(/destination_unavailable/);
    expect(remote.requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('rejects a changed destination path before using its credential', async () => {
    const s = await source();
    const remote = server();
    const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    const http = fakeFetch(() => { throw new Error('must not be called'); });
    const sink = new HarnessSink({ credential: { url: BASE + '/other', token: 'synthetic', source: 'login' }, rclVersion: '3.6.0', fetchImpl: http.fetch });
    await expect(applyRecovery(manifest, sink)).rejects.toThrow(/destination/);
    expect(http.requests).toHaveLength(0);
  });

  it('uses a hash-verified retained copy when one source location disappears', async () => {
    const s = await source();
    const copy = join(s.root, 'report-copy.json');
    await writeFile(copy, s.bytes);
    const remote = server();
    const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    await rm(s.path);
    expect((await applyRecovery(manifest, remote.sink)).reports[0]!.action).toBe('already_present');
    expect(await readFile(copy, 'utf8')).toBe(s.bytes);
  });

  it('does not deliver a changed source or trust a forged manifest note', async () => {
    const s = await source();
    const remote = server();
    const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    manifest.inventory.reports[0]!.refutations[0]!.note = 'made up';
    expect((await applyRecovery(manifest, remote.sink)).reports[0]!.reason).toBe('source_manifest_mismatch');
    manifest.inventory.reports[0]!.refutations[0]!.note = s.report.findings[0]!.gating!.verification!.note!;
    await writeFile(s.path, s.bytes + ' ');
    expect((await applyRecovery(manifest, remote.sink)).reports[0]!.reason).toBe('source_missing_or_changed');
    expect(remote.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('refuses replacing a recorded run that disappeared after planning', async () => {
    const s = await source();
    const envelope = buildRunEnvelope(s.report, { report_json: s.bytes }, { level: 'full', delivery: { mode: 'direct' } });
    delete envelope.findings[0]!.verification_note;
    const remote = server(envelope);
    const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    remote.runs.clear();
    expect((await applyRecovery(manifest, remote.sink)).reports[0]!.reason).toBe('reviewed_run_disappeared');
    expect(remote.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('refuses a different declaration or any original finding binding, including non-refuted findings', async () => {
    const s = await source();
    const envelope = buildRunEnvelope(s.report, { report_json: s.bytes }, { level: 'full', delivery: { mode: 'direct' } });
    const remote = server(envelope);
    const record = remote.runs.get(envelope.run.id)!;
    record.envelope.artifacts_declared[0]!.bytes++;
    const inventory = await inventoryRefutations({ roots: [s.root] });
    expect((await planRecovery(inventory, remote.sink)).plans[0]!.reason).toBe('server_source_binding_conflict');
    record.envelope.artifacts_declared[0]!.bytes--;
    record.envelope.findings[1]!.identity_key = 'different';
    expect((await planRecovery(inventory, remote.sink)).plans[0]!.reason).toBe('server_source_binding_conflict');
    expect(remote.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('preserves populated native evidence and reports a conflicting source explanation', async () => {
    const s = await source();
    const envelope = buildRunEnvelope(s.report, { report_json: s.bytes }, { level: 'full', delivery: { mode: 'direct' } });
    envelope.findings[0]!.verification_note = 'Different recorded explanation';
    const remote = server(envelope);
    const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    expect(manifest.plans[0]).toMatchObject({ action: 'conflict', reason: 'recorded_evidence_conflict' });
    expect((await applyRecovery(manifest, remote.sink)).writes).toEqual({ runs: 0, artifacts: 0 });
    expect(remote.runs.get(envelope.run.id)!.envelope).toEqual(envelope);
  });

  it.each(['POST', 'PUT'] as const)('resumes a lost %s receipt without duplicating history or events', async (method) => {
    const s = await source();
    const remote = server();
    remote.loseReceipt(method);
    const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    const outcome = await applyRecovery(manifest, remote.sink);
    expect(outcome.reports[0]!.action).toBe('already_present');
    expect((await applyRecovery(manifest, remote.sink)).writes).toEqual({ runs: 0, artifacts: 0 });
    expect(remote.runs.size).toBe(1);
    expect(remote.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(remote.requests.some((r) => /events|checks/.test(r.url))).toBe(false);
  });

  it('concurrent apply converges on one historical identity and preserves the source', async () => {
    const s = await source();
    const remote = server();
    const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    const outcomes = await Promise.all([applyRecovery(manifest, remote.sink), applyRecovery(manifest, remote.sink)]);
    expect(outcomes.every((o) => o.reports[0]!.action === 'already_present')).toBe(true);
    expect(outcomes.reduce((sum, o) => sum + o.writes.runs, 0)).toBe(1);
    expect(remote.runs.size).toBe(1);
    expect(await readFile(s.path, 'utf8')).toBe(s.bytes);
  });

  it('does not escalate a reviewed no-write selection after an artifact disappears', async () => {
    const s = await source();
    const envelope = buildRunEnvelope(s.report, { report_json: s.bytes }, { level: 'full', delivery: { mode: 'direct' } });
    const remote = server(envelope);
    remote.runs.get(envelope.run.id)!.stored = true;
    const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    expect(manifest.plans[0]!.action).toBe('already_present');
    remote.runs.get(envelope.run.id)!.stored = false;
    expect((await applyRecovery(manifest, remote.sink)).reports[0]!.reason).toBe('reviewed_action_changed');
    expect(remote.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('does not retarget an approved historical run to a newly present original run', async () => {
    const s = await source();
    const remote = server();
    const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    const original = buildRunEnvelope(s.report, { report_json: s.bytes }, { level: 'full', delivery: { mode: 'direct' } });
    remote.runs.set(original.run.id, { envelope: original, stored: false });
    const outcome = await applyRecovery(manifest, remote.sink);
    expect(outcome.reports[0]).toMatchObject({ action: 'conflict', reason: 'reviewed_run_binding_changed' });
    expect(remote.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('reuses legacy host/repository/original-byte identity and timing while preserving redacted artifact digests separately', async () => {
    const s = await source();
    delete s.report.run;
    s.report.findings[0]!.gating!.verification!.note = 'The literal sk-ant-abcdefghijklmnopqrstu is redacted; keep this explanation.';
    const bytes = JSON.stringify(s.report); await writeFile(s.path, bytes);
    const stamp = new Date('2026-08-15T10:00:00Z'); await utimes(s.path, stamp, stamp);
    const git = (...args: string[]) => execFileSync('git', ['-C', s.root, ...args], { stdio: 'pipe' });
    git('init'); git('remote', 'add', 'origin', 'https://github.com/owner/legacy.git');
    const old = await buildBackfillRuns({ dir: s.root, repo: 'owner/legacy', host: new URL(BASE).host, rclVersion: '3.6.0' });
    const remote = server();
    const inventory = await inventoryRefutations({ roots: [s.root] });
    expect(inventory.reports[0]).toMatchObject({ state: 'ready', repo: 'owner/legacy' });
    const manifest = await planRecovery(inventory, remote.sink);
    expect(manifest.plans[0]!.run_id).toBe(old.runs[0]!.envelope.run.id);
    expect(manifest.plans[0]).toMatchObject({ delivery: { report_sha256: old.runs[0]!.envelope.artifacts_declared[0]!.sha256 }, server: { exists: false } });
    const outcome = await applyRecovery(manifest, remote.sink);
    expect(outcome.reports[0]!.action).toBe('already_present');
    const imported = [...remote.runs.values()][0]!.envelope;
    expect(imported).toEqual(old.runs[0]!.envelope);
    expect(imported.run.finished_at).toBe(stamp.toISOString());
    expect(imported.run.historical_source).toBeUndefined();
    expect(imported.artifacts_declared[0]!.sha256).not.toBe(inventory.reports[0]!.sha256);
    expect(imported.findings[0]!.verification_note).toContain('[redacted]');
    expect(await readFile(s.path, 'utf8')).toBe(bytes);
    expect((await stat(s.path)).mtime.toISOString()).toBe(stamp.toISOString());
    expect((await applyRecovery(manifest, remote.sink)).writes).toEqual({ runs: 0, artifacts: 0 });
    expect(remote.requests.some((r) => r.url.includes('/events'))).toBe(false);
  });

  it('requires the reviewed repository proof to remain valid for a legacy import', async () => {
    const s = await source(); delete s.report.run; await writeFile(s.path, JSON.stringify(s.report));
    const git = (...args: string[]) => execFileSync('git', ['-C', s.root, ...args], { stdio: 'pipe' });
    git('init'); git('remote', 'add', 'origin', 'https://github.com/owner/legacy.git');
    const remote = server(); const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    git('remote', 'set-url', 'origin', 'https://github.com/owner/different.git');
    expect((await applyRecovery(manifest, remote.sink)).reports[0]!.reason).toBe('repository_proof_changed');
    expect(remote.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('does not post an unsafe modern artifact or invent an absent note', async () => {
    const s = await source(); delete s.report.findings[0]!.gating!.verification!.note;
    await writeFile(s.path, JSON.stringify(s.report));
    const remote = server(); const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    const outcome = await applyRecovery(manifest, remote.sink);
    expect(outcome.reports[0]!.findings[0]!.state).toBe('original_note_absent');
    expect([...remote.runs.values()][0]!.envelope.findings[0]!.verification_note).toBeUndefined();
    s.report.findings[0]!.gating!.verification!.note = 'sk-ant-abcdefghijklmnopqrstu'; await writeFile(s.path, JSON.stringify(s.report));
    const unsafe = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    expect(unsafe.plans[0]).toMatchObject({ action: 'skip', reason: 'original_artifact_requires_redaction' });
    expect((await applyRecovery(unsafe, remote.sink)).writes).toEqual({ runs: 0, artifacts: 0 });
  });

  it('rejects an existing historical id bound to another original source', async () => {
    const s = await source(); const remote = server();
    const inventory = await inventoryRefutations({ roots: [s.root] }); const manifest = await planRecovery(inventory, remote.sink);
    await applyRecovery(manifest, remote.sink);
    [...remote.runs.values()][0]!.envelope.run.historical_source!.original_run_id = '019921a0-0000-7000-8000-000000000002';
    const before = remote.requests.length;
    const outcome = await applyRecovery(manifest, remote.sink);
    expect(outcome.reports[0]).toMatchObject({ action: 'conflict', reason: 'server_source_binding_conflict' });
    expect(remote.requests.slice(before).every((r) => r.method === 'GET')).toBe(true);
  });

  it('recognizes recovered projection provenance and rejects a conflicting source digest', async () => {
    const s = await source(); const envelope = buildRunEnvelope(s.report, { report_json: s.bytes }, { level: 'full', delivery: { mode: 'direct' } });
    const remote = server(envelope); const record = remote.runs.get(envelope.run.id)!; record.stored = true;
    Object.assign(record.envelope.findings[0]!, { verification_provenance: { source: 'report_json', report_sha256: s.sha256, recovered_at: '2026-09-20T12:00:00Z' } });
    const inventory = await inventoryRefutations({ roots: [s.root] });
    expect((await planRecovery(inventory, remote.sink)).plans[0]!.action).toBe('already_present');
    Object.assign(record.envelope.findings[0]!, { verification_provenance: { source: 'report_json', report_sha256: 'a'.repeat(64), recovered_at: '2026-09-20T12:00:00Z' } });
    expect((await planRecovery(inventory, remote.sink)).plans[0]).toMatchObject({ action: 'conflict', reason: 'recorded_evidence_conflict' });
    expect(remote.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('will not import an original whose immutable finding binding changes during transport normalization', async () => {
    const s = await source(); s.report.findings[0]!.file = 'a'.repeat(2100); await writeFile(s.path, JSON.stringify(s.report));
    const remote = server(); const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    expect(manifest.plans[0]).toMatchObject({ action: 'conflict', reason: 'source_binding_requires_transformation' });
    expect((await applyRecovery(manifest, remote.sink)).writes).toEqual({ runs: 0, artifacts: 0 });
  });

  it('recovers from an already stored original without uploading unsafe unrelated report prose again', async () => {
    const s = await source();
    s.report.findings[0]!.description = 'Quoted old test credential sk-ant-abcdefghijklmnopqrstu';
    const bytes = JSON.stringify(s.report); await writeFile(s.path, bytes);
    const envelope = buildRunEnvelope(s.report, { report_json: bytes }, { level: 'full', delivery: { mode: 'direct' } });
    for (const f of envelope.findings) { delete f.verification_note; delete f.verification_model; }
    const remote = server(envelope); remote.runs.get(envelope.run.id)!.stored = true;
    const inventory = await inventoryRefutations({ roots: [s.root] });
    expect(inventory.reports[0]!.state).toBe('unsafe');
    const manifest = await planRecovery(inventory, remote.sink);
    expect(manifest.plans[0]!.action).toBe('recover');
    expect((await applyRecovery(manifest, remote.sink)).server_recovery_run_ids).toEqual([envelope.run.id]);
    expect(remote.requests.every((r) => r.method === 'GET')).toBe(true);
    remote.runs.get(envelope.run.id)!.stored = false;
    expect((await planRecovery(inventory, remote.sink)).plans[0]).toMatchObject({ action: 'conflict', reason: 'original_artifact_requires_redaction' });
  });

  it('rechecks a newly marked synthetic source before any apply write', async () => {
    const s = await source(); const remote = server();
    const manifest = await planRecovery(await inventoryRefutations({ roots: [s.root] }), remote.sink);
    await writeFile(join(s.root, 'SYNTHETIC_TEST_ONLY'), 'synthetic');
    expect((await applyRecovery(manifest, remote.sink)).reports[0]!.reason).toBe('source_marked_synthetic');
    expect(remote.requests.every((r) => r.method === 'GET')).toBe(true);
  });

});
