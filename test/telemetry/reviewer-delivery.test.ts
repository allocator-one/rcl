import { readTextFixture } from '../support/text-fixture.js';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile, mkdtemp, realpath, rm, readdir, stat, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { ReviewerDeliveryQueue } from '../../src/telemetry/reviewer-delivery.js';
import { createReviewerRecoveryPreflight } from '../../src/telemetry/reviewer-preflight.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { inspectReviewerArtifact, serializeReviewerArtifact } from '../../src/report/reviewer-artifact.js';
import { buildRunEnvelope, declareReviewerRecovery } from '../../src/telemetry/envelope.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';
import { deliverRun, flushOutbox, createTelemetryRuntime } from '../../src/telemetry/deliver.js';
import { strictFallbackReviewerFixture } from '../support/strict-fallback-reviewer.js';
import { deliverTerminalReviewerRun } from '../../src/telemetry/terminal-reviewer-delivery.js';
import { NOTICE_FILE } from '../../src/telemetry/notice.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const rows = JSON.parse(readTextFixture(new URL('../fixtures/reviewer-artifact-lineage.json', import.meta.url))).rows;
  const entry = inspectReviewerArtifact(rows[0].artifact_bytes, rows[0].expectations);
  const result = JSON.parse(entry.reportBytes); result.run.reviewer_evidence = entry.descriptor;
  const artifacts = { report_json: JSON.stringify(result), report_md: '# Synthetic review' };
  const artifact = serializeReviewerArtifact({ assembly: entry.assembly, reportBytes: artifacts.report_json, representation: entry.representation });
  const declaration = declareReviewerRecovery({ artifact, descriptor: entry.descriptor });
  const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-private-delivery-'))); roots.push(root);
  return { root, entry, result, artifacts, artifact, envelope, runId: result.run.id as string };
}
type DeliveryFixture = Pick<Awaited<ReturnType<typeof fixture>>, 'runId' | 'artifacts' | 'artifact'>;
function server(f: DeliveryFixture) {
  const requests: Array<{ method: string; url: string; body?: string; token: string }> = [];
  let privateBytes: string | undefined; let posted = false; let postedEnvelope: string | undefined;
  let lostAck = false; let losePost = false; let refused = false; let capability = true; let requireReports = false;
  let corruptOrdinaryReadback: string | undefined;
  let runReceipt: 'valid' | 'absent' | 'mismatch' | 'malformed' = 'valid';
  let principal = { org_id: '919921a0-0000-4000-8000-000000000001', actor_user_id: '919921a0-0000-4000-8000-000000000002', credential_kind: 'cli', api_token_id: null };
  let activationShape: 'full' | 'protocol-only' | 'principal-only' = 'full';
  const generic = new Map<string, string>();
  const fetchImpl = async (url: any, options: any): Promise<Response> => {
    const route = String(url); requests.push({ method: options.method, url: route, body: options.body, token: options.headers.authorization });
    if (route.endsWith('/model-stats')) return Response.json({ data: { models: [] }, meta: capability ? { reviewer_recovery_protocol: 2,
      ...(activationShape === 'principal-only' ? {} : { reviewer_recovery_activation_protocol: 1 }),
      ...(activationShape === 'protocol-only' ? {} : { reviewer_recovery_principal: principal }),
      reviewer_checkpoint_plan_version: 2, reviewer_capture_version: 2, reviewer_provider_concurrency_version: 1, reviewer_artifact_schema: 1, reviewer_artifact_max_bytes: 25000000 } : {} });
    if (refused) return Response.json({ error: 'forbidden', message: 'SYNTHETIC_PRIVATE_DETAIL' }, { status: 403 });
    if (options.method === 'GET' && new URL(route).pathname.endsWith(`/runs/${f.runId}`)) {
      if (!posted || runReceipt === 'absent') return Response.json({ error: 'not_found' }, { status: 404 });
      if (!postedEnvelope) return Response.json({ data: { id: f.runId }, meta: { status: 'existing' } });
      const envelope = JSON.parse(postedEnvelope);
      const body: any = { data: { id: f.runId, url: `https://harness.example.test/api/v1/reviews/runs/${f.runId}`,
        envelope_sha256: runReceipt === 'mismatch' ? '0'.repeat(64) : sha256(postedEnvelope),
        artifacts_declared: envelope.artifacts_declared }, meta: { status: 'existing' } };
      if (runReceipt === 'malformed') body.unexpected = true;
      return Response.json(body);
    }
    if (route.endsWith('/reviewer-artifact')) {
      if (options.method === 'PUT') { if (requireReports && (generic.get('report_json') !== f.artifacts.report_json || generic.get('report_md') !== f.artifacts.report_md)) return Response.json({ error: 'source_unavailable' }, { status: 503 }); privateBytes = options.body; if (lostAck) throw new Error('lost ACK'); return Response.json({ data: { run_id: f.runId, sha256: f.artifact.digest, bytes: Buffer.byteLength(privateBytes!) }, meta: { status: 'created' } }, { status: 201 }); }
      if (privateBytes === undefined) return Response.json(posted ? { error: 'reviewer_artifact_pending', data: { run_id: f.runId, sha256: f.artifact.digest, bytes: Buffer.byteLength(f.artifact.bytes) } } : { error: 'not_found' }, { status: 404 });
      return new Response(privateBytes, { headers: { 'content-type': 'application/octet-stream', 'x-artifact-sha256': sha256(privateBytes), 'cache-control': 'private, no-store', 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff' } });
    }
    if (route.endsWith('/runs')) { posted = true; postedEnvelope = options.body; if (losePost) { losePost = false; posted = false; throw new Error('lost POST response'); } return Response.json({ data: { id: f.runId, url: 'https://harness.example.test/run', artifacts_expected: ['report_json', 'report_md'] }, meta: { status: 'existing' } }); }
    const kind = route.split('/').at(-1)!;
    if (options.method === 'PUT') { generic.set(kind, options.body); return Response.json({ data: { kind, sha256: sha256(options.body) } }, { status: 201 }); }
    const stored = generic.get(kind);
    if (stored === undefined) return Response.json({ error: 'not_found' }, { status: 404 });
    const responseBytes = corruptOrdinaryReadback === kind
      ? `${stored[0] === 'x' ? 'y' : 'x'}${stored.slice(1)}`
      : stored;
    return new Response(responseBytes, { headers: { 'content-type': 'application/octet-stream', 'x-artifact-sha256': sha256(responseBytes) } });
  };
  const sink = (token = 'first-login', source: 'login' | 'env' = 'login') => new HarnessSink({ credential: { url: 'https://harness.example.test', token, source }, rclVersion: 'test', fetchImpl });
  return { requests, sink, fetchImpl, requireReports: () => { requireReports = true; }, loseAck: () => { lostAck = true; }, losePost: () => { losePost = true; }, refuse: () => { refused = true; }, unsupported: () => { capability = false; }, posted: () => { posted = true; }, existing: (envelope: string) => { posted = true; postedEnvelope = envelope; }, receipt: (value: typeof runReceipt) => { runReceipt = value; }, corruptReadback: (kind: string) => { corruptOrdinaryReadback = kind; }, activation: (shape: typeof activationShape) => { activationShape = shape; }, changePrincipal: () => { principal = { ...principal, org_id: '919921a0-0000-4000-8000-000000000099' }; }, apiPrincipal: () => { principal = { ...principal, credential_kind: 'api_token', api_token_id: '919921a0-0000-4000-8000-000000000003' }; } };
}

function recoverySelection(retained: Awaited<ReturnType<typeof strictFallbackReviewerFixture>>, envelope: ReturnType<typeof buildRunEnvelope>) {
  const envelopeBytes = JSON.stringify(envelope), markdown = retained.artifacts.report_md!;
  return { target: 'rcl-159', runId: retained.runId, headSha: 'a'.repeat(40),
    reportSha256: sha256(retained.artifacts.report_json), reportByteLength: Buffer.byteLength(retained.artifacts.report_json), reportBytes: retained.artifacts.report_json,
    reviewerArtifactSha256: retained.artifact.digest, reviewerArtifactByteLength: Buffer.byteLength(retained.artifact.bytes), reviewerArtifactBytes: retained.artifact.bytes,
    envelopeSha256: sha256(envelopeBytes), envelopeByteLength: Buffer.byteLength(envelopeBytes), envelopeBytes,
    reportMarkdownSha256: sha256(markdown), reportMarkdownByteLength: Buffer.byteLength(markdown), reportMarkdownBytes: markdown };
}

describe('private immutable reviewer delivery', () => {
  it('delivers only a branded sealed-failed strict fallback without rewriting its report', async () => {
    const make = async (terminal: 'failed' | 'complete' = 'failed') => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-strict-fallback-delivery-'))); roots.push(root);
      return { root, ...await strictFallbackReviewerFixture(root, terminal) };
    };
    const strict = await make(), remote = server(strict);
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: strict.root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' },
      fetchImpl: remote.fetchImpl });

    expect(strict.artifact.validation.gate).toMatchObject({ reportedCiExitCode: 1,
      conservativeCiExitCode: 1, annotations: [] });
    const strictOutcome = await deliverRun(runtime, { result: strict.result, artifacts: strict.artifacts,
      reviewerArtifact: strict.artifact, evidenceRequired: true });
    expect(strictOutcome).toMatchObject({ status: 'recorded', exitCode: 0 });
    expect(remote.requests.find(row => row.url.endsWith('/artifacts/report_json'))?.body)
      .toBe(strict.artifacts.report_json);

    const mismatched = await make(), mismatchedRemote = server(mismatched);
    const mismatchedResult = structuredClone(mismatched.result);
    mismatchedResult.stats.totalReviews++;
    const mismatchedRuntime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: mismatched.root,
      env: {}, credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' },
      fetchImpl: mismatchedRemote.fetchImpl });
    expect(await deliverRun(mismatchedRuntime, { result: mismatchedResult, artifacts: mismatched.artifacts,
      reviewerArtifact: mismatched.artifact, evidenceRequired: true }))
      .toMatchObject({ status: 'rejected', exitCode: 4 });
    expect(mismatchedRemote.requests).toEqual([]);

    const unbranded = await make(), unbrandedRemote = server(unbranded);
    const unbrandedRuntime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: unbranded.root,
      env: {}, credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' },
      fetchImpl: unbrandedRemote.fetchImpl });
    expect(await deliverRun(unbrandedRuntime, { result: unbranded.result, artifacts: unbranded.artifacts,
      reviewerArtifact: structuredClone(unbranded.artifact) as any, evidenceRequired: true }))
      .toMatchObject({ status: 'rejected', exitCode: 4 });
    expect(unbrandedRemote.requests).toEqual([]);

    for (const [terminal, mutate] of [
      ['failed', (result: any) => { result.findings[0].gating = { reason: 'invalid' }; }],
      ['failed', (result: any) => { result.run.ci_exit_code = 0; }],
      ['complete', (result: any) => {
        for (const finding of [...result.findings, ...(result.belowThresholdFindings ?? [])]) delete finding.gating;
        delete result.stats.verification;
      }],
    ] as const) {
      const changedFixture = await make(terminal), changedRemote = server(changedFixture);
      const changed = structuredClone(changedFixture.result);
      mutate(changed);
      const changedArtifacts = { ...changedFixture.artifacts, report_json: JSON.stringify(changed) };
      const changedRuntime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: changedFixture.root,
        env: {}, credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' },
        fetchImpl: changedRemote.fetchImpl });
      expect(await deliverRun(changedRuntime, { result: changed, artifacts: changedArtifacts,
        reviewerArtifact: changedFixture.artifact, evidenceRequired: true }))
        .toMatchObject({ status: 'rejected', exitCode: 4 });
      expect(changedRemote.requests).toEqual([]);
    }
  });

  it('refuses terminal recovery without an exact retained reviewer outbox', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-terminal-reviewer-delivery-'))); roots.push(root);
    const retained = { root, ...await strictFallbackReviewerFixture(root) };
    const remote = server(retained);
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' },
      fetchImpl: remote.fetchImpl });

    await expect(deliverTerminalReviewerRun(runtime, { preview: true, manifest: join(root, 'manifest.json'),
      commonDir: root, target: 'rcl-159', runId: retained.runId })).rejects.toThrow();
    expect(remote.requests).toEqual([]);
  });

  it('activates an exact retained outbox after an unknown-run flush refuses, then resumes a lost acknowledgement without provider calls', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-activation-'))); roots.push(root);
    const retained = { root, ...await strictFallbackReviewerFixture(root) };
    const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
    const declaration = declareReviewerRecovery({ artifact: retained.artifact,
      descriptor: retained.result.run.reviewer_evidence });
    const envelope = buildRunEnvelope(retained.result, retained.artifacts,
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });

    expect(await queue.flush(remote.sink(), { runId: retained.runId })).toMatchObject({
      delivered: [], remaining: [retained.runId],
      failed: [{ id: retained.runId, reason: 'reviewer_delivery_refused' }],
    });
    expect(remote.requests.some(row => row.method !== 'GET')).toBe(false);

    remote.requireReports(); remote.loseAck();
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' },
      fetchImpl: remote.fetchImpl });
    const recoveryManifest = join(root, 'activation.json');
    const prepared = await deliverTerminalReviewerRun(runtime, { preview: true, manifest: recoveryManifest,
      commonDir: root, target: 'rcl-159', runId: retained.runId });
    expect(prepared.status).toBe('prepared');
    expect(await deliverTerminalReviewerRun(runtime, { apply: true, manifest: recoveryManifest,
      manifestSha256: prepared.manifest_sha256, commonDir: root })).toMatchObject({ status: 'complete' });
    expect(await deliverTerminalReviewerRun(runtime, { resume: true, manifest: recoveryManifest,
      manifestSha256: prepared.manifest_sha256, commonDir: root })).toMatchObject({ status: 'complete' });

    expect(remote.requests.filter(row => row.method === 'POST' && row.url.endsWith('/runs')).map(row => row.body))
      .toEqual([JSON.stringify(envelope)]);
    expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'))).toHaveLength(1);
    expect(remote.requests.some(row => /provider|model\/chat|completion/.test(row.url))).toBe(false);
    const directory = join(root, 'reviewer-outbox', retained.runId);
    const manifestBytes = await readFile(join(directory, 'manifest.json'), 'utf8');
    expect(await readFile(join(directory, 'acknowledged.json'), 'utf8')).toBe(JSON.stringify({
      version: 1, runId: retained.runId, manifestSha256: sha256(manifestBytes),
    }));
    expect(JSON.parse(await readFile(join(directory, 'recovery-acknowledged.json'), 'utf8'))).toMatchObject({
      operationId: prepared.operation_id,
      recoveryManifestSha256: prepared.manifest_sha256,
      destination: { activationProtocol: 1, principal: { credential_kind: 'cli' } },
      envelope: { sha256: sha256(JSON.stringify(envelope)) },
    });
  });

  it('previews without writing and pins an explicit manifest before apply or resume', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-preview-'))); roots.push(root);
    const retained = { root, ...await strictFallbackReviewerFixture(root) };
    const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
    const declaration = declareReviewerRecovery({ artifact: retained.artifact, descriptor: retained.result.run.reviewer_evidence });
    const envelope = buildRunEnvelope(retained.result, retained.artifacts,
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
    const manifest = join(root, 'activation-manifest.json');
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl });

    const result = await deliverTerminalReviewerRun(runtime, {
      commonDir: root, target: 'rcl-159', runId: retained.runId, preview: true, manifest,
    });

    expect(result).toMatchObject({ status: 'prepared', manifest });
    expect(JSON.parse(await readFile(manifest, 'utf8'))).toMatchObject({
      kind: 'rcl-retained-reviewer-activation', operation_id: expect.any(String),
    });
    await expect(deliverTerminalReviewerRun(runtime, { apply: true, manifest,
      manifestSha256: '0'.repeat(64), commonDir: root })).rejects.toThrow('reviewer_delivery_manifest_digest_mismatch');
    await expect(deliverTerminalReviewerRun(runtime, { apply: true, manifest,
      manifestSha256: result.manifest_sha256, target: 'rcl-159', commonDir: root }))
      .rejects.toThrow('reviewer_delivery_apply_uses_only_pinned_manifest');
    expect(remote.requests.every(row => row.method === 'GET')).toBe(true);
  });

  it('preserves published mode-less delivery and exact result shape when no private outbox exists', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-terminal-reviewer-legacy-delivery-'))); roots.push(root);
    const retained = { root, ...await strictFallbackReviewerFixture(root) };
    const remote = server(retained);
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl });

    const result = await deliverTerminalReviewerRun(runtime, { commonDir: root, target: 'rcl-159', runId: retained.runId });

    expect(Object.keys(result)).toEqual(['outcome', 'reportSha256', 'reviewerArtifactSha256']);
    expect(result).toMatchObject({ outcome: { status: 'recorded', exitCode: 0 },
      reportSha256: sha256(retained.artifacts.report_json), reviewerArtifactSha256: retained.artifact.digest });
    expect(remote.requests.filter(row => row.method === 'POST' && row.url.endsWith('/runs'))).toHaveLength(1);
  });

  it('refuses mode-less target/run for a retained outbox before local or remote mutation', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-legacy-cli-'))); roots.push(root);
    const retained = { root, ...await strictFallbackReviewerFixture(root) };
    const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
    const declaration = declareReviewerRecovery({ artifact: retained.artifact, descriptor: retained.result.run.reviewer_evidence });
    const envelope = buildRunEnvelope(retained.result, retained.artifacts,
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
    await writeFile(join(root, 'reviewer-outbox', retained.runId, 'manifest.json'), '{}', { mode: 0o600 });
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl });

    await expect(deliverTerminalReviewerRun(runtime, { commonDir: root, cwd: root,
      target: 'rcl-159', runId: retained.runId })).rejects.toThrow(/reviewer_delivery_explicit_activation_required.*--preview/);

    expect(remote.requests).toEqual([]);
    await expect(stat(join(root, `rcl-retained-reviewer-activation-${retained.runId}.json`)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(root, 'reviewer-outbox', retained.runId, 'activation-intent.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('shows and records the private notice before preview network reads and stops cleanly if display fails', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-notice-'))); roots.push(root);
    const retained = { root, ...await strictFallbackReviewerFixture(root) };
    const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
    const declaration = declareReviewerRecovery({ artifact: retained.artifact, descriptor: retained.result.run.reviewer_evidence });
    const envelope = buildRunEnvelope(retained.result, retained.artifacts,
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl });
    runtime.stderr = () => { throw new Error('notice unavailable'); };
    const manifest = join(root, 'activation.json');

    await expect(deliverTerminalReviewerRun(runtime, { preview: true, manifest, commonDir: root,
      target: 'rcl-159', runId: retained.runId })).rejects.toThrow('notice unavailable');

    expect(remote.requests).toEqual([]);
    await expect(stat(manifest)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(root, NOTICE_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(root, 'reviewer-outbox', retained.runId, 'activation-intent.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never repeats an activation POST after a durable intent when its response is lost', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-post-intent-'))); roots.push(root);
    const retained = { root, ...await strictFallbackReviewerFixture(root) };
    const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
    const declaration = declareReviewerRecovery({ artifact: retained.artifact, descriptor: retained.result.run.reviewer_evidence });
    const envelope = buildRunEnvelope(retained.result, retained.artifacts,
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl });
    const manifest = join(root, 'activation.json');
    const preview = await deliverTerminalReviewerRun(runtime, { preview: true, manifest, commonDir: root,
      target: 'rcl-159', runId: retained.runId });
    remote.losePost();
    await expect(deliverTerminalReviewerRun(runtime, { apply: true, manifest, commonDir: root,
      manifestSha256: preview.manifest_sha256 })).rejects.toThrow('reviewer_delivery_activation_post_uncertain');
    await expect(deliverTerminalReviewerRun(runtime, { resume: true, manifest, commonDir: root,
      manifestSha256: preview.manifest_sha256 })).rejects.toThrow('reviewer_delivery_activation_post_uncertain');
    const secondManifest = join(root, 'second-activation.json');
    const second = await deliverTerminalReviewerRun(runtime, { preview: true, manifest: secondManifest, commonDir: root,
      target: 'rcl-159', runId: retained.runId });
    await expect(deliverTerminalReviewerRun(runtime, { apply: true, manifest: secondManifest, commonDir: root,
      manifestSha256: second.manifest_sha256 })).rejects.toThrow('reviewer_delivery_activation_operation_conflict');
    expect(remote.requests.filter(row => row.method === 'POST' && row.url.endsWith('/runs'))).toHaveLength(1);
  });

  it('refuses a changed exact recovery principal before any write', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-principal-'))); roots.push(root);
    const retained = { root, ...await strictFallbackReviewerFixture(root) };
    const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
    const declaration = declareReviewerRecovery({ artifact: retained.artifact, descriptor: retained.result.run.reviewer_evidence });
    const envelope = buildRunEnvelope(retained.result, retained.artifacts,
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl });
    const manifest = join(root, 'activation.json');
    const preview = await deliverTerminalReviewerRun(runtime, { preview: true, manifest, commonDir: root,
      target: 'rcl-159', runId: retained.runId });
    remote.changePrincipal();
    await expect(deliverTerminalReviewerRun(runtime, { apply: true, manifest, commonDir: root,
      manifestSha256: preview.manifest_sha256 }))
      .rejects.toThrow('reviewer_delivery_principal_mismatch');
    expect(remote.requests.some(row => row.method !== 'GET')).toBe(false);
  });

  it('requires the atomic activation protocol and exact CLI or API-token principal tuple', async () => {
    for (const shape of ['protocol-only', 'principal-only'] as const) {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-capability-'))); roots.push(root);
      const retained = { root, ...await strictFallbackReviewerFixture(root) };
      const remote = server(retained); remote.activation(shape);
      await expect(remote.sink().checkReviewerRecoveryActivation()).resolves.toMatchObject({
        kind: 'rejected', error: 'unsupported_reviewer_recovery_activation',
      });
      expect(remote.requests.every(row => row.method === 'GET')).toBe(true);
    }
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-api-principal-'))); roots.push(root);
    const retained = { root, ...await strictFallbackReviewerFixture(root) }, remote = server(retained);
    remote.apiPrincipal();
    await expect(remote.sink('api-token', 'env').checkReviewerRecoveryActivation()).resolves.toMatchObject({
      kind: 'ok', value: { protocol: 1, principal: { credential_kind: 'api_token',
        api_token_id: '919921a0-0000-4000-8000-000000000003' } },
    });
  });

  it('authenticates exact envelope and Markdown bytes to terminal lineage', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-full-lineage-'))); roots.push(root);
    const retained = { root, ...await strictFallbackReviewerFixture(root) };
    const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
    const declaration = declareReviewerRecovery({ artifact: retained.artifact, descriptor: retained.result.run.reviewer_evidence });
    const envelope = buildRunEnvelope(retained.result, retained.artifacts,
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
    const directory = join(root, 'reviewer-outbox', retained.runId);
    const alteredMarkdown = `${retained.artifacts.report_md}\naltered`;
    const alteredEnvelope = buildRunEnvelope(retained.result, { ...retained.artifacts, report_md: alteredMarkdown },
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    manifest.envelope = { sha256: sha256(JSON.stringify(alteredEnvelope)), bytes: Buffer.byteLength(JSON.stringify(alteredEnvelope)) };
    manifest.report_md = { sha256: sha256(alteredMarkdown), bytes: Buffer.byteLength(alteredMarkdown) };
    await writeFile(join(directory, 'envelope.json'), JSON.stringify(alteredEnvelope), { mode: 0o600 });
    await writeFile(join(directory, 'report.md'), alteredMarkdown, { mode: 0o600 });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });

    await expect(deliverTerminalReviewerRun(await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl }),
    { preview: true, manifest: join(root, 'activation.json'), commonDir: root, target: 'rcl-159', runId: retained.runId })).rejects.toThrow();
    expect(remote.requests.some(row => row.method !== 'GET')).toBe(false);
  });

  it('requires exact ordinary JSON and Markdown readback before a recovery acknowledgement', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-readback-'))); roots.push(root);
    const retained = { root, ...await strictFallbackReviewerFixture(root) };
    const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
    const declaration = declareReviewerRecovery({ artifact: retained.artifact, descriptor: retained.result.run.reviewer_evidence });
    const envelope = buildRunEnvelope(retained.result, retained.artifacts,
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
    remote.posted();
    await queue.deliver({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
    await rm(join(root, 'reviewer-outbox', retained.runId, 'acknowledged.json'));
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl });
    const manifest = join(root, 'activation.json');
    const preview = await deliverTerminalReviewerRun(runtime, { preview: true, manifest, commonDir: root,
      target: 'rcl-159', runId: retained.runId });
    const before = remote.requests.length;
    await deliverTerminalReviewerRun(runtime, { apply: true, manifest, commonDir: root, manifestSha256: preview.manifest_sha256 });
    const replay = remote.requests.slice(before);
    expect(replay.some(row => row.method === 'GET' && row.url.endsWith('/artifacts/report_json'))).toBe(true);
    expect(replay.some(row => row.method === 'GET' && row.url.endsWith('/artifacts/report_md'))).toBe(true);
  });

  it.each(['absent', 'mismatch', 'malformed'] as const)(
    'refuses an existing remote run with an %s exact-envelope receipt before artifact writes or acknowledgement',
    async receipt => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-envelope-receipt-'))); roots.push(root);
      const retained = { root, ...await strictFallbackReviewerFixture(root) };
      const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
      const declaration = declareReviewerRecovery({ artifact: retained.artifact, descriptor: retained.result.run.reviewer_evidence });
      const envelope = buildRunEnvelope(retained.result, retained.artifacts,
        { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
      const envelopeBytes = JSON.stringify(envelope);
      await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
      const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
        credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl });
      const manifest = join(root, 'activation.json');
      const preview = await deliverTerminalReviewerRun(runtime, { preview: true, manifest, commonDir: root,
        target: 'rcl-159', runId: retained.runId });
      remote.existing(envelopeBytes); remote.receipt(receipt);
      const before = remote.requests.length;

      await expect(deliverTerminalReviewerRun(runtime, { apply: true, manifest, commonDir: root,
        manifestSha256: preview.manifest_sha256 })).rejects.toThrow('reviewer_delivery_envelope_receipt');

      const replay = remote.requests.slice(before);
      expect(replay.some(row => row.method === 'GET' && new URL(row.url).pathname.endsWith(`/runs/${retained.runId}`))).toBe(true);
      expect(replay.some(row => row.method === 'PUT')).toBe(false);
      const directory = join(root, 'reviewer-outbox', retained.runId);
      await expect(stat(join(directory, 'recovery-acknowledged.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(directory, 'acknowledged.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('refuses a recovery acknowledgement when ordinary readback differs from retained bytes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-corrupt-readback-'))); roots.push(root);
    const retained = { root, ...await strictFallbackReviewerFixture(root) };
    const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
    const declaration = declareReviewerRecovery({ artifact: retained.artifact, descriptor: retained.result.run.reviewer_evidence });
    const envelope = buildRunEnvelope(retained.result, retained.artifacts,
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl });
    const manifest = join(root, 'activation.json');
    const preview = await deliverTerminalReviewerRun(runtime, { preview: true, manifest, commonDir: root,
      target: 'rcl-159', runId: retained.runId });
    remote.corruptReadback('report_json');

    await expect(deliverTerminalReviewerRun(runtime, { apply: true, manifest, commonDir: root,
      manifestSha256: preview.manifest_sha256 })).rejects.toThrow('reviewer_delivery_ordinary_mismatch');
    const directory = join(root, 'reviewer-outbox', retained.runId);
    await expect(readFile(join(directory, 'recovery-acknowledged.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(directory, 'acknowledged.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds retained activation to the exact lineage selection and immutable outbox before any write', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-binding-'))); roots.push(root);
    const retained = { root, ...await strictFallbackReviewerFixture(root) };
    const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
    const declaration = declareReviewerRecovery({ artifact: retained.artifact,
      descriptor: retained.result.run.reviewer_evidence });
    const envelope = buildRunEnvelope(retained.result, retained.artifacts,
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
    const selection = recoverySelection(retained, envelope);
    const preview = await queue.previewRecovery(selection);

    for (const changed of [
      { ...selection, target: 'rcl-elsewhere' },
      { ...selection, headSha: 'b'.repeat(40) },
      { ...selection, reportSha256: 'c'.repeat(64) },
      { ...selection, reportByteLength: selection.reportByteLength + 1 },
      { ...selection, reviewerArtifactSha256: 'd'.repeat(64) },
      { ...selection, reviewerArtifactByteLength: selection.reviewerArtifactByteLength + 1 },
      { ...selection, envelopeSha256: 'e'.repeat(64) },
      { ...selection, envelopeByteLength: selection.envelopeByteLength + 1 },
      { ...selection, reportMarkdownSha256: 'f'.repeat(64) },
      { ...selection, reportMarkdownByteLength: selection.reportMarkdownByteLength + 1 },
    ]) await expect(queue.previewRecovery(changed)).rejects.toThrow('reviewer_delivery_recovery_selection_mismatch');

    const changedPreviews = [
      { ...preview, manifest: { ...preview.manifest, sha256: '1'.repeat(64) } },
      { ...preview, envelope: { ...preview.envelope, sha256: '2'.repeat(64) } },
      { ...preview, report_json: { ...preview.report_json, sha256: '3'.repeat(64) } },
      { ...preview, report_md: { ...preview.report_md!, sha256: '4'.repeat(64) } },
      { ...preview, reviewer: { ...preview.reviewer, sha256: '5'.repeat(64) } },
    ];
    for (const changed of changedPreviews) {
      await expect(queue.applyRecovery(remote.sink(), selection, changed, undefined as any)).rejects
        .toThrow('reviewer_delivery_recovery_selection_mismatch');
    }
    expect(remote.requests).toEqual([]);

    expect(remote.requests.some(row => row.method !== 'GET')).toBe(false);
  });

  it('persists privately before network and recovers lost PUT ACK with renewed login and no duplicate private PUT', async () => {
    const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
    remote.requireReports(); remote.loseAck();
    await expect(queue.deliver({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact })).rejects.toThrow('reviewer_delivery_unavailable');
    const before = remote.requests.length;
    const fresh = new ReviewerDeliveryQueue(f.root);
    expect(await fresh.flush(remote.sink('renewed-login'))).toMatchObject({ delivered: [f.runId], remaining: [] });
    const replay = remote.requests.slice(before);
    expect(replay[0]!.url).toMatch(/model-stats$/);
    expect(replay.find(row => !row.url.endsWith('/model-stats'))).toMatchObject({ method: 'GET', url: expect.stringContaining('/reviewer-artifact') });
    expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'))).toHaveLength(1);
    expect(remote.requests.filter(row => row.url.endsWith('/runs')).map(row => row.body)).toEqual([JSON.stringify(f.envelope)]);
    expect(replay.some(row => row.url.endsWith('/runs'))).toBe(false);
    expect(replay.some(row => /\/artifacts\/(report_json|report_md)$/.test(row.url))).toBe(false);
    expect(replay.every(row => row.token === 'Bearer renewed-login')).toBe(true);
    const directory = join(f.root, 'reviewer-outbox', f.runId.toLowerCase());
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(directory)) { const path = join(directory, name); expect((await stat(path)).mode & 0o777).toBe(0o600); const text = await readFile(path, 'utf8'); expect(text).not.toContain('first-login'); expect(text).not.toContain('renewed-login'); }
    expect(await readFile(join(directory, 'reviewer-artifact.json'), 'utf8')).toBe(f.artifact.bytes);
    expect(JSON.parse(await readFile(join(directory, 'acknowledged.json'), 'utf8'))).toMatchObject({ version: 1, runId: f.runId });
    expect(await fresh.flush(remote.sink())).toMatchObject({ delivered: [], remaining: [] });
  });

  it('never sends stored private bytes for a changed owner/token, unsupported capability, unknown run or corrupt disk', async () => {
    for (const scenario of ['owner', 'capability', 'unknown', 'corrupt'] as const) {
      const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
      await queue.retain({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
      if (scenario === 'owner') remote.refuse();
      if (scenario === 'capability') remote.unsupported();
      if (scenario === 'corrupt') await writeFile(join(f.root, 'reviewer-outbox', f.runId.toLowerCase(), 'reviewer-artifact.json'), 'corrupt');
      const result = await queue.flush(remote.sink('different-login'));
      expect(result.delivered).toEqual([]); expect(result.remaining).toEqual([f.runId]);
      expect(remote.requests.some(row => row.method !== 'GET')).toBe(false);
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_DETAIL');
    }
  });

  it('preserves immutable payload conflicts and binds host/credential kind without token-string identity', async () => {
    const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
    await queue.retain({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
    await expect(queue.retain({ sink: remote.sink(), envelope: f.envelope, artifacts: { ...f.artifacts, report_md: 'changed' }, artifact: f.artifact })).rejects.toThrow();
    expect((await queue.flush(remote.sink('API-token', 'env'))).delivered).toEqual([]);
    expect(remote.requests).toHaveLength(0);
    await expect(queue.deliver({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: structuredClone(f.artifact) })).rejects.toThrow();
    expect(remote.requests).toHaveLength(0);
  });

  it('integrates the coordinator without placing private bytes into generic outbox/artifact routes', async () => {
    const f = await fixture(), remote = server(f); remote.loseAck();
    const lines: string[] = [];
    const checkedFetch = async (url: any, options: any) => { expect(lines.join('\n')).toContain('captured prompts and raw reviewer results'); return remote.fetchImpl(url, options); };
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: f.root, env: {}, credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: checkedFetch, stderr: line => { lines.push(line); } });
    expect(await deliverRun(runtime, { result: f.result, artifacts: f.artifacts, reviewerArtifact: f.artifact, evidenceRequired: true })).toMatchObject({ status: 'spooled', spooled: true, exitCode: 4 });
    expect(await readdir(join(f.root, 'outbox')).catch(() => [])).toEqual([]);
    expect(await flushOutbox(runtime)).toMatchObject({ delivered: [f.runId] });
    expect(lines.join('\n')).not.toContain('first-login');
    expect(lines.join('\n')).not.toContain(f.artifact.bytes);
    expect(remote.requests.filter(row => row.method === 'PUT' && row.body === f.artifact.bytes).every(row => row.url.endsWith('/reviewer-artifact'))).toBe(true);
  });

  it('authorizes each private flush entry immediately before transport and fails closed', async () => {
    const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
    await queue.retain({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
    remote.posted();
    let authorized = false;
    const checked = new HarnessSink({
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' },
      rclVersion: 'test',
      fetchImpl: async (url, options) => {
        expect(authorized).toBe(true);
        return remote.fetchImpl(url, options);
      },
    });
    expect(await queue.flush(checked, {}, async () => { authorized = true; })).toMatchObject({ delivered: [f.runId] });

    const next = await fixture(), refused = server(next), pending = new ReviewerDeliveryQueue(next.root);
    await pending.retain({ sink: refused.sink(), envelope: next.envelope, artifacts: next.artifacts, artifact: next.artifact });
    expect(await pending.flush(refused.sink(), {}, async () => { throw new Error('notice unavailable'); })).toMatchObject({
      delivered: [], remaining: [next.runId],
    });
    expect(refused.requests).toEqual([]);
  });

  it('rejects a verified-consensus result/report mismatch before private queue or transport writes', async () => {
    const f = await fixture(), remote = server(f);
    const result = structuredClone(f.result);
    result.run.gating.mode = 'verified-consensus';
    const runtime = await createTelemetryRuntime({
      rclVersion: 'test', config: {}, dataDir: f.root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' },
      fetchImpl: remote.fetchImpl,
    });

    expect(await deliverRun(runtime, {
      result,
      artifacts: f.artifacts,
      reviewerArtifact: f.artifact,
      evidenceRequired: true,
    })).toMatchObject({ status: 'rejected', spooled: false, exitCode: 4 });

    expect(remote.requests).toEqual([]);
    expect(await readdir(join(f.root, 'reviewer-outbox')).catch(() => [])).toEqual([]);
  });

  it('checks real credential capability and immediate source before recovery work, treating pending as unavailable source', async () => {
    const f = await fixture(), remote = server(f); const request = { target: f.entry.proof.plan.target, headSha: f.entry.proof.plan.headSha, successorRunId: '00000000-0000-4000-8000-000000000999', source: { runId: f.runId, reportSha256: sha256(f.artifacts.report_json), reviewerArtifactSha256: f.artifact.digest }, lineage: [{ runId: f.runId, reportSha256: sha256(f.artifacts.report_json), reviewerArtifactSha256: f.artifact.digest }] };
    const preflight = createReviewerRecoveryPreflight(remote.sink());
    await expect(preflight(request)).rejects.toThrow('reviewer_recovery_source_unavailable');
    remote.posted();
    await expect(preflight(request)).rejects.toThrow('reviewer_recovery_source_unavailable');
    await new ReviewerDeliveryQueue(f.root).deliver({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
    await expect(preflight(request)).resolves.toBeUndefined();
    remote.unsupported();
    await expect(preflight(request)).rejects.toThrow('reviewer_recovery_capability_unavailable');
  });
  it('reopens lost-ACK delivery in a fresh process over actual loopback HTTP with the same immutable files', async () => {
    const f = await fixture(), remote = server(f); remote.requireReports(); remote.loseAck();
    const http = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      try {
        const answer = await remote.fetchImpl(`http://localhost${request.url}`, { method: request.method, body: Buffer.concat(chunks).toString('utf8'), headers: request.headers });
        response.writeHead(answer.status, Object.fromEntries(answer.headers)); response.end(Buffer.from(await answer.arrayBuffer()));
      } catch { response.destroy(); }
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(http.address() as any).port}`;
      const sink = new HarnessSink({ credential: { url, source: 'login', token: 'first-login' }, rclVersion: 'test' });
      await expect(new ReviewerDeliveryQueue(f.root).deliver({ sink, envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact })).rejects.toThrow('reviewer_delivery_unavailable');
      const script = `import {ReviewerDeliveryQueue} from './src/telemetry/reviewer-delivery.ts'; import {HarnessSink} from './src/telemetry/sink.ts';
        const sink = new HarnessSink({credential:{url:process.argv[1],source:'login',token:'renewed-login'},rclVersion:'test'});
        console.log(JSON.stringify(await new ReviewerDeliveryQueue(process.argv[2]).flush(sink)));`;
      const child = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, url, f.root], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 15000,
        env: Object.fromEntries(['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
      });
      expect(child.stderr).not.toContain('SYNTHETIC_PRIVATE'); expect(JSON.parse(child.stdout)).toMatchObject({ delivered: [f.runId], remaining: [] });
      expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'))).toHaveLength(1);
      expect(remote.requests.some(row => row.url.includes('provider'))).toBe(false);
    } finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
  });

  it('serializes concurrent replay and refuses replacement API tokens through current server ownership', async () => {
    const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
    remote.loseAck(); await expect(queue.deliver({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact })).rejects.toThrow();
    const replies = await Promise.all([queue.flush(remote.sink()), new ReviewerDeliveryQueue(f.root).flush(remote.sink('renewed-login'))]);
    expect(replies.flatMap(reply => reply.delivered)).toEqual([f.runId]);
    expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'))).toHaveLength(1);
    const next = await fixture(), api = server(next), apiQueue = new ReviewerDeliveryQueue(next.root);
    await apiQueue.retain({ sink: api.sink('original-api', 'env'), envelope: next.envelope, artifacts: next.artifacts, artifact: next.artifact });
    api.refuse();
    expect((await apiQueue.flush(api.sink('different-api', 'env'))).remaining).toEqual([next.runId]);
    expect(api.requests.every(row => row.method === 'GET' && row.token === 'Bearer different-api')).toBe(true);
  });

  it('refuses unsafe private payloads and keeps a zero-deadline flush provider/network free', async () => {
    const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
    await queue.retain({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
    expect(await queue.flush(remote.sink(), { deadlineMs: 0 })).toMatchObject({ remaining: [f.runId], stopped: 'deadline' });
    expect(remote.requests).toHaveLength(0);
    const path = join(f.root, 'reviewer-outbox', f.runId, 'reviewer-artifact.json');
    await chmod(path, 0o644);
    expect((await queue.flush(remote.sink())).delivered).toEqual([]);
    await chmod(path, 0o600); await rm(path); await symlink(join(f.root, 'nonexistent'), path);
    expect((await queue.flush(remote.sink())).delivered).toEqual([]);
    expect(remote.requests).toHaveLength(0);
  });

  it('stores and reads back the exact ordinary reports before private admission', async () => {
    const f = await fixture(), remote = server(f); remote.requireReports();
    await new ReviewerDeliveryQueue(f.root).deliver({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
    const privatePut = remote.requests.findIndex(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'));
    for (const kind of ['report_json', 'report_md']) {
      const readback = remote.requests.findIndex(row => row.method === 'GET' && row.url.endsWith(`/artifacts/${kind}`));
      expect(readback).toBeGreaterThanOrEqual(0); expect(readback).toBeLessThan(privatePut);
    }
  });

});
