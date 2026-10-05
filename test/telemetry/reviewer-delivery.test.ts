import { readTextFixture } from '../support/text-fixture.js';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cp, readFile, mkdtemp, mkdir, realpath, rm, readdir, stat, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { ReviewerDeliveryQueue, type RetainedReviewerRecoveryDestination,
  type RetainedReviewerRecoveryPreview } from '../../src/telemetry/reviewer-delivery.js';
import { createReviewerRecoveryPreflight } from '../../src/telemetry/reviewer-preflight.js';
import { HarnessSink, MAX_RESPONSE_BYTES } from '../../src/telemetry/sink.js';
import { inspectReviewerArtifact, serializeReviewerArtifact } from '../../src/report/reviewer-artifact.js';
import { buildRunEnvelope, declareReviewerRecovery, type RunEnvelope } from '../../src/telemetry/envelope.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';
import { deliverRun, flushOutbox, createTelemetryRuntime } from '../../src/telemetry/deliver.js';
import { strictFallbackReviewerFixture } from '../support/strict-fallback-reviewer.js';
import { deliverTerminalReviewerRun } from '../../src/telemetry/terminal-reviewer-delivery.js';
import { NOTICE_FILE } from '../../src/telemetry/notice.js';
import { MAX_RECOVERY_CHECKPOINT_BYTES, MAX_RECOVERY_CHECKPOINT_TOTAL_BYTES, MAX_RECOVERY_DOCUMENT_BYTES,
  openJournal, serializeRecoveryDocument,
  type JournalCheckpoint, type ReadableJournal } from '../../src/evidence/original-run/journal.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
type StrictFallbackFixture = Awaited<ReturnType<typeof strictFallbackReviewerFixture>>;
const strictFallbackTemplates = new Map<'failed' | 'complete', { directory: string; fixture: StrictFallbackFixture }>();
let strictFallbackTemplateRoot: string;
let putCapacityManifestTemplate: string;
let putCapacityManifestSha256: string;
let putCapacityJournalTemplate: string;
let sevenSlotJournalTemplate: string;
let twoMissingSevenSlotJournalTemplate: string;
let outcomeExpansionBoundaryJournalTemplate: string;
beforeAll(async () => {
  strictFallbackTemplateRoot = await realpath(await mkdtemp(join(tmpdir(), 'rcl-strict-fallback-template-')));
  for (const terminal of ['failed', 'complete'] as const) {
    const directory = join(strictFallbackTemplateRoot, terminal);
    await mkdir(directory);
    strictFallbackTemplates.set(terminal, { directory,
      fixture: await strictFallbackReviewerFixture(directory, terminal) });
  }
  const retained = strictFallbackTemplates.get('failed')!.fixture;
  const reportJson = { sha256: sha256(retained.artifacts.report_json),
    bytes: Buffer.byteLength(retained.artifacts.report_json) };
  const reportMarkdown = { sha256: sha256(retained.artifacts.report_md),
    bytes: Buffer.byteLength(retained.artifacts.report_md) };
  const reviewer = { sha256: sha256(retained.artifact.bytes), bytes: Buffer.byteLength(retained.artifact.bytes) };
  putCapacityManifestTemplate = join(strictFallbackTemplateRoot, 'put-capacity-manifest.json');
  const manifestBytes = '{"kind":"reviewer-put-capacity-test"}\n';
  await writeFile(putCapacityManifestTemplate, manifestBytes, { mode: 0o600 });
  putCapacityManifestSha256 = sha256(manifestBytes);
  const capacity = await realRecoveryJournal(strictFallbackTemplateRoot, 'put-capacity-manifest.json.journal', [
    { phase: 'report_json_verified', data: reportJson },
    { phase: 'report_md_verified', data: reportMarkdown },
    { phase: 'reviewer_put_intent', data: reviewer },
    ...Array.from({ length: 100 }, (_, index) => ({
      phase: index === 0 ? 'reviewer_put_outcome' : `reviewer_put_outcome_${index + 1}`,
      data: { kind: 'unavailable', http_status: 503 },
    })),
  ], putCapacityManifestSha256);
  putCapacityJournalTemplate = capacity.directory;

  const boundaryRoot = join(strictFallbackTemplateRoot, 'seven-slot-source');
  await mkdir(boundaryRoot);
  const remote = server(retained), queue = new ReviewerDeliveryQueue(boundaryRoot);
  const declaration = declareReviewerRecovery({ artifact: retained.artifact,
    descriptor: retained.result.run.reviewer_evidence });
  const envelope = buildRunEnvelope(retained.result, retained.artifacts,
    { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
  await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
  const selection = recoverySelection({ root: boundaryRoot, ...retained }, envelope);
  const preview = await queue.previewRecovery(selection);
  const destination = { host: 'https://harness.example.test', credentialKind: 'login' as const,
    activationProtocol: 1 as const, principal: { org_id: '919921a0-0000-4000-8000-000000000001',
      actor_user_id: '919921a0-0000-4000-8000-000000000002', credential_kind: 'cli' as const,
      api_token_id: null } };
  const boundary = await exactSizeRecoveryJournal(strictFallbackTemplateRoot, 'seven-slot.journal', [
    { phase: 'prepared', data: { outbox_manifest_sha256: preview.manifest.sha256, destination } },
    { phase: 'envelope_verified', data: { sha256: preview.envelope.sha256,
      artifacts_declared: envelope.artifacts_declared } },
    { phase: 'report_md_verified', data: preview.report_md! },
    { phase: 'reviewer_verified', data: preview.reviewer },
  ], MAX_RECOVERY_CHECKPOINT_TOTAL_BYTES - 7 * MAX_RECOVERY_CHECKPOINT_BYTES);
  sevenSlotJournalTemplate = boundary.directory;
  const twoMissingBoundary = await exactSizeRecoveryJournal(strictFallbackTemplateRoot,
    'two-missing-seven-slot.journal', [
      { phase: 'prepared', data: { outbox_manifest_sha256: preview.manifest.sha256, destination } },
      { phase: 'envelope_verified', data: { sha256: preview.envelope.sha256,
        artifacts_declared: envelope.artifacts_declared } },
      { phase: 'reviewer_verified', data: preview.reviewer },
    ], MAX_RECOVERY_CHECKPOINT_TOTAL_BYTES - 7 * MAX_RECOVERY_CHECKPOINT_BYTES);
  twoMissingSevenSlotJournalTemplate = twoMissingBoundary.directory;
  const outcomeExpansionBoundary = await exactSizeRecoveryJournal(strictFallbackTemplateRoot,
    'outcome-expansion-boundary.journal', [
      { phase: 'prepared', data: { outbox_manifest_sha256: preview.manifest.sha256, destination } },
      { phase: 'envelope_verified', data: { sha256: preview.envelope.sha256,
        artifacts_declared: envelope.artifacts_declared } },
      { phase: 'reviewer_verified', data: preview.reviewer },
    ], MAX_RECOVERY_CHECKPOINT_TOTAL_BYTES -
      (7 * MAX_RECOVERY_CHECKPOINT_BYTES + 150 * 1024));
  outcomeExpansionBoundaryJournalTemplate = outcomeExpansionBoundary.directory;
});
afterAll(async () => { await rm(strictFallbackTemplateRoot, { recursive: true, force: true }); });
async function freshStrictFallbackReviewerFixture(commonDir: string, terminal: 'failed' | 'complete' = 'failed') {
  const template = strictFallbackTemplates.get(terminal);
  if (!template) throw new Error('strict_fallback_template_unavailable');
  await Promise.all((await readdir(template.directory)).map(name =>
    cp(join(template.directory, name), join(commonDir, name), { recursive: true })));
  return { ...structuredClone(template.fixture), artifact: template.fixture.artifact };
}
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
  let lostAck = false; let losePost = false; let losePostReadback = false; let failPrivatePut = false; let rejectPrivatePut = false; let hidePrivateReadback = false; let refused = false; let capability = true; let replayCapability = true; let activationForbidden = false; let requireReports = false;
  let corruptOrdinaryReadback: string | undefined; let failArtifactPut: string | undefined;
  let malformedArtifactError: string | undefined;
  const hiddenOrdinaryReadback = new Set<string>();
  let runReceipt: 'valid' | 'absent' | 'mismatch' | 'malformed' = 'valid';
  let principal = { org_id: '919921a0-0000-4000-8000-000000000001', actor_user_id: '919921a0-0000-4000-8000-000000000002', credential_kind: 'cli', api_token_id: null };
  let activationShape: 'full' | 'protocol-only' | 'principal-only' = 'full';
  const generic = new Map<string, string>();
  const fetchImpl = async (url: any, options: any): Promise<Response> => {
    const route = String(url); requests.push({ method: options.method, url: route, body: options.body, token: options.headers.authorization });
    if (route.endsWith('/model-stats')) {
      if (activationForbidden) return Response.json({ error: 'forbidden' }, { status: 403 });
      return Response.json({ data: { models: [] }, meta: capability ? { reviewer_recovery_protocol: 2,
      ...(activationShape === 'principal-only' ? {} : { reviewer_recovery_activation_protocol: 1 }),
      ...(activationShape === 'protocol-only' ? {} : { reviewer_recovery_principal: principal }),
      ...(replayCapability ? { reviewer_artifact_replay_protocol: 1 } : {}),
      reviewer_checkpoint_plan_version: 2, reviewer_capture_version: 2, reviewer_provider_concurrency_version: 1, reviewer_artifact_schema: 1, reviewer_artifact_max_bytes: 25000000 } : {} });
    }
    if (refused) return Response.json({ error: 'forbidden', message: 'SYNTHETIC_PRIVATE_DETAIL' }, { status: 403 });
    if (options.method === 'GET' && new URL(route).pathname.endsWith(`/runs/${f.runId}`)) {
      if (!posted) return Response.json({ error: 'not_found' }, { status: 404 });
      if (!postedEnvelope) return Response.json({ data: { id: f.runId }, meta: { status: 'existing' } });
      const envelope = JSON.parse(postedEnvelope);
      const body: any = { data: { id: f.runId, url: `https://harness.example.test/api/v1/reviews/runs/${f.runId}`,
        ...(runReceipt === 'absent' ? {} : { envelope_sha256: runReceipt === 'mismatch' ? '0'.repeat(64) : sha256(postedEnvelope) }),
        artifacts_declared: envelope.artifacts_declared }, meta: { status: 'existing' } };
      if (runReceipt === 'malformed') body.unexpected = true;
      return Response.json(body);
    }
    if (route.endsWith('/reviewer-artifact')) {
      if (options.method === 'PUT') { if (requireReports && (generic.get('report_json') !== f.artifacts.report_json || generic.get('report_md') !== f.artifacts.report_md)) return Response.json({ error: 'source_unavailable' }, { status: 503 }); if (failPrivatePut) { failPrivatePut = false; return Response.json({ error: 'unavailable' }, { status: 503 }); } if (rejectPrivatePut) { rejectPrivatePut = false; return Response.json({ error: 'invalid_reviewer_artifact' }, { status: 422 }); } privateBytes = options.body; if (lostAck) throw new Error('lost ACK'); return Response.json({ data: { run_id: f.runId, sha256: f.artifact.digest, bytes: Buffer.byteLength(privateBytes!) }, meta: { status: 'created' } }, { status: 201 }); }
      if (losePostReadback) { losePostReadback = false; throw new Error('lost post readback'); }
      if (privateBytes === undefined || hidePrivateReadback) return Response.json(posted ? { error: 'reviewer_artifact_pending', data: { run_id: f.runId, sha256: f.artifact.digest, bytes: Buffer.byteLength(f.artifact.bytes) } } : { error: 'not_found' }, { status: 404 });
      return new Response(privateBytes, { headers: { 'content-type': 'application/octet-stream', 'x-artifact-sha256': sha256(privateBytes), 'cache-control': 'private, no-store', 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff' } });
    }
    if (route.endsWith('/runs')) { posted = true; postedEnvelope = options.body; if (losePost) { losePost = false; losePostReadback = true; throw new Error('lost POST response'); } const envelope = JSON.parse(options.body); return Response.json({ data: { id: envelope.run.id, url: 'https://harness.example.test/run', artifacts_expected: envelope.artifacts_declared.map((row: any) => row.kind) }, meta: { status: 'existing' } }); }
    const kind = route.split('/').at(-1)!;
    if (options.method === 'PUT') {
      if (failArtifactPut === kind) { failArtifactPut = undefined; return Response.json({ error: 'unavailable' }, { status: 503 }); }
      if (malformedArtifactError === kind) { malformedArtifactError = undefined;
        return Response.json({ error: { malformed: true }, message: 'invalid' }, { status: 422 }); }
      generic.set(kind, options.body); return Response.json({ data: { kind, sha256: sha256(options.body) } }, { status: 201 });
    }
    const stored = hiddenOrdinaryReadback.has(kind) ? undefined : generic.get(kind);
    if (stored === undefined) return Response.json({ error: 'not_found' }, { status: 404 });
    const responseBytes = corruptOrdinaryReadback === kind
      ? `${stored[0] === 'x' ? 'y' : 'x'}${stored.slice(1)}`
      : stored;
    return new Response(responseBytes, { headers: { 'content-type': 'application/octet-stream', 'x-artifact-sha256': sha256(responseBytes) } });
  };
  const sink = (token = 'first-login', source: 'login' | 'env' = 'login') => new HarnessSink({ credential: { url: 'https://harness.example.test', token, source }, rclVersion: 'test', fetchImpl });
  return { requests, sink, fetchImpl, requireReports: () => { requireReports = true; }, loseAck: () => { lostAck = true; }, losePost: () => { losePost = true; }, failPrivatePutOnce: () => { failPrivatePut = true; }, rejectPrivatePutOnce: () => { rejectPrivatePut = true; }, failArtifactPutOnce: (kind: string) => { failArtifactPut = kind; }, malformedArtifactErrorOnce: (kind: string) => { malformedArtifactError = kind; }, hideArtifactReadback: (kind: string) => { hiddenOrdinaryReadback.add(kind); }, hidePrivateReadback: () => { hidePrivateReadback = true; }, refuse: () => { refused = true; }, unsupported: () => { capability = false; }, unsupportedReplay: () => { replayCapability = false; }, forbidActivation: () => { activationForbidden = true; }, posted: () => { posted = true; }, existing: (envelope: string) => { posted = true; postedEnvelope = envelope; }, storeArtifact: (kind: string, bytes: string) => { generic.set(kind, bytes); }, storePrivateArtifact: (bytes: string) => { privateBytes = bytes; }, removeArtifact: (kind: string) => { generic.delete(kind); }, receipt: (value: typeof runReceipt) => { runReceipt = value; }, corruptReadback: (kind: string) => { corruptOrdinaryReadback = kind; }, activation: (shape: typeof activationShape) => { activationShape = shape; }, changePrincipal: () => { principal = { ...principal, org_id: '919921a0-0000-4000-8000-000000000099' }; }, apiPrincipal: () => { principal = { ...principal, credential_kind: 'api_token', api_token_id: '919921a0-0000-4000-8000-000000000003' }; } };
}

async function byteSnapshot(directory: string): Promise<Record<string, string>> {
  const names = await readdir(directory);
  return Object.fromEntries(await Promise.all(names.sort().map(async name => [name, await readFile(join(directory, name), 'utf8')])));
}

async function byteTreeSnapshot(directory: string, excludedTopLevel: ReadonlySet<string>): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const walk = async (current: string, relative: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (relative === '' && excludedTopLevel.has(entry.name)) continue;
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(current, entry.name), childRelative);
      else snapshot[childRelative] = (await readFile(join(current, entry.name))).toString('base64');
    }
  };
  await walk(directory, '');
  return snapshot;
}

async function rewriteJournalPhase(directory: string, phase: string, data: unknown, duplicate = false): Promise<void> {
  const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  const rows = await Promise.all(names.map(async name => ({ name, value: JSON.parse(await readFile(join(directory, name), 'utf8')) })));
  const index = rows.findIndex(row => row.value.phase === phase);
  if (index < 0) throw new Error(`missing journal phase ${phase}`);
  if (duplicate) {
    const previousBytes = await readFile(join(directory, rows.at(-1)!.name), 'utf8');
    const value = { ...rows[index]!.value, sequence: rows.length + 1, previous_sha256: sha256(previousBytes), data };
    await writeFile(join(directory, `${String(rows.length + 1).padStart(8, '0')}.json`), JSON.stringify(value), { mode: 0o600 });
    return;
  }
  rows[index]!.value.data = data;
  for (let position = index; position < rows.length; position++) {
    if (position > index) rows[position]!.value.previous_sha256 = sha256(JSON.stringify(rows[position - 1]!.value));
    await writeFile(join(directory, rows[position]!.name), JSON.stringify(rows[position]!.value), { mode: 0o600 });
  }
}

function recoverySelection(retained: Awaited<ReturnType<typeof strictFallbackReviewerFixture>>, envelope: ReturnType<typeof buildRunEnvelope>) {
  return { target: 'rcl-159', runId: retained.runId, headSha: 'a'.repeat(40),
    reportSha256: sha256(retained.artifacts.report_json), reportByteLength: Buffer.byteLength(retained.artifacts.report_json), reportBytes: retained.artifacts.report_json,
    reviewerArtifactSha256: retained.artifact.digest, reviewerArtifactByteLength: Buffer.byteLength(retained.artifact.bytes), reviewerArtifactBytes: retained.artifact.bytes,
    reviewerRecovery: envelope.reviewer_recovery! };
}

function memoryJournal(phases: Array<{ phase: string; data: unknown }>) {
  const checkpoints = phases.map((row, index) => ({ operation_id: '919921a0-0000-4000-8000-000000000010',
    manifest_sha256: 'b'.repeat(64), sequence: index + 1, previous_sha256: 'c'.repeat(64),
    recorded_at: new Date().toISOString(), ...row }));
  return { checkpoints: () => structuredClone(checkpoints), assertAppendCapacity: () => undefined,
    assertAppendPlanCapacity: () => undefined,
    append: async (phase: string, data: unknown = null) => {
    checkpoints.push({ operation_id: '919921a0-0000-4000-8000-000000000010', manifest_sha256: 'b'.repeat(64),
      sequence: checkpoints.length + 1, previous_sha256: 'c'.repeat(64), phase, recorded_at: new Date().toISOString(), data });
  } };
}

function recoveryOperation(journal: ReadableJournal) {
  return { mode: 'apply' as const, operationId: '919921a0-0000-4000-8000-000000000010',
    recoveryManifestSha256: 'b'.repeat(64), destination: { host: 'https://harness.example.test', credentialKind: 'login' as const,
      activationProtocol: 1 as const, principal: { org_id: '919921a0-0000-4000-8000-000000000001',
        actor_user_id: '919921a0-0000-4000-8000-000000000002', credential_kind: 'cli' as const, api_token_id: null } }, journal };
}

function applyRecoveryForTest(queue: ReviewerDeliveryQueue, sink: HarnessSink, selection: unknown,
  preview: unknown, operation: ReturnType<typeof recoveryOperation>) {
  const internal = queue as unknown as { applyRecoveryOperation: (...args: unknown[]) => Promise<void> };
  return internal.applyRecoveryOperation(sink, selection, preview, async () => operation);
}

function resumeRecoveryForTest(queue: ReviewerDeliveryQueue, sink: HarnessSink, selection: unknown,
  preview: unknown, operation: ReturnType<typeof recoveryOperation>) {
  return applyRecoveryForTest(queue, sink, selection, preview, { ...operation, mode: 'resume' });
}

async function realRecoveryJournal(root: string, name: string,
  rows: Array<Pick<JournalCheckpoint, 'phase' | 'data'>>,
  manifestSha256 = 'b'.repeat(64)): Promise<{ directory: string; journal: ReadableJournal }> {
  const directory = join(root, name);
  await openJournal(directory, manifestSha256, '919921a0-0000-4000-8000-000000000010', 'apply');
  await mkdir(directory, { recursive: true });
  let previous = manifestSha256;
  const files: Array<{ path: string; bytes: string }> = [];
  for (const [index, row] of rows.entries()) {
    const record: JournalCheckpoint = {
      operation_id: '919921a0-0000-4000-8000-000000000010', manifest_sha256: manifestSha256,
      sequence: index + 1, previous_sha256: previous, phase: row.phase,
      recorded_at: new Date().toISOString(), data: row.data,
    };
    const bytes = serializeRecoveryDocument(record);
    files.push({ path: join(directory, `${String(index + 1).padStart(8, '0')}.json`), bytes });
    previous = sha256(bytes);
  }
  await Promise.all(files.map(file => writeFile(file.path, file.bytes, { mode: 0o600 })));
  return { directory, journal: await openJournal(directory, manifestSha256,
    '919921a0-0000-4000-8000-000000000010', 'resume') };
}

const retainedTerminal422FixtureSha256 = '8bf07df1c1dd01ffbf326f0fe51c4bb7b058e3c7c34ad7bc55a9d748b0156e27';
const retainedTerminal422SourceRecordSha256 = [
  '12ece3982c99fb06e680cfbe7957a364d4a017fb211e53abba0a880f29ad3694',
  'af59142d0e30fff88f82a104ee48fdf35ee05905147d6a328ee645feb5740bf6',
  '767d4aa420da5de10ca5df951a1d98d3552856c444b13861485a6f830fa43e26',
  '19cd376372490e896572706a8ec8fe39957b4d872d9c5277b7665e5ff3291732',
  'f9fc1ababa248d07916393d85b2a5a7ffb8adfc1fe67a3829ec8c5c132c96a1e',
  '06921f085fecfd8ceff85031f0d8f5e0f77db1b62f91615ac8194cf2527a94a8',
  '9758568f3ad8d54b55f486ac5891cabc754d3279bf6a60d8b67c91effdbc8a11',
  'f11b560c59446f6d013f11acd1dad1a6d65cf1613a9339d1eb9088055e376cf7',
  'c13f754dfb5d2c09f6cfae22a7aa355127f0ab5857e30a9dea5ba933cdd9dbe0',
  'a19d92aee8bc5c68c041298e23482d6b27b349885291a7c3310252db50c160d7',
  '4af43e662ccdd593b1b1a94a839a308faba1825f27f91d3b453ba14e4737cdd2',
  '12fe654cd1daeb2b82b7e4eaaf2643c785f6ac9763d2cdc6b48cb494da4143f7',
];

function replaceJournalFixtureValues(value: unknown, values: Record<string, unknown>): unknown {
  if (typeof value === 'string' && Object.hasOwn(values, value)) return values[value];
  if (Array.isArray(value)) return value.map(item => replaceJournalFixtureValues(item, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, replaceJournalFixtureValues(item, values)]));
  return value;
}

async function retainedTerminal422RecoveryJournal(root: string, preview: RetainedReviewerRecoveryPreview,
  operation: ReturnType<typeof recoveryOperation>): Promise<{ directory: string; journal: ReadableJournal }> {
  const raw = await readFile(new URL('../fixtures/rcl-186-terminal-422-journal-template.json', import.meta.url), 'utf8');
  expect(sha256(raw)).toBe(retainedTerminal422FixtureSha256);
  const fixture = JSON.parse(raw) as { source_record_sha256: string[];
    source_ref_bytes: Record<string, number>; records: unknown[] };
  expect(fixture.source_record_sha256).toEqual(retainedTerminal422SourceRecordSha256);
  expect(fixture.source_ref_bytes).toEqual({ envelope: 49139, report_json: 106768,
    report_md: 20609, reviewer: 638626 });
  const reportMarkdown = preview.report_md!;
  const values: Record<string, unknown> = {
    '{{operation_id}}': operation.operationId,
    '{{recovery_manifest_sha256}}': operation.recoveryManifestSha256,
    '{{outbox_manifest_sha256}}': preview.manifest.sha256,
    '{{destination_host}}': operation.destination.host,
    '{{destination_credential_kind}}': operation.destination.credentialKind,
    '{{principal_org_id}}': operation.destination.principal.org_id,
    '{{principal_actor_user_id}}': operation.destination.principal.actor_user_id,
    '{{envelope_sha256}}': preview.envelope.sha256,
    '{{envelope_bytes}}': preview.envelope.bytes,
    '{{report_json_sha256}}': preview.report_json.sha256,
    '{{report_json_bytes}}': preview.report_json.bytes,
    '{{report_md_sha256}}': reportMarkdown.sha256,
    '{{report_md_bytes}}': reportMarkdown.bytes,
    '{{reviewer_sha256}}': preview.reviewer.sha256,
    '{{reviewer_bytes}}': preview.reviewer.bytes,
  };
  const directory = join(root, 'reviewer-outbox', preview.runId, 'recovery.journal');
  await openJournal(directory, operation.recoveryManifestSha256, operation.operationId, 'apply');
  let previous = operation.recoveryManifestSha256;
  for (const [index, template] of fixture.records.entries()) {
    const record = replaceJournalFixtureValues(template, { ...values,
      '{{previous_sha256}}': previous }) as JournalCheckpoint;
    const bytes = serializeRecoveryDocument(record);
    await writeFile(join(directory, `${String(index + 1).padStart(8, '0')}.json`), bytes, { mode: 0o600 });
    previous = sha256(bytes);
  }
  return { directory, journal: await openJournal(directory, operation.recoveryManifestSha256,
    operation.operationId, 'resume') };
}

async function exactSizeRecoveryJournal(root: string, name: string,
  rows: Array<Pick<JournalCheckpoint, 'phase' | 'data'>>, targetBytes: number) {
  const directory = join(root, name);
  const manifestSha256 = 'b'.repeat(64), operationId = '919921a0-0000-4000-8000-000000000010';
  await openJournal(directory, manifestSha256, operationId, 'apply');
  const render = (padding: number) => {
    let previous = manifestSha256;
    const values = [{ phase: 'interrupted_checkpoints_retained', data: 'x'.repeat(padding) }, ...rows];
    return values.map((row, index) => {
      const record: JournalCheckpoint = { operation_id: operationId, manifest_sha256: manifestSha256,
        sequence: index + 1, previous_sha256: previous, phase: row.phase,
        recorded_at: '1970-01-01T00:00:00.000Z', data: row.data };
      const bytes = serializeRecoveryDocument(record);
      previous = sha256(bytes);
      return { path: join(directory, `${String(index + 1).padStart(8, '0')}.json`), bytes };
    });
  };
  const base = render(0).reduce((total, row) => total + Buffer.byteLength(row.bytes), 0);
  const files = render(targetBytes - base);
  if (files.reduce((total, row) => total + Buffer.byteLength(row.bytes), 0) !== targetBytes) {
    throw new Error('exact_recovery_journal_size_mismatch');
  }
  await Promise.all(files.map(file => writeFile(file.path, file.bytes, { mode: 0o600 })));
  return { directory, journal: await openJournal(directory, manifestSha256, operationId, 'resume') };
}

async function preparedRecoveryCase(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix))); roots.push(root);
  const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
  const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
  const declaration = declareReviewerRecovery({ artifact: retained.artifact, descriptor: retained.result.run.reviewer_evidence });
  const envelope = buildRunEnvelope(retained.result, retained.artifacts,
    { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
  await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
  const selection = recoverySelection(retained, envelope);
  const preview = (await queue.prepareRecovery(selection)).preview;
  remote.existing(JSON.stringify(envelope));
  remote.storeArtifact('report_json', retained.artifacts.report_json);
  remote.storeArtifact('report_md', retained.artifacts.report_md);
  return { retained, remote, queue, selection, preview, envelope };
}

function terminal422JournalRows(preview: RetainedReviewerRecoveryPreview, envelope: RunEnvelope,
  destination: RetainedReviewerRecoveryDestination): Array<Pick<JournalCheckpoint, 'phase' | 'data'>> {
  return [
    { phase: 'prepared', data: { outbox_manifest_sha256: preview.manifest.sha256, destination } },
    { phase: 'activation_post_intent', data: { envelope: preview.envelope } },
    { phase: 'activation_post_outcome', data: { kind: 'ok', http_status: 201 } },
    { phase: 'envelope_verified', data: { sha256: preview.envelope.sha256,
      artifacts_declared: envelope.artifacts_declared } },
    { phase: 'report_json_put_intent', data: preview.report_json },
    { phase: 'report_json_put_outcome', data: { kind: 'ok', http_status: 201 } },
    { phase: 'report_json_verified', data: preview.report_json },
    { phase: 'report_md_put_intent', data: preview.report_md },
    { phase: 'report_md_put_outcome', data: { kind: 'ok', http_status: 201 } },
    { phase: 'report_md_verified', data: preview.report_md },
    { phase: 'reviewer_put_intent', data: preview.reviewer },
    { phase: 'reviewer_put_outcome', data: { kind: 'rejected', http_status: 422,
      error: 'reviewer_artifact_http_422' } },
  ];
}

describe('private immutable reviewer delivery', () => {
  const strictDeliveryFixture = async (terminal: 'failed' | 'complete' = 'failed') => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-strict-fallback-delivery-'))); roots.push(root);
    return { root, ...await freshStrictFallbackReviewerFixture(root, terminal) };
  };

  it('delivers a branded sealed-failed strict fallback without rewriting its report', async () => {
    const strict = await strictDeliveryFixture(), remote = server(strict);
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
  });

  it.each([
    ['changed report statistics', 'failed', (result: any) => { result.stats.totalReviews++; }, false, false],
    ['unbranded artifact clone', 'failed', (_result: any) => undefined, true, false],
    ['invalid gating reason', 'failed', (result: any) => { result.findings[0].gating = { reason: 'invalid' }; }, false, true],
    ['successful CI status', 'failed', (result: any) => { result.run.ci_exit_code = 0; }, false, true],
    ['complete result without verification metadata', 'complete', (result: any) => {
      for (const finding of [...result.findings, ...(result.belowThresholdFindings ?? [])]) delete finding.gating;
      delete result.stats.verification;
    }, false, true],
  ] as const)('rejects strict fallback evidence with %s', async (_case, terminal, mutate, unbranded, rewriteReport) => {
    const retained = await strictDeliveryFixture(terminal), remote = server(retained);
    const result = structuredClone(retained.result);
    mutate(result);
    const artifacts = rewriteReport ? { ...retained.artifacts, report_json: JSON.stringify(result) } : retained.artifacts;
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: retained.root,
      env: {}, credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' },
      fetchImpl: remote.fetchImpl });
    expect(await deliverRun(runtime, { result, artifacts,
      reviewerArtifact: unbranded ? structuredClone(retained.artifact) as any : retained.artifact,
      evidenceRequired: true })).toMatchObject({ status: 'rejected', exitCode: 4 });
    expect(remote.requests).toEqual([]);
  });

  it('refuses terminal recovery without an exact retained reviewer outbox', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-terminal-reviewer-delivery-'))); roots.push(root);
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
    const remote = server(retained);
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' },
      fetchImpl: remote.fetchImpl });

    await expect(deliverTerminalReviewerRun(runtime, { preview: true, manifest: join(root, 'manifest.json'),
      commonDir: root, target: 'rcl-159', runId: retained.runId })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(remote.requests).toEqual([]);
  });

  it('refuses an unknown-run flush before activating an exact retained outbox', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-activation-'))); roots.push(root);
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
  });

  it('activates an exact retained outbox despite a lost acknowledgement without provider calls', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-activation-'))); roots.push(root);
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
    const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
    const declaration = declareReviewerRecovery({ artifact: retained.artifact,
      descriptor: retained.result.run.reviewer_evidence });
    const envelope = buildRunEnvelope(retained.result, retained.artifacts,
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });

    remote.requireReports(); remote.loseAck();
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' },
      fetchImpl: remote.fetchImpl });
    const recoveryManifest = join(root, 'activation.json');
    const prepared = await deliverTerminalReviewerRun(runtime, { preview: true, manifest: recoveryManifest,
      commonDir: root, target: 'rcl-159', runId: retained.runId });
    expect(prepared.status).toBe('prepared');
    expect(await deliverTerminalReviewerRun(runtime, { apply: true, manifest: recoveryManifest,
      manifestSha256: prepared.manifest_sha256, commonDir: root }))
      .toMatchObject({ status: 'complete', delivery_reconciliation: 'unchanged',
        accounting: 'reviewer calls, attempts, and admitted rounds unchanged; delivery-pending reconciliation is reported separately' });
    const directory = join(root, 'reviewer-outbox', retained.runId);
    expect(remote.requests.filter(row => row.method === 'POST' && row.url.endsWith('/runs')).map(row => row.body))
      .toEqual([JSON.stringify(envelope)]);
    expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'))).toHaveLength(1);
    expect(remote.requests.some(row => /provider|model\/chat|completion/.test(row.url))).toBe(false);
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

  describe('completed retained activation', () => {
    let completed: { directory: string; fixture: Awaited<ReturnType<typeof freshStrictFallbackReviewerFixture>>;
      envelope: ReturnType<typeof buildRunEnvelope>; manifestSha256: string; operationId: string };

    beforeAll(async () => {
      const directory = join(strictFallbackTemplateRoot, 'completed-activation');
      await mkdir(directory);
      const fixture = await freshStrictFallbackReviewerFixture(directory);
      const retained = { root: directory, ...fixture };
      const remote = server(retained), queue = new ReviewerDeliveryQueue(directory);
      const declaration = declareReviewerRecovery({ artifact: retained.artifact,
        descriptor: retained.result.run.reviewer_evidence });
      const envelope = buildRunEnvelope(retained.result, retained.artifacts,
        { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
      await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
      remote.requireReports(); remote.loseAck();
      const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: directory, env: {},
        credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' },
        fetchImpl: remote.fetchImpl });
      const manifest = join(directory, 'activation.json');
      const prepared = await deliverTerminalReviewerRun(runtime, { preview: true, manifest,
        commonDir: directory, target: 'rcl-159', runId: retained.runId });
      await deliverTerminalReviewerRun(runtime, { apply: true, manifest,
        manifestSha256: prepared.manifest_sha256, commonDir: directory });
      completed = { directory, fixture, envelope,
        manifestSha256: prepared.manifest_sha256, operationId: prepared.operation_id };
    });

    it('resumes without changing durable acknowledgements or repeating network writes', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-completed-reviewer-activation-'))); roots.push(root);
      await Promise.all((await readdir(completed.directory)).map(name =>
        cp(join(completed.directory, name), join(root, name), { recursive: true })));
      const retained = { root, ...structuredClone(completed.fixture), artifact: completed.fixture.artifact };
      const remote = server(retained);
      remote.existing(JSON.stringify(completed.envelope));
      remote.storeArtifact('report_json', retained.artifacts.report_json);
      remote.storeArtifact('report_md', retained.artifacts.report_md);
      remote.storePrivateArtifact(retained.artifact.bytes);
      const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
        credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' },
        fetchImpl: remote.fetchImpl });
      const directory = join(root, 'reviewer-outbox', retained.runId);
      const journalDirectory = new ReviewerDeliveryQueue(root)
        .recoveryJournalPath(retained.runId, completed.operationId);
      const journalBeforeResume = await byteSnapshot(journalDirectory);
      const recoveryAckBeforeResume = await readFile(join(directory, 'recovery-acknowledged.json'), 'utf8');
      const ordinaryAckBeforeResume = await readFile(join(directory, 'acknowledged.json'), 'utf8');

      expect(await deliverTerminalReviewerRun(runtime, { resume: true, manifest: join(root, 'activation.json'),
        manifestSha256: completed.manifestSha256, commonDir: root }))
        .toMatchObject({ status: 'complete', delivery_reconciliation: 'unchanged' });

      expect(await byteSnapshot(journalDirectory)).toEqual(journalBeforeResume);
      expect(await readFile(join(directory, 'recovery-acknowledged.json'), 'utf8')).toBe(recoveryAckBeforeResume);
      expect(await readFile(join(directory, 'acknowledged.json'), 'utf8')).toBe(ordinaryAckBeforeResume);
      expect(remote.requests.some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
      expect(remote.requests.some(row => /provider|model\/chat|completion/.test(row.url))).toBe(false);
    });
  });

  it('previews without writing and pins an explicit manifest before apply or resume', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-preview-'))); roots.push(root);
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
      manifestSha256: preview.manifest_sha256 })).rejects.toThrow('reviewer_delivery_unavailable');
    const beforeResume = remote.requests.length;
    await expect(deliverTerminalReviewerRun(runtime, { resume: true, manifest, commonDir: root,
      manifestSha256: preview.manifest_sha256 })).resolves.toMatchObject({ status: 'complete' });
    const replay = remote.requests.slice(beforeResume);
    expect(replay.some(row => row.method === 'GET' && new URL(row.url).pathname.endsWith(`/runs/${retained.runId}`))).toBe(true);
    expect(replay.some(row => row.method === 'POST' && row.url.endsWith('/runs'))).toBe(false);
    expect(remote.requests.filter(row => row.method === 'POST' && row.url.endsWith('/runs'))).toHaveLength(1);
  });

  it('journals a retriable reviewer PUT failure and one successful retry without another write after success', async () => {
    const { retained, remote, queue, selection, preview } = await preparedRecoveryCase('rcl-retained-reviewer-put-retry-');
    const journal = memoryJournal([
      { phase: 'report_json_verified', data: preview.report_json },
      { phase: 'report_md_verified', data: preview.report_md },
    ]);
    const operation = recoveryOperation(journal);
    remote.failPrivatePutOnce();

    await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, operation)).rejects.toThrow('reviewer_delivery_unavailable');
    expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'))).toHaveLength(1);

    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview, { ...operation, mode: 'resume' })).resolves.toBeUndefined();
    expect(remote.requests.filter(row => row.method === 'POST' && row.url.endsWith('/runs'))).toHaveLength(0);
    const reviewerPuts = remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'));
    expect(reviewerPuts).toHaveLength(2);
    expect(reviewerPuts.map(row => row.body)).toEqual([retained.artifact.bytes, retained.artifact.bytes]);
    const rows = journal.checkpoints();
    expect(rows.filter(row => row.phase.startsWith('reviewer_put_outcome'))
      .map(row => [row.phase, (row.data as { kind: string }).kind])).toEqual([
      ['reviewer_put_outcome', 'unavailable'],
      ['reviewer_put_outcome_2', 'ok'],
    ]);
    const directory = join(retained.root, 'reviewer-outbox', retained.runId);
    const outboxManifestBytes = await readFile(join(directory, 'manifest.json'), 'utf8');
    expect(await readFile(join(directory, 'acknowledged.json'), 'utf8')).toBe(JSON.stringify({
      version: 1, runId: retained.runId, manifestSha256: sha256(outboxManifestBytes),
    }));
    const recoveryAck = JSON.parse(await readFile(join(directory, 'recovery-acknowledged.json'), 'utf8'));
    const outcomes = rows.filter(row => row.phase === 'activation_post_outcome' || row.phase.includes('_put_outcome'))
      .map(row => ({ phase: row.phase, data: row.data }));
    expect(recoveryAck.journalOutcomesSha256).toBe(sha256(JSON.stringify(outcomes)));
    const beforeReplay = journal.checkpoints();
    const networkBoundary = remote.requests.length;
    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).resolves.toBeUndefined();
    expect(journal.checkpoints()).toEqual(beforeReplay);
    expect(remote.requests.slice(networkBoundary).some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
  });

  it('resumes two ordinary unavailable reviewer outcomes with the next bounded PUT', async () => {
    const { retained, remote, queue, selection, preview } =
      await preparedRecoveryCase('rcl-retained-ordinary-two-unavailable-');
    const real = await realRecoveryJournal(retained.root, 'two-unavailable.journal', [
      { phase: 'report_json_verified', data: preview.report_json },
      { phase: 'report_md_verified', data: preview.report_md! },
    ]);
    const operation = recoveryOperation(real.journal);
    for (let attempt = 0; attempt < 2; attempt++) {
      remote.failPrivatePutOnce();
      await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
        { ...operation, mode: 'resume' })).rejects.toThrow('reviewer_delivery_unavailable');
    }
    operation.journal = await openJournal(real.directory, operation.recoveryManifestSha256,
      operation.operationId, 'resume');

    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).resolves.toBeUndefined();

    expect(operation.journal.checkpoints().filter(row => row.phase.startsWith('reviewer_put_outcome'))
      .map(row => [row.phase, (row.data as { kind: string }).kind])).toEqual([
      ['reviewer_put_outcome', 'unavailable'], ['reviewer_put_outcome_2', 'unavailable'],
      ['reviewer_put_outcome_3', 'ok'],
    ]);
    expect(remote.requests.filter(row => row.method === 'PUT').map(row => row.body))
      .toEqual([retained.artifact.bytes, retained.artifact.bytes, retained.artifact.bytes]);
    expect(remote.requests.some(row => row.method === 'POST')).toBe(false);
    expect(operation.journal.checkpoints().some(row => row.phase === 'reviewer_put_replay_intent')).toBe(false);
  });

  it.each(['report_json', 'report_md'] as const)(
    'journals and retries an unavailable %s PUT with the exact retained bytes', async kind => {
      const { retained, remote, queue, selection, preview } = await preparedRecoveryCase(`rcl-retained-${kind}-put-retry-`);
      remote.removeArtifact(kind);
      const other = kind === 'report_json' ? 'report_md' : 'report_json';
      const journal = memoryJournal([{ phase: `${other}_verified`, data: preview[other] }]);
      const operation = recoveryOperation(journal);
      remote.failArtifactPutOnce(kind);

      await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, operation)).rejects.toThrow('reviewer_delivery_unavailable');
      await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview, { ...operation, mode: 'resume' })).resolves.toBeUndefined();

      const puts = remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith(`/artifacts/${kind}`));
      expect(puts.map(row => row.body)).toEqual([retained.artifacts[kind], retained.artifacts[kind]]);
      const rows = journal.checkpoints();
      expect(rows.filter(row => row.phase.startsWith(`${kind}_put_outcome`))
        .map(row => [row.phase, (row.data as { kind: string }).kind])).toEqual([
        [`${kind}_put_outcome`, 'unavailable'],
        [`${kind}_put_outcome_2`, 'ok'],
      ]);
    },
  );

  it('normalizes a malformed server error before retaining a terminal PUT outcome', async () => {
    const { retained, remote, queue, selection, preview } = await preparedRecoveryCase('rcl-retained-malformed-put-');
    remote.removeArtifact('report_json');
    remote.storePrivateArtifact(retained.artifact.bytes);
    remote.malformedArtifactErrorOnce('report_json');
    const journal = memoryJournal([
      { phase: 'report_md_verified', data: preview.report_md },
      { phase: 'reviewer_verified', data: preview.reviewer },
    ]);
    const operation = recoveryOperation(journal);

    await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, operation))
      .rejects.toThrow('reviewer_delivery_refused');
    expect(journal.checkpoints().find(row => row.phase === 'report_json_put_outcome')?.data)
      .toEqual({ kind: 'rejected', http_status: 422, error: 'malformed_response' });
    const beforeResume = remote.requests.length;
    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview, { ...operation, mode: 'resume' }))
      .rejects.toThrow('reviewer_delivery_refused');
    expect(remote.requests.slice(beforeResume).some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
  });

  it.each(['report_json', 'report_md'] as const)(
    'does not repeat a durable successful %s PUT while exact readback remains unavailable', async kind => {
      const { remote, queue, selection, preview } = await preparedRecoveryCase(`rcl-retained-${kind}-put-success-`);
      remote.removeArtifact(kind);
      const other = kind === 'report_json' ? 'report_md' : 'report_json';
      const journal = memoryJournal([{ phase: `${other}_verified`, data: preview[other] }]);
      const operation = recoveryOperation(journal);
      remote.hideArtifactReadback(kind);

      await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, operation)).rejects.toThrow('reviewer_delivery_ordinary_mismatch');
      const before = remote.requests.length;
      await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview, { ...operation, mode: 'resume' }))
        .rejects.toThrow('reviewer_delivery_unavailable');
      expect(remote.requests.slice(before).some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
      expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith(`/artifacts/${kind}`))).toHaveLength(1);
    },
  );

  it('accepts canonical multi-digit PUT attempt suffixes through 100', async () => {
    const { remote, queue, selection, preview } = await preparedRecoveryCase('rcl-retained-put-attempt-boundary-');
    const journal = memoryJournal([
      { phase: 'reviewer_put_intent', data: preview.reviewer },
      ...Array.from({ length: 100 }, (_, index) => ({
        phase: index === 0 ? 'reviewer_put_outcome' : `reviewer_put_outcome_${index + 1}`,
        data: { kind: 'unavailable', http_status: 503 },
      })),
    ]);
    remote.failPrivatePutOnce();
    await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, recoveryOperation(journal)))
      .rejects.toThrow('reviewer_delivery_unavailable');
    const phases = journal.checkpoints().map(row => row.phase);
    expect(phases).toContain('reviewer_put_outcome_10');
    expect(phases).toContain('reviewer_put_outcome_100');
    expect(phases).toContain('reviewer_put_outcome_101');
  });

  it.each(['report_json', 'report_md', 'reviewer'] as const)(
    'permits %s PUT outcome 101 and refuses outcome 102 before another PUT', async kind => {
      const { retained, remote, queue, selection, preview } = await preparedRecoveryCase(`rcl-retained-${kind}-put-cap-`);
      const base = `${kind}_put_outcome` as 'report_json_put_outcome' | 'report_md_put_outcome' | 'reviewer_put_outcome';
      const intent = `${kind}_put_intent`;
      const references = { report_json: preview.report_json, report_md: preview.report_md!, reviewer: preview.reviewer };
      const rows: Array<Pick<JournalCheckpoint, 'phase' | 'data'>> = [
        ...(['report_json', 'report_md', 'reviewer'] as const)
          .filter(candidate => candidate !== kind)
          .map(candidate => ({ phase: `${candidate}_verified`, data: references[candidate] })),
        { phase: intent, data: references[kind] },
        ...Array.from({ length: 100 }, (_, index) => ({
          phase: index === 0 ? base : `${base}_${index + 1}`,
          data: { kind: 'unavailable', http_status: 503 },
        })),
      ];
      const real = await realRecoveryJournal(retained.root, `${kind}-retry-cap.journal`, rows);
      const operation = recoveryOperation(real.journal);
      if (kind === 'reviewer') remote.failPrivatePutOnce();
      else {
        remote.storePrivateArtifact(retained.artifact.bytes);
        remote.removeArtifact(kind);
        remote.failArtifactPutOnce(kind);
      }

      await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, operation))
        .rejects.toThrow('reviewer_delivery_unavailable');
      const puts = remote.requests.filter(row => row.method === 'PUT' &&
        row.url.endsWith(kind === 'reviewer' ? '/reviewer-artifact' : `/artifacts/${kind}`));
      expect(puts).toHaveLength(1);
      expect(puts[0]!.body).toBe(kind === 'reviewer' ? retained.artifact.bytes : retained.artifacts[kind]);
      expect(real.journal.checkpoints().map(row => row.phase)).toContain(`${base}_101`);
      expect(real.journal.checkpoints().map(row => row.phase)).not.toContain(`${base}_102`);

      const before = await byteSnapshot(real.directory);
      remote.requests.length = 0;
      await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview, { ...operation, mode: 'resume' }))
        .rejects.toThrow('reviewer_delivery_put_retry_limit');
      expect(remote.requests.filter(row => row.method === 'POST' || row.method === 'PUT')).toEqual([]);
      expect(await byteSnapshot(real.directory)).toEqual(before);
      expect(real.journal.checkpoints().map(row => row.phase)).not.toContain(`${base}_102`);
    },
  );

  it.each(['report_json', 'report_md', 'reviewer'] as const)(
    'accepts exact remote %s bytes after 101 unavailable outcomes without another PUT', async kind => {
      const { retained, remote, queue, selection, preview } = await preparedRecoveryCase(`rcl-retained-${kind}-put-cap-readback-`);
      const base = `${kind}_put_outcome` as 'report_json_put_outcome' | 'report_md_put_outcome' | 'reviewer_put_outcome';
      const references = { report_json: preview.report_json, report_md: preview.report_md!, reviewer: preview.reviewer };
      const rows: Array<Pick<JournalCheckpoint, 'phase' | 'data'>> = [
        ...(['report_json', 'report_md', 'reviewer'] as const)
          .filter(candidate => candidate !== kind)
          .map(candidate => ({ phase: `${candidate}_verified`, data: references[candidate] })),
        { phase: `${kind}_put_intent`, data: references[kind] },
        ...Array.from({ length: 101 }, (_, index) => ({
          phase: index === 0 ? base : `${base}_${index + 1}`,
          data: { kind: 'unavailable', http_status: 503 },
        })),
      ];
      const real = await realRecoveryJournal(retained.root, `${kind}-readback-cap.journal`, rows);
      remote.storePrivateArtifact(retained.artifact.bytes);
      remote.requests.length = 0;

      await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, recoveryOperation(real.journal)))
        .resolves.toBeUndefined();
      expect(remote.requests.filter(row => row.method === 'POST' || row.method === 'PUT')).toEqual([]);
      const phases = real.journal.checkpoints().map(row => row.phase);
      expect(phases).toContain(`${kind}_verified`);
      expect(phases).toContain('complete');
      expect(phases).not.toContain(`${base}_102`);
    },
  );

  it.each([
    ['ok', { kind: 'ok', http_status: 201 }, 'reviewer_delivery_unavailable'],
    ['conflict', { kind: 'conflict' }, 'reviewer_delivery_refused'],
    ['rejected', { kind: 'rejected', http_status: 422, error: 'invalid' }, 'reviewer_delivery_refused'],
    ['disabled', { kind: 'disabled' }, 'reviewer_delivery_refused'],
  ] as const)('preserves terminal reviewer PUT outcome 101 semantics for %s', async (_kind, terminal, expected) => {
    const { remote, queue, selection, preview, retained } = await preparedRecoveryCase('rcl-retained-terminal-put-cap-');
    const rows: Array<Pick<JournalCheckpoint, 'phase' | 'data'>> = [
      { phase: 'report_json_verified', data: preview.report_json },
      { phase: 'report_md_verified', data: preview.report_md! },
      { phase: 'reviewer_put_intent', data: preview.reviewer },
      ...Array.from({ length: 100 }, (_, index) => ({
        phase: index === 0 ? 'reviewer_put_outcome' : `reviewer_put_outcome_${index + 1}`,
        data: { kind: 'unavailable', http_status: 503 },
      })),
      { phase: 'reviewer_put_outcome_101', data: terminal },
    ];
    const real = await realRecoveryJournal(retained.root, `${_kind}-terminal-cap.journal`, rows);
    remote.requests.length = 0;

    await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, recoveryOperation(real.journal)))
      .rejects.toThrow(expected);
    expect(remote.requests.filter(row => row.method === 'POST' || row.method === 'PUT')).toEqual([]);
    expect(real.journal.checkpoints().map(row => row.phase)).not.toContain('reviewer_put_outcome_102');
  });

  it('refuses a later reviewer retry ceiling before journaling an earlier exact report readback', async () => {
    const { remote, queue, selection, preview, retained } = await preparedRecoveryCase('rcl-retained-mixed-put-cap-');
    const rows: Array<Pick<JournalCheckpoint, 'phase' | 'data'>> = [
      { phase: 'report_md_verified', data: preview.report_md! },
      { phase: 'reviewer_put_intent', data: preview.reviewer },
      ...Array.from({ length: 101 }, (_, index) => ({
        phase: index === 0 ? 'reviewer_put_outcome' : `reviewer_put_outcome_${index + 1}`,
        data: { kind: 'unavailable', http_status: 503 },
      })),
    ];
    const real = await realRecoveryJournal(retained.root, 'mixed-put-cap.journal', rows);
    const before = await byteSnapshot(real.directory);
    remote.requests.length = 0;

    await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, recoveryOperation(real.journal)))
      .rejects.toThrow('reviewer_delivery_put_retry_limit');
    expect(remote.requests.filter(row => row.method === 'POST' || row.method === 'PUT')).toEqual([]);
    expect(await byteSnapshot(real.directory)).toEqual(before);
    expect(real.journal.checkpoints().map(row => row.phase)).not.toContain('report_json_verified');
  });

  it('opens each queued resume journal under the run lock before deciding whether PUT outcome 101 is available', async () => {
    const { retained, remote, queue, selection, preview } = await preparedRecoveryCase('rcl-retained-put-cap-race-');
    const manifestPath = join(retained.root, 'reviewer-put-cap-race-a.json');
    const manifestCopyPath = join(retained.root, 'reviewer-put-cap-race-b.json');
    const directory = queue.recoveryJournalPath(retained.runId, '919921a0-0000-4000-8000-000000000010');
    await Promise.all([
      cp(putCapacityManifestTemplate, manifestPath),
      cp(putCapacityManifestTemplate, manifestCopyPath),
      cp(putCapacityJournalTemplate, directory, { recursive: true }),
    ]);
    const operation = (sourceManifestPath: string) => ({ mode: 'resume' as const, manifestPath: sourceManifestPath,
      operationId: '919921a0-0000-4000-8000-000000000010', recoveryManifestSha256: putCapacityManifestSha256,
      destination: { host: 'https://harness.example.test', credentialKind: 'login' as const,
        activationProtocol: 1 as const, principal: { org_id: '919921a0-0000-4000-8000-000000000001',
          actor_user_id: '919921a0-0000-4000-8000-000000000002', credential_kind: 'cli' as const,
          api_token_id: null } } });
    remote.failPrivatePutOnce();

    const results = await Promise.allSettled([
      queue.resumeRecovery(remote.sink(), selection, preview, operation(manifestPath)),
      new ReviewerDeliveryQueue(retained.root).resumeRecovery(remote.sink(), selection, preview, operation(manifestCopyPath)),
    ]);

    expect(results.map(result => result.status === 'rejected' ? (result.reason as Error).message : 'fulfilled'))
      .toEqual(expect.arrayContaining(['reviewer_delivery_unavailable', 'reviewer_delivery_put_retry_limit']));
    expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'))).toHaveLength(1);
    const phases = (await openJournal(directory, putCapacityManifestSha256,
      '919921a0-0000-4000-8000-000000000010', 'resume')).checkpoints().map(row => row.phase);
    expect(phases).toContain('reviewer_put_outcome_101');
    expect(phases).not.toContain('reviewer_put_outcome_102');
  });

  it.each(['report_json', 'report_md', 'reviewer'] as const)(
    'refuses a %s PUT before intent or network when the real journal cannot reserve completion capacity', async kind => {
      const { retained, remote, queue, selection, preview } = await preparedRecoveryCase(`rcl-retained-${kind}-put-bytes-`);
      const references = { report_json: preview.report_json, report_md: preview.report_md!, reviewer: preview.reviewer };
      const rows: Array<Pick<JournalCheckpoint, 'phase' | 'data'>> = [
        { phase: 'interrupted_checkpoints_retained', data: 'x'.repeat(MAX_RECOVERY_DOCUMENT_BYTES - 4 * 1024) },
        ...(['report_json', 'report_md', 'reviewer'] as const)
          .filter(candidate => candidate !== kind)
          .map(candidate => ({ phase: `${candidate}_verified`, data: references[candidate] })),
      ];
      const real = await realRecoveryJournal(retained.root, `${kind}-byte-cap.journal`, rows);
      const operation = recoveryOperation(real.journal);
      const before = await byteSnapshot(real.directory);
      if (kind !== 'reviewer') {
        remote.storePrivateArtifact(retained.artifact.bytes);
        remote.removeArtifact(kind);
      }

      await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, operation))
        .rejects.toThrow('recovery_journal_checkpoint_limit');
      expect(remote.requests.filter(row => row.method === 'POST' || row.method === 'PUT')).toEqual([]);
      expect(await byteSnapshot(real.directory)).toEqual(before);
      expect(real.journal.checkpoints().map(row => row.phase)).not.toContain(`${kind}_put_intent`);
    },
  );

  it('uses an exact seven-checkpoint reservation without stranding the artifact intent', async () => {
    const { retained, remote, queue, selection, preview } = await preparedRecoveryCase('rcl-retained-seven-slot-cap-');
    const directory = join(retained.root, 'seven-slot-cap.journal');
    await cp(sevenSlotJournalTemplate, directory, { recursive: true });
    const journal = await openJournal(directory, 'b'.repeat(64),
      '919921a0-0000-4000-8000-000000000010', 'resume');
    remote.storePrivateArtifact(retained.artifact.bytes);
    remote.removeArtifact('report_json');
    remote.requests.length = 0;

    await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, recoveryOperation(journal)))
      .resolves.toBeUndefined();
    expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/artifacts/report_json')))
      .toHaveLength(1);
    const phases = journal.checkpoints().map(row => row.phase);
    expect(phases).toContain('report_json_put_intent');
    expect(phases).toContain('report_json_put_outcome');
    expect(phases).toContain('report_json_verified');
    expect(phases).toContain('complete');
  });

  it('refuses two missing artifacts against seven remaining checkpoints before any mutation or write', async () => {
    const { retained, remote, queue, selection, preview } = await preparedRecoveryCase('rcl-retained-two-put-cap-');
    const directory = join(retained.root, 'two-missing-seven-slot-cap.journal');
    await cp(twoMissingSevenSlotJournalTemplate, directory, { recursive: true });
    const journal = await openJournal(directory, 'b'.repeat(64),
      '919921a0-0000-4000-8000-000000000010', 'resume');
    remote.storePrivateArtifact(retained.artifact.bytes);
    remote.removeArtifact('report_json');
    remote.removeArtifact('report_md');
    remote.requests.length = 0;
    const before = await byteSnapshot(directory);

    await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, recoveryOperation(journal)))
      .rejects.toThrow('recovery_journal_checkpoint_limit');

    expect(remote.requests.filter(row => row.method === 'POST' || row.method === 'PUT')).toEqual([]);
    expect(await byteSnapshot(directory)).toEqual(before);
    expect(journal.checkpoints().some(row => row.phase.endsWith('_put_intent'))).toBe(false);
  });

  it('reserves worst-case UTF-8 outcome expansion before a later PUT boundary', async () => {
    const { retained, remote, queue, selection, preview } = await preparedRecoveryCase('rcl-retained-outcome-bound-');
    const directory = join(retained.root, 'outcome-expansion-boundary-cap.journal');
    await cp(outcomeExpansionBoundaryJournalTemplate, directory, { recursive: true });
    const journal = await openJournal(directory, 'b'.repeat(64),
      '919921a0-0000-4000-8000-000000000010', 'resume');
    remote.storePrivateArtifact(retained.artifact.bytes);
    remote.removeArtifact('report_json');
    remote.removeArtifact('report_md');
    remote.requests.length = 0;
    const before = await byteSnapshot(directory);

    await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, recoveryOperation(journal)))
      .rejects.toThrow('recovery_journal_checkpoint_limit');

    expect(remote.requests.filter(row => row.method === 'POST' || row.method === 'PUT')).toEqual([]);
    expect(await byteSnapshot(directory)).toEqual(before);
  });

  it('does not repeat a reviewer PUT after its durable success outcome while readback remains pending', async () => {
    const { remote, queue, selection, preview } = await preparedRecoveryCase('rcl-retained-reviewer-put-success-');
    const journal = memoryJournal([
      { phase: 'report_json_verified', data: preview.report_json },
      { phase: 'report_md_verified', data: preview.report_md },
    ]);
    const operation = recoveryOperation(journal);
    remote.hidePrivateReadback();

    await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, operation)).rejects.toThrow('reviewer_delivery_unavailable');
    expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'))).toHaveLength(1);
    const beforeResume = remote.requests.length;

    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview, { ...operation, mode: 'resume' }))
      .rejects.toThrow('reviewer_delivery_unavailable');
    expect(remote.requests.slice(beforeResume).some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
    expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'))).toHaveLength(1);
  });

  it('retries a reviewer PUT from an intent-only crash frontier', async () => {
    const { retained, remote, queue, selection, preview } = await preparedRecoveryCase('rcl-retained-reviewer-intent-only-');
    const journal = memoryJournal([
      { phase: 'report_json_verified', data: preview.report_json },
      { phase: 'report_md_verified', data: preview.report_md },
      { phase: 'reviewer_put_intent', data: preview.reviewer },
    ]);
    await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, recoveryOperation(journal))).resolves.toBeUndefined();
    expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'))
      .map(row => row.body)).toEqual([retained.artifact.bytes]);
  });

  it('resumes the hash-locked retained A3 terminal 422 with one byte-identical replay', async () => {
    const { retained, remote, queue, selection, preview, envelope } =
      await preparedRecoveryCase('rcl-retained-reviewer-terminal-422-replay-');
    const operation = recoveryOperation(memoryJournal([]));
    const initialRows = terminal422JournalRows(preview, envelope, operation.destination);
    const real = await retainedTerminal422RecoveryJournal(retained.root, preview, operation);
    const originalJournalBytes = await byteSnapshot(real.directory);
    const nativeStateBefore = await byteTreeSnapshot(retained.root, new Set(['reviewer-outbox']));
    operation.journal = real.journal;

    expect(real.journal.checkpoints().map(({ phase, data }) => ({ phase, data }))).toEqual(initialRows);

    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).resolves.toBeUndefined();

    expect(real.journal.checkpoints().slice(0, 12).map(({ phase, data }) => ({ phase, data }))).toEqual(initialRows);
    const completedJournalBytes = await byteSnapshot(real.directory);
    expect(Object.fromEntries(Object.entries(completedJournalBytes).slice(0, 12))).toEqual(originalJournalBytes);
    expect(real.journal.checkpoints().slice(12).map(row => row.phase)).toEqual([
      'reviewer_put_replay_intent', 'reviewer_put_outcome_2', 'reviewer_verified',
      'recovery_acknowledged', 'complete',
    ]);
    const replay = remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'));
    expect(replay.map(row => row.body)).toEqual([retained.artifact.bytes]);
    expect(remote.requests.some(row => row.method === 'POST' || row.method === 'PUT' &&
      !row.url.endsWith('/reviewer-artifact'))).toBe(false);
    expect(await byteTreeSnapshot(retained.root, new Set(['reviewer-outbox']))).toEqual(nativeStateBefore);
  });

  it('completes the validator-fixed terminal 422 from exact private readback without replaying any PUT', async () => {
    const { retained, remote, queue, selection, preview, envelope } =
      await preparedRecoveryCase('rcl-retained-reviewer-terminal-422-readback-');
    const operation = recoveryOperation(memoryJournal([]));
    const initialRows = terminal422JournalRows(preview, envelope, operation.destination);
    operation.journal = memoryJournal(initialRows);
    remote.storePrivateArtifact(retained.artifact.bytes);
    remote.requests.length = 0;

    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).resolves.toBeUndefined();

    expect(remote.requests.some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
    expect(operation.journal.checkpoints().slice(12).map(row => row.phase)).toEqual([
      'reviewer_verified', 'recovery_acknowledged', 'complete',
    ]);
  });

  it('requires the authenticated replay capability before terminal-422 readback or journal mutation', async () => {
    const { remote, queue, selection, preview, envelope } =
      await preparedRecoveryCase('rcl-retained-reviewer-terminal-422-capability-');
    const operation = recoveryOperation(memoryJournal([]));
    const initialRows = terminal422JournalRows(preview, envelope, operation.destination);
    operation.journal = memoryJournal(initialRows);
    remote.unsupportedReplay();
    remote.requests.length = 0;

    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).rejects.toThrow('reviewer_delivery_refused');

    expect(operation.journal.checkpoints().map(({ phase, data }) => ({ phase, data }))).toEqual(initialRows);
    expect(remote.requests).toHaveLength(1);
    expect(remote.requests[0]).toMatchObject({ method: 'GET', url: expect.stringMatching(/model-stats$/) });
  });

  it.each(['recovery-acknowledged.json', 'acknowledged.json'] as const)(
    'refuses a terminal-422 base with an existing %s before network or journal mutation', async acknowledgement => {
      const { retained, remote, queue, selection, preview, envelope } =
        await preparedRecoveryCase(`rcl-retained-reviewer-terminal-422-${acknowledgement}-`);
      const operation = recoveryOperation(memoryJournal([]));
      const initialRows = terminal422JournalRows(preview, envelope, operation.destination);
      operation.journal = memoryJournal(initialRows);
      const bytes = acknowledgement === 'acknowledged.json'
        ? JSON.stringify({ version: 1, runId: retained.runId, manifestSha256: preview.manifest.sha256 })
        : '{"existing":true}';
      await writeFile(join(retained.root, 'reviewer-outbox', retained.runId, acknowledgement), bytes, { mode: 0o600 });
      remote.requests.length = 0;

      await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
        { ...operation, mode: 'resume' })).rejects.toThrow('reviewer_delivery_immutable_conflict');

      expect(remote.requests).toEqual([]);
      expect(operation.journal.checkpoints().map(({ phase, data }) => ({ phase, data }))).toEqual(initialRows);
      expect(await readFile(join(retained.root, 'reviewer-outbox', retained.runId, acknowledgement), 'utf8')).toBe(bytes);
    },
  );

  it('continues after an exact recovery ACK was published before its journal checkpoint', async () => {
    const { retained, remote, queue, selection, preview, envelope } =
      await preparedRecoveryCase('rcl-retained-reviewer-terminal-422-ack-frontier-');
    const destination = recoveryOperation(memoryJournal([])).destination;
    const journal = memoryJournal(terminal422JournalRows(preview, envelope, destination));
    const append = journal.append;
    let interruptAcknowledgement = true;
    journal.append = async (phase: string, data: unknown = null) => {
      if (phase === 'recovery_acknowledged' && interruptAcknowledgement) {
        interruptAcknowledgement = false;
        throw new Error('synthetic_recovery_ack_checkpoint_interruption');
      }
      await append(phase, data);
    };
    const operation = recoveryOperation(journal);
    remote.storePrivateArtifact(retained.artifact.bytes);
    remote.requests.length = 0;

    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).rejects.toThrow('synthetic_recovery_ack_checkpoint_interruption');

    const recoveryAckPath = join(retained.root, 'reviewer-outbox', retained.runId, 'recovery-acknowledged.json');
    const recoveryAck = await readFile(recoveryAckPath, 'utf8');
    expect(operation.journal.checkpoints().slice(12).map(row => row.phase)).toEqual(['reviewer_verified']);
    await expect(readFile(join(retained.root, 'reviewer-outbox', retained.runId, 'acknowledged.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const beforeResume = remote.requests.length;
    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).resolves.toBeUndefined();

    expect(await readFile(recoveryAckPath, 'utf8')).toBe(recoveryAck);
    expect(operation.journal.checkpoints().slice(12).map(row => row.phase)).toEqual([
      'reviewer_verified', 'recovery_acknowledged', 'complete',
    ]);
    expect(remote.requests.slice(beforeResume).some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
  });

  it('never sends a reviewer PUT after the terminal-422 replay intent survives a crash', async () => {
    const { remote, queue, selection, preview, envelope } =
      await preparedRecoveryCase('rcl-retained-reviewer-terminal-422-intent-');
    const operation = recoveryOperation(memoryJournal([]));
    const initialRows = [
      ...terminal422JournalRows(preview, envelope, operation.destination),
      { phase: 'reviewer_put_replay_intent', data: preview.reviewer },
    ];
    operation.journal = memoryJournal(initialRows);
    remote.requests.length = 0;

    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).rejects.toThrow('reviewer_delivery_unavailable');

    expect(remote.requests.some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
    expect(operation.journal.checkpoints().map(({ phase, data }) => ({ phase, data }))).toEqual(initialRows);
  });

  it('finishes from exact readback after a replay-intent/PUT crash without inventing a second outcome', async () => {
    const { retained, remote, queue, selection, preview, envelope } =
      await preparedRecoveryCase('rcl-retained-reviewer-terminal-422-put-crash-');
    const operation = recoveryOperation(memoryJournal([]));
    const initialRows = [
      ...terminal422JournalRows(preview, envelope, operation.destination),
      { phase: 'reviewer_put_replay_intent', data: preview.reviewer },
    ];
    operation.journal = memoryJournal(initialRows);
    remote.storePrivateArtifact(retained.artifact.bytes);
    remote.requests.length = 0;

    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).resolves.toBeUndefined();

    expect(remote.requests.some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
    expect(operation.journal.checkpoints().slice(13).map(row => row.phase)).toEqual([
      'reviewer_verified', 'recovery_acknowledged', 'complete',
    ]);
  });

  it.each(['recovery_acknowledged', 'complete'] as const)(
    'resumes the readback-only replay crash before %s without inventing an outcome', async boundary => {
      const { retained, remote, queue, selection, preview, envelope } =
        await preparedRecoveryCase('rcl-retained-replay-readback-checkpoint-crash-');
      const operation = recoveryOperation(memoryJournal([]));
      const initialRows = [
        ...terminal422JournalRows(preview, envelope, operation.destination),
        { phase: 'reviewer_put_replay_intent', data: preview.reviewer },
      ];
      const real = await realRecoveryJournal(retained.root, 'readback-crash.journal', initialRows);
      operation.journal = real.journal;
      const append = real.journal.append.bind(real.journal);
      let interrupt = true;
      real.journal.append = async (phase, data) => {
        if (phase === boundary && interrupt) {
          interrupt = false;
          throw new Error('synthetic_replay_readback_checkpoint_interruption');
        }
        await append(phase, data);
      };
      remote.storePrivateArtifact(retained.artifact.bytes);
      remote.requests.length = 0;

      await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
        { ...operation, mode: 'resume' })).rejects.toThrow('synthetic_replay_readback_checkpoint_interruption');
      operation.journal = await openJournal(real.directory, operation.recoveryManifestSha256,
        operation.operationId, 'resume');
      await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
        { ...operation, mode: 'resume' })).resolves.toBeUndefined();
      const completed = await byteSnapshot(real.directory);
      await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
        { ...operation, mode: 'resume' })).resolves.toBeUndefined();

      expect(await byteSnapshot(real.directory)).toEqual(completed);
      expect(remote.requests.some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
      expect(operation.journal.checkpoints().slice(12).map(row => row.phase)).toEqual([
        'reviewer_put_replay_intent', 'reviewer_verified', 'recovery_acknowledged', 'complete',
      ]);
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])(
    'resumes an ordinary interrupted journal at prefix length %i without requiring replay capability', async length => {
      const { retained, remote, queue, selection, preview, envelope } =
        await preparedRecoveryCase('rcl-retained-ordinary-interrupted-prefix-');
      const operation = recoveryOperation(memoryJournal([]));
      const prefix = terminal422JournalRows(preview, envelope, operation.destination).slice(0, length);
      const real = await realRecoveryJournal(retained.root, 'ordinary-prefix.journal', prefix);
      operation.journal = real.journal;
      const before = await byteSnapshot(real.directory);
      remote.unsupportedReplay();
      remote.requests.length = 0;

      await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
        { ...operation, mode: 'resume' })).resolves.toBeUndefined();

      const after = await byteSnapshot(real.directory);
      for (const [path, bytes] of Object.entries(before)) expect(after[path]).toEqual(bytes);
      expect(operation.journal.checkpoints().slice(0, length).map(({ phase, data }) => ({ phase, data })))
        .toEqual(prefix);
      expect(operation.journal.checkpoints().at(-1)?.phase).toBe('complete');
      expect(operation.journal.checkpoints().some(row => row.phase === 'reviewer_put_replay_intent')).toBe(false);
      expect(remote.requests.filter(row => row.method === 'PUT').map(row => row.body))
        .toEqual([retained.artifact.bytes]);
      expect(remote.requests.some(row => row.method === 'POST')).toBe(false);
    },
  );

  it('reads back and completes a lost replay response without another reviewer PUT', async () => {
    const { retained, remote, queue, selection, preview, envelope } =
      await preparedRecoveryCase('rcl-retained-reviewer-terminal-422-lost-response-');
    const operation = recoveryOperation(memoryJournal([]));
    operation.journal = memoryJournal(terminal422JournalRows(preview, envelope, operation.destination));
    remote.loseAck();
    remote.requests.length = 0;

    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).resolves.toBeUndefined();

    expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'))
      .map(row => row.body)).toEqual([retained.artifact.bytes]);
    expect(operation.journal.checkpoints().slice(12).map(row => [row.phase,
      (row.data as { kind?: string }).kind])).toEqual([
      ['reviewer_put_replay_intent', undefined],
      ['reviewer_put_outcome_2', 'unavailable'],
      ['reviewer_verified', undefined],
      ['recovery_acknowledged', undefined],
      ['complete', undefined],
    ]);
  });

  it('makes a second unavailable replay outcome terminal and readback-only', async () => {
    const { remote, queue, selection, preview, envelope } =
      await preparedRecoveryCase('rcl-retained-reviewer-terminal-422-second-unavailable-');
    const operation = recoveryOperation(memoryJournal([]));
    operation.journal = memoryJournal(terminal422JournalRows(preview, envelope, operation.destination));
    remote.failPrivatePutOnce();
    remote.requests.length = 0;

    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).rejects.toThrow('reviewer_delivery_unavailable');
    const before = remote.requests.length;
    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).rejects.toThrow('reviewer_delivery_unavailable');

    expect(remote.requests.slice(before).some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
    expect(operation.journal.checkpoints().filter(row => row.phase.startsWith('reviewer_put_outcome')))
      .toHaveLength(2);
  });

  it('records a second terminal rejection after the sole replay and never acknowledges or retries it', async () => {
    const { remote, queue, selection, preview, envelope } =
      await preparedRecoveryCase('rcl-retained-reviewer-terminal-422-second-rejection-');
    const operation = recoveryOperation(memoryJournal([]));
    const initialRows = terminal422JournalRows(preview, envelope, operation.destination);
    operation.journal = memoryJournal(initialRows);
    remote.rejectPrivatePutOnce();
    remote.requests.length = 0;

    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).rejects.toThrow('reviewer_delivery_refused');

    expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact')))
      .toHaveLength(1);
    expect(operation.journal.checkpoints().slice(12).map(row => [row.phase, row.data])).toEqual([
      ['reviewer_put_replay_intent', preview.reviewer],
      ['reviewer_put_outcome_2', { kind: 'rejected', http_status: 422,
        error: 'reviewer_artifact_http_422' }],
    ]);
    const before = remote.requests.length;
    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).rejects.toThrow('reviewer_delivery_refused');
    expect(remote.requests.slice(before).some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
    expect(operation.journal.checkpoints().some(row =>
      row.phase === 'recovery_acknowledged' || row.phase === 'complete')).toBe(false);
  });

  it.each([
    { kind: 'rejected', http_status: 422, error: 'reviewer_artifact_http_422' },
    { kind: 'conflict' },
    { kind: 'disabled' },
  ])('keeps replay outcome_2 $kind terminal even after exact private readback', async terminal => {
    const { retained, remote, queue, selection, preview, envelope } =
      await preparedRecoveryCase('rcl-retained-reviewer-terminal-422-outcome-readback-');
    const operation = recoveryOperation(memoryJournal([]));
    const initialRows = [
      ...terminal422JournalRows(preview, envelope, operation.destination),
      { phase: 'reviewer_put_replay_intent', data: preview.reviewer },
      { phase: 'reviewer_put_outcome_2', data: terminal },
    ];
    operation.journal = memoryJournal(initialRows);
    remote.storePrivateArtifact(retained.artifact.bytes);
    remote.requests.length = 0;

    await expect(resumeRecoveryForTest(queue, remote.sink(), selection, preview,
      { ...operation, mode: 'resume' })).rejects.toThrow('reviewer_delivery_refused');

    expect(remote.requests).toEqual([]);
    expect(operation.journal.checkpoints().map(({ phase, data }) => ({ phase, data }))).toEqual(initialRows);
    await expect(readFile(join(retained.root, 'reviewer-outbox', retained.runId,
      'recovery-acknowledged.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(retained.root, 'reviewer-outbox', retained.runId,
      'acknowledged.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['truncated', 'undefined-suffix', 'complete-only', 'apply'] as const)(
    'refuses the %s terminal-422 journal shape before any network or journal mutation', async shape => {
      const { remote, queue, selection, preview, envelope } =
        await preparedRecoveryCase(`rcl-retained-reviewer-terminal-422-${shape}-`);
      const operation = recoveryOperation(memoryJournal([]));
      const prefix = terminal422JournalRows(preview, envelope, operation.destination);
      const initialRows = shape === 'truncated' ? prefix.filter(row => row.phase !== 'report_md_verified') : shape === 'undefined-suffix'
        ? [...prefix, { phase: 'recovery_acknowledged', data: { unexpected: true } }]
        : shape === 'complete-only' ? [...prefix, { phase: 'complete', data: { unexpected: true } }]
        : prefix;
      operation.journal = memoryJournal(initialRows);
      remote.requests.length = 0;

      const execution = shape === 'apply'
        ? applyRecoveryForTest(queue, remote.sink(), selection, preview, operation)
        : resumeRecoveryForTest(queue, remote.sink(), selection, preview, { ...operation, mode: 'resume' });
      await expect(execution).rejects.toThrow(shape === 'apply'
        ? 'reviewer_delivery_refused' : 'reviewer_delivery_journal_checkpoint_conflict');

      expect(remote.requests).toEqual([]);
      expect(operation.journal.checkpoints().map(({ phase, data }) => ({ phase, data }))).toEqual(initialRows);
    },
  );

  it.each([
    { kind: 'conflict' },
    { kind: 'disabled' },
    { kind: 'rejected', http_status: 422, error: 'invalid' },
  ])('never retries a durable terminal reviewer PUT outcome $kind', async terminal => {
    const { remote, queue, selection, preview } = await preparedRecoveryCase('rcl-retained-reviewer-terminal-put-');
    const journal = memoryJournal([
      { phase: 'report_json_verified', data: preview.report_json },
      { phase: 'report_md_verified', data: preview.report_md },
      { phase: 'reviewer_put_intent', data: preview.reviewer },
      { phase: 'reviewer_put_outcome', data: terminal },
    ]);
    const before = remote.requests.length;

    await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, recoveryOperation(journal)))
      .rejects.toThrow('reviewer_delivery_refused');
    expect(remote.requests.slice(before).some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
  });

  it('rejects a reviewer PUT outcome without its durable intent before transport', async () => {
    const { remote, queue, selection, preview } = await preparedRecoveryCase('rcl-retained-reviewer-missing-put-intent-');
    const journal = memoryJournal([{ phase: 'reviewer_put_outcome', data: { kind: 'unavailable', http_status: 503 } }]);
    const before = remote.requests.length;

    await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, recoveryOperation(journal)))
      .rejects.toThrow('reviewer_delivery_journal_checkpoint_conflict');
    expect(remote.requests.slice(before)).toEqual([]);
  });

  it.each(['reviewer_put_outcome_3', 'reviewer_put_outcome_02', 'reviewer_put_outcome_9007199254740992'])(
    'rejects gapped or noncanonical PUT outcome phase %s before transport', async badPhase => {
      const { remote, queue, selection, preview } = await preparedRecoveryCase('rcl-retained-reviewer-invalid-put-phase-');
      const journal = memoryJournal([
        { phase: 'reviewer_put_intent', data: preview.reviewer },
        { phase: 'reviewer_put_outcome', data: { kind: 'unavailable', http_status: 503 } },
        { phase: badPhase, data: { kind: 'unavailable', http_status: 503 } },
      ]);
      const before = remote.requests.length;

      await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, recoveryOperation(journal)))
        .rejects.toThrow('reviewer_delivery_journal_checkpoint_conflict');
      expect(remote.requests.slice(before)).toEqual([]);
    },
  );

  it.each([
    ['terminal', [
      { phase: 'reviewer_put_intent', data: null },
      { phase: 'reviewer_put_outcome', data: { kind: 'ok', http_status: 201 } },
      { phase: 'reviewer_put_outcome_2', data: { kind: 'unavailable', http_status: 503 } },
    ]],
    ['verified', [
      { phase: 'reviewer_put_intent', data: null },
      { phase: 'reviewer_put_outcome', data: { kind: 'unavailable', http_status: 503 } },
      { phase: 'reviewer_verified', data: null },
      { phase: 'reviewer_put_outcome_2', data: { kind: 'unavailable', http_status: 503 } },
    ]],
  ] as const)('rejects a PUT outcome after %s before transport', async (_case, rows) => {
    const { remote, queue, selection, preview } = await preparedRecoveryCase('rcl-retained-reviewer-closed-put-history-');
    const journal = memoryJournal(rows.map(row => ({ ...row,
      data: row.phase === 'reviewer_put_intent' || row.phase === 'reviewer_verified' ? preview.reviewer : row.data })));
    const before = remote.requests.length;

    await expect(applyRecoveryForTest(queue, remote.sink(), selection, preview, recoveryOperation(journal)))
      .rejects.toThrow('reviewer_delivery_journal_checkpoint_conflict');
    expect(remote.requests.slice(before)).toEqual([]);
  });

  it('resumes the safe pre-POST frontier when the immutable entry intent exists without a journal post-intent', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-safe-frontier-'))); roots.push(root);
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
    const outboxManifest = JSON.parse(await readFile(join(root, 'reviewer-outbox', retained.runId, 'manifest.json'), 'utf8'));
    const intent = JSON.stringify({ version: 1, runId: retained.runId, operationId: preview.operation_id,
      recoveryManifestSha256: preview.manifest_sha256, envelopeSha256: outboxManifest.envelope.sha256 });
    await writeFile(join(root, 'reviewer-outbox', retained.runId, 'activation-intent.json'), intent, { mode: 0o600 });

    await expect(deliverTerminalReviewerRun(runtime, { apply: true, manifest, commonDir: root,
      manifestSha256: preview.manifest_sha256 })).resolves.toMatchObject({ status: 'complete' });
    expect(remote.requests.filter(row => row.method === 'POST' && row.url.endsWith('/runs'))).toHaveLength(1);
  });

  it.each([false, true])('rejects %s duplicate or conflicting journal phase data without changing journal or remote bytes', async duplicate => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-journal-conflict-'))); roots.push(root);
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
    await deliverTerminalReviewerRun(runtime, { apply: true, manifest, commonDir: root,
      manifestSha256: preview.manifest_sha256 });
    const journal = queue.recoveryJournalPath(retained.runId, preview.operation_id);
    await rewriteJournalPhase(journal, 'prepared', { changed: true }, duplicate);
    const before = await byteSnapshot(journal), requestCount = remote.requests.length;

    await expect(deliverTerminalReviewerRun(runtime, { resume: true, manifest, commonDir: root,
      manifestSha256: preview.manifest_sha256 })).rejects.toThrow('reviewer_delivery_journal_checkpoint_conflict');
    expect(await byteSnapshot(journal)).toEqual(before);
    expect(remote.requests.slice(requestCount).some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
  });

  it.each(['recovery-acknowledged.json', 'acknowledged.json'])(
    'refuses a conflicting immutable %s without replacing bytes, writing HTTP, or extending the journal', async acknowledgement => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-ack-conflict-'))); roots.push(root);
      const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
      await deliverTerminalReviewerRun(runtime, { apply: true, manifest, commonDir: root,
        manifestSha256: preview.manifest_sha256 });
      const journal = queue.recoveryJournalPath(retained.runId, preview.operation_id);
      const directory = join(root, 'reviewer-outbox', retained.runId);
      const conflict = '{"conflict":true}';
      await writeFile(join(directory, acknowledgement), conflict, { mode: 0o600 });
      const journalBefore = await byteSnapshot(journal), requestCount = remote.requests.length;

      await expect(deliverTerminalReviewerRun(runtime, { resume: true, manifest, commonDir: root,
        manifestSha256: preview.manifest_sha256 })).rejects.toThrow('reviewer_delivery_immutable_conflict');
      expect(await readFile(join(directory, acknowledgement), 'utf8')).toBe(conflict);
      expect(await byteSnapshot(journal)).toEqual(journalBefore);
      expect(remote.requests.slice(requestCount).some(row => row.method === 'POST' || row.method === 'PUT')).toBe(false);
    },
  );

  it.each(['recovery-acknowledged.json', 'acknowledged.json'])(
    'refuses a pre-existing %s before notice, journal creation, HTTP, or reconciliation', async acknowledgement => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-preapply-ack-conflict-'))); roots.push(root);
      const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
      const directory = join(root, 'reviewer-outbox', retained.runId), conflict = '{"conflict":true}';
      await writeFile(join(directory, acknowledgement), conflict, { mode: 0o600 });
      await rm(join(root, NOTICE_FILE), { force: true });
      runtime.stderr = vi.fn();
      const before = await byteSnapshot(directory), requestCount = remote.requests.length;

      await expect(deliverTerminalReviewerRun(runtime, { apply: true, manifest, commonDir: root,
        manifestSha256: preview.manifest_sha256 })).rejects.toThrow('reviewer_delivery_immutable_conflict');

      expect(await byteSnapshot(directory)).toEqual(before);
      expect(remote.requests.slice(requestCount)).toEqual([]);
      expect(runtime.stderr).not.toHaveBeenCalled();
      await expect(stat(queue.recoveryJournalPath(retained.runId, preview.operation_id)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['activation_post_outcome', 'report_json_put_outcome', 'report_md_put_outcome', 'reviewer_put_outcome'])(
    'rejects valid hash-chained tampering of %s before notice, transport, or reconciliation', async phase => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-outcome-conflict-'))); roots.push(root);
      const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
      const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
      const declaration = declareReviewerRecovery({ artifact: retained.artifact, descriptor: retained.result.run.reviewer_evidence });
      const envelope = buildRunEnvelope(retained.result, retained.artifacts,
        { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
      await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
      remote.requireReports();
      const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
        credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl });
      const manifest = join(root, 'activation.json');
      const preview = await deliverTerminalReviewerRun(runtime, { preview: true, manifest, commonDir: root,
        target: 'rcl-159', runId: retained.runId });
      await deliverTerminalReviewerRun(runtime, { apply: true, manifest, commonDir: root,
        manifestSha256: preview.manifest_sha256 });
      const journal = queue.recoveryJournalPath(retained.runId, preview.operation_id);
      await rewriteJournalPhase(journal, phase, { kind: 'ok', http_status: 299 });
      await rm(join(root, NOTICE_FILE), { force: true });
      runtime.stderr = vi.fn();
      const before = await byteSnapshot(journal), requestCount = remote.requests.length;

      await expect(deliverTerminalReviewerRun(runtime, { resume: true, manifest, commonDir: root,
        manifestSha256: preview.manifest_sha256 })).rejects.toThrow('reviewer_delivery_journal_checkpoint_conflict');

      expect(await byteSnapshot(journal)).toEqual(before);
      expect(remote.requests.slice(requestCount)).toEqual([]);
      expect(runtime.stderr).not.toHaveBeenCalled();
    },
  );

  it.each(['principal', 'capability-403'] as const)('refuses a changed %s before any local or HTTP write', async scenario => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-principal-'))); roots.push(root);
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
    const directory = join(root, 'reviewer-outbox', retained.runId);
    const before = await byteSnapshot(directory), requestCount = remote.requests.length;
    if (scenario === 'principal') remote.changePrincipal();
    else remote.forbidActivation();
    await expect(deliverTerminalReviewerRun(runtime, { apply: true, manifest, commonDir: root,
      manifestSha256: preview.manifest_sha256 }))
      .rejects.toThrow(scenario === 'principal' ? 'reviewer_delivery_principal_mismatch' : 'reviewer_delivery_activation_unsupported');
    expect(remote.requests.slice(requestCount).every(row => row.method === 'GET')).toBe(true);
    expect(await byteSnapshot(directory)).toEqual(before);
    await expect(stat(queue.recoveryJournalPath(retained.runId, preview.operation_id)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires the atomic activation protocol and exact CLI or API-token principal tuple', async () => {
    for (const shape of ['protocol-only', 'principal-only'] as const) {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-capability-'))); roots.push(root);
      const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
      const remote = server(retained); remote.activation(shape);
      await expect(remote.sink().checkReviewerRecoveryActivation()).resolves.toMatchObject({
        kind: 'rejected', error: 'unsupported_reviewer_recovery_activation',
      });
      expect(remote.requests.every(row => row.method === 'GET')).toBe(true);
    }
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-api-principal-'))); roots.push(root);
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) }, remote = server(retained);
    remote.apiPrincipal();
    await expect(remote.sink('api-token', 'env').checkReviewerRecoveryActivation()).resolves.toMatchObject({
      kind: 'ok', value: { protocol: 1, principal: { credential_kind: 'api_token',
        api_token_id: '919921a0-0000-4000-8000-000000000003' } },
    });
  });

  it('uses self-authenticated retained envelope and historical Markdown bytes across renderer drift', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-renderer-drift-'))); roots.push(root);
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
    const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
    const historicalArtifacts = { ...retained.artifacts, report_md: '# Historical renderer bytes\n' };
    const declaration = declareReviewerRecovery({ artifact: retained.artifact, descriptor: retained.result.run.reviewer_evidence });
    const historicalEnvelope = buildRunEnvelope(retained.result, historicalArtifacts,
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    await queue.retain({ sink: remote.sink(), envelope: historicalEnvelope,
      artifacts: historicalArtifacts, artifact: retained.artifact });
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl });
    const manifest = join(root, 'activation.json');

    const preview = await deliverTerminalReviewerRun(runtime, { preview: true, manifest, commonDir: root,
      target: 'rcl-159', runId: retained.runId });
    await expect(deliverTerminalReviewerRun(runtime, { apply: true, manifest, commonDir: root,
      manifestSha256: preview.manifest_sha256 })).resolves.toMatchObject({ status: 'complete' });
    expect(remote.requests.find(row => row.method === 'POST' && row.url.endsWith('/runs'))?.body)
      .toBe(JSON.stringify(historicalEnvelope));
    expect(remote.requests.find(row => row.method === 'PUT' && row.url.endsWith('/artifacts/report_md'))?.body)
      .toBe(historicalArtifacts.report_md);
  });

  it('recovers a valid retained entry without Markdown and marks it not declared', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-no-markdown-'))); roots.push(root);
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
    const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
    const artifacts = { report_json: retained.artifacts.report_json };
    const declaration = declareReviewerRecovery({ artifact: retained.artifact, descriptor: retained.result.run.reviewer_evidence });
    const envelope = buildRunEnvelope(retained.result, artifacts,
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    await queue.retain({ sink: remote.sink(), envelope, artifacts, artifact: retained.artifact });
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl });
    const manifest = join(root, 'activation.json');

    const preview = await deliverTerminalReviewerRun(runtime, { preview: true, manifest, commonDir: root,
      target: 'rcl-159', runId: retained.runId });
    expect(preview).toMatchObject({ status: 'prepared', observation: { report_md: 'not_declared' } });
    await expect(deliverTerminalReviewerRun(runtime, { apply: true, manifest, commonDir: root,
      manifestSha256: preview.manifest_sha256 })).resolves.toMatchObject({ status: 'complete' });
    expect(remote.requests.some(row => row.url.endsWith('/artifacts/report_md'))).toBe(false);
  });

  it('pins the retained manifest at preview and refuses self-consistent envelope or Markdown tampering at apply', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-full-lineage-'))); roots.push(root);
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
    const remote = server(retained), queue = new ReviewerDeliveryQueue(root);
    const declaration = declareReviewerRecovery({ artifact: retained.artifact, descriptor: retained.result.run.reviewer_evidence });
    const envelope = buildRunEnvelope(retained.result, retained.artifacts,
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    await queue.retain({ sink: remote.sink(), envelope, artifacts: retained.artifacts, artifact: retained.artifact });
    const directory = join(root, 'reviewer-outbox', retained.runId);
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl });
    const activationManifest = join(root, 'activation.json');
    const preview = await deliverTerminalReviewerRun(runtime, { preview: true, manifest: activationManifest,
      commonDir: root, target: 'rcl-159', runId: retained.runId });
    const alteredMarkdown = `${retained.artifacts.report_md}\naltered`;
    const alteredEnvelope = buildRunEnvelope(retained.result, { ...retained.artifacts, report_md: alteredMarkdown },
      { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    manifest.envelope = { sha256: sha256(JSON.stringify(alteredEnvelope)), bytes: Buffer.byteLength(JSON.stringify(alteredEnvelope)) };
    manifest.report_md = { sha256: sha256(alteredMarkdown), bytes: Buffer.byteLength(alteredMarkdown) };
    await writeFile(join(directory, 'envelope.json'), JSON.stringify(alteredEnvelope), { mode: 0o600 });
    await writeFile(join(directory, 'report.md'), alteredMarkdown, { mode: 0o600 });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });

    const requestCount = remote.requests.length;
    await expect(deliverTerminalReviewerRun(runtime, { apply: true, manifest: activationManifest, commonDir: root,
      manifestSha256: preview.manifest_sha256 })).rejects.toThrow('reviewer_delivery_lineage_or_outbox_changed');
    expect(remote.requests.slice(requestCount)).toEqual([]);
    expect(remote.requests.some(row => row.method !== 'GET')).toBe(false);
    expect(await readFile(activationManifest, 'utf8')).toBeTruthy();
    await expect(stat(join(directory, 'activation-intent.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(queue.recoveryJournalPath(retained.runId, preview.operation_id)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires exact ordinary JSON and Markdown readback before a recovery acknowledgement', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-reviewer-readback-'))); roots.push(root);
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
      const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
        manifestSha256: preview.manifest_sha256 })).rejects.toThrow('reviewer_delivery_envelope_receipt_mismatch');

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
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
    const retained = { root, ...await freshStrictFallbackReviewerFixture(root) };
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
      { ...selection, reviewerRecovery: { ...selection.reviewerRecovery, sha256: 'e'.repeat(64) } },
      { ...selection, reviewerRecovery: { ...selection.reviewerRecovery, bytes: selection.reviewerRecovery.bytes + 1 } },
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

  it('fences generic flush and retry delivery before private notice, network, or acknowledgement once activation starts', async () => {
    const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
    await queue.retain({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
    const directory = join(f.root, 'reviewer-outbox', f.runId);
    await writeFile(join(directory, 'activation-intent.json'), '{"activation":true}', { mode: 0o600 });
    const notice = vi.fn(async () => {});

    expect(await queue.flush(remote.sink(), {}, notice)).toMatchObject({
      delivered: [], remaining: [f.runId],
      failed: [{ id: f.runId, reason: 'reviewer_delivery_explicit_activation_required' }],
    });
    expect(notice).not.toHaveBeenCalled();
    expect(remote.requests).toEqual([]);
    await expect(stat(join(directory, 'acknowledged.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(queue.deliver({ sink: remote.sink(), envelope: f.envelope,
      artifacts: f.artifacts, artifact: f.artifact })).rejects.toThrow('reviewer_delivery_explicit_activation_required');
    expect(remote.requests).toEqual([]);

    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: f.root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl });
    expect(await deliverRun(runtime, { result: f.result, artifacts: f.artifacts,
      reviewerArtifact: f.artifact, evidenceRequired: true })).toMatchObject({ status: 'spooled', exitCode: 4 });
    await expect(stat(join(f.root, NOTICE_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(remote.requests).toEqual([]);
  });

  it('fences a selected ordinary outbox flush before notice or transport when retained activation has started', async () => {
    const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
    await queue.retain({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
    const directory = join(f.root, 'reviewer-outbox', f.runId);
    await writeFile(join(directory, 'activation-intent.json'), '{"activation":true}', { mode: 0o600 });
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: f.root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl,
      stderr: vi.fn() });
    await runtime.outbox.spoolRun({ runId: f.runId, envelope: f.envelope, artifacts: f.artifacts });
    const ordinaryBefore = await runtime.outbox.list();

    await expect(flushOutbox(runtime, { runId: f.runId })).rejects.toThrow('reviewer_delivery_explicit_activation_required');

    expect(runtime.stderr).not.toHaveBeenCalled();
    expect(remote.requests).toEqual([]);
    expect(await runtime.outbox.list()).toEqual(ordinaryBefore);
    expect(await readFile(join(directory, 'activation-intent.json'), 'utf8')).toBe('{"activation":true}');
    await expect(stat(join(directory, 'acknowledged.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains an armed run and collapses its exact duplicate refusal during a bare batch flush', async () => {
    const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
    await queue.retain({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
    const directory = join(f.root, 'reviewer-outbox', f.runId);
    await writeFile(join(directory, 'activation-intent.json'), '{"activation":true}', { mode: 0o600 });
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: f.root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl,
      stderr: vi.fn() });
    await runtime.outbox.spoolRun({ runId: f.runId, envelope: f.envelope, artifacts: f.artifacts });
    const ordinaryBefore = await runtime.outbox.list();

    const summary = await flushOutbox(runtime);
    expect(summary).toMatchObject({
      delivered: [], remaining: [f.runId],
      failed: [{ id: f.runId, reason: 'reviewer_delivery_explicit_activation_required' }],
    });
    expect(summary.failed).toEqual([{ id: f.runId, reason: 'reviewer_delivery_explicit_activation_required' }]);

    expect(runtime.stderr).not.toHaveBeenCalled();
    expect(remote.requests).toEqual([]);
    expect(await runtime.outbox.list()).toEqual(ordinaryBefore);
    expect(await readFile(join(directory, 'activation-intent.json'), 'utf8')).toBe('{"activation":true}');
    await expect(stat(join(directory, 'acknowledged.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves different failure reasons for the same run while deduping only exact pairs', async () => {
    const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
    await queue.retain({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: f.root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl,
      stderr: vi.fn() });
    await runtime.outbox.spoolRun({ runId: f.runId, envelope: f.envelope, artifacts: f.artifacts });
    const ordinaryReason = 'ordinary synthetic conflict';
    await writeFile(join(f.root, 'outbox', f.runId, 'failed.json'),
      JSON.stringify({ at: new Date().toISOString(), reason: ordinaryReason }));
    remote.refuse();

    const summary = await flushOutbox(runtime);

    expect(summary.failed).toEqual([
      { id: f.runId, reason: ordinaryReason },
      { id: f.runId, reason: 'reviewer_delivery_refused' },
    ]);
    expect(summary.remaining).toEqual([f.runId]);
  });

  it('continues unrelated ordinary entries while retaining an armed run during a bare batch flush', async () => {
    const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
    await queue.retain({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
    const directory = join(f.root, 'reviewer-outbox', f.runId);
    await writeFile(join(directory, 'activation-intent.json'), '{"activation":true}', { mode: 0o600 });
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: f.root, env: {},
      credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: remote.fetchImpl,
      stderr: vi.fn() });
    await runtime.outbox.spoolRun({ runId: f.runId, envelope: f.envelope, artifacts: f.artifacts });
    const unrelatedId = '00000000-0000-4000-8000-000000000200';
    const unrelatedResult = structuredClone(f.result);
    unrelatedResult.run.id = unrelatedId;
    const unrelatedArtifacts = { ...f.artifacts, report_json: JSON.stringify(unrelatedResult) };
    const unrelatedEnvelope = buildRunEnvelope(unrelatedResult, unrelatedArtifacts,
      { level: 'full', delivery: { mode: 'direct' } });
    await runtime.outbox.spoolRun({ runId: unrelatedId, envelope: unrelatedEnvelope, artifacts: unrelatedArtifacts });

    await expect(flushOutbox(runtime)).resolves.toMatchObject({
      delivered: [unrelatedId], remaining: [f.runId],
      failed: [{ id: f.runId, reason: 'reviewer_delivery_explicit_activation_required' }],
    });

    const postedRuns = remote.requests.filter(row => row.method === 'POST' && row.url.endsWith('/runs'))
      .map(row => JSON.parse(row.body!).run.id);
    expect(postedRuns).toEqual([unrelatedId]);
    expect(await runtime.outbox.list()).toEqual([expect.objectContaining({ id: f.runId })]);
    expect(await readFile(join(directory, 'activation-intent.json'), 'utf8')).toBe('{"activation":true}');
    await expect(stat(join(directory, 'acknowledged.json'))).rejects.toMatchObject({ code: 'ENOENT' });
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
