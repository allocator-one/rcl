import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { describeClaim } from '../../src/consensus/claim-identity.js';
import { processRoundReport } from '../../src/converge/run-state.js';
import { buildEvent, roundIdentities, type WireEvent } from '../../src/telemetry/events.js';
import { Outbox } from '../../src/telemetry/outbox.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { fakeFetch, sampleFinding, sampleResult, sampleRunHeader } from './fixtures.js';

let dir: string;
let event: WireEvent;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rcl-retained-events-'));
  const target = 'synthetic-retained-event';
  const run = sampleRunHeader({ converge: { target, round: 1 } });
  const finding = sampleFinding({ identity: `report:${run.id}:0000000000000001` });
  finding.claimDescriptor = describeClaim(finding);
  const report = sampleResult({ run, findings: [finding], belowThresholdFindings: [] });
  const processed = await processRoundReport({ gitCommonDir: join(dir, 'synthetic-git-common'),
    target, round: 1, runId: run.id, findings: report.findings, evidence: { reportJson: JSON.stringify(report) } });
  event = buildEvent({ kind: 'round_processed', runId: run.id, convergeTarget: target, round: 1,
    payload: { identities: roundIdentities(processed.findings) }, now: new Date('2026-09-22T00:00:00Z') });
});

afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function corruptPayload(variant: 'null' | 'omitted'): WireEvent {
  const retained = JSON.parse(JSON.stringify(event));
  if (variant === 'null') retained.payload = null;
  else delete retained.payload;
  return retained as WireEvent;
}

function transport() {
  const fake = fakeFetch(request => request.method === 'GET'
    ? { status: 200, body: { data: [], meta: { evidence_protocol_version: 2 } } }
    : { status: 201, body: { data: { inserted: 1, duplicates: 0 } } });
  return { ...fake, sink: new HarnessSink({ credential: { url: 'https://synthetic.invalid',
    token: 'synthetic-inert-token', source: 'login' }, rclVersion: '3.8.0', fetchImpl: fake.fetch }) };
}

function retainedIdentity(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(event.payload.identities))[0];
}

function withIdentity(identity: Record<string, unknown>): WireEvent {
  return { ...event, payload: { identities: [identity] } };
}

it.each(['finding_ref', 'report_json_sha256', 'claim_descriptor', 'match_rationale', 'pending_round'] as const)(
  'refuses an unversioned retained identity carrying only the %s binding field before HTTP', async field => {
    const full = retainedIdentity();
    const malformed = withIdentity({ identity_key: full.identity_key, matched_identity: full.matched_identity,
      status: full.status, [field]: full[field] });
    const original = JSON.stringify(malformed);
    const { sink, requests } = transport();
    expect(await sink.postEvents([malformed])).toMatchObject({
      kind: 'rejected', httpStatus: 0, error: 'invalid_sighting_binding',
    });
    expect(requests).toEqual([]);
    expect(JSON.stringify(malformed)).toBe(original);
  });

it.each(['version', 'finding_ref', 'report_json_sha256', 'claim_descriptor', 'match_rationale'] as const)(
  'refuses a producer-shaped retained identity missing %s before HTTP', async field => {
    const identity = retainedIdentity();
    delete identity[field];
    const malformed = withIdentity(identity);
    const original = JSON.stringify(malformed);
    const { sink, requests } = transport();
    expect(await sink.postEvents([malformed])).toMatchObject({
      kind: 'rejected', httpStatus: 0, error: 'invalid_sighting_binding',
    });
    expect(requests).toEqual([]);
    expect(JSON.stringify(malformed)).toBe(original);
  });

it.each([
  ['version', null], ['version', 2], ['version', '1'], ['finding_ref', ''],
  ['report_json_sha256', 'A'.repeat(64)], ['report_json_sha256', 'a'.repeat(64) + '\n'],
  ['claim_descriptor', null], ['claim_descriptor', { version: 1, operation: 'cache', invariant: 'expiry', evidence: [] }],
  ['match_rationale', 'guessed'], ['pending_round', -1],
] as const)('refuses a malformed retained %s binding value without rewriting it', async (field, value) => {
  const malformed = withIdentity({ ...retainedIdentity(), [field]: value });
  const original = JSON.stringify(malformed);
  const { sink, requests } = transport();
  expect(await sink.postEvents([malformed])).toMatchObject({
    kind: 'rejected', httpStatus: 0, error: 'invalid_sighting_binding',
  });
  expect(requests).toEqual([]);
  expect(JSON.stringify(malformed)).toBe(original);
});

it('keeps complete old version 1 and key-only legacy identities deliverable byte-for-byte', async () => {
  const identity = retainedIdentity();
  delete identity.pending_round;
  const legacy = { identity_key: identity.identity_key, matched_identity: identity.matched_identity, status: identity.status };
  for (const [entry, methods] of [[identity, ['GET', 'POST']], [legacy, ['POST']]] as const) {
    const retained = { ...event, payload: { identities: [entry], report_json_sha256: 'opaque legacy outer metadata' } };
    const original = JSON.stringify({ events: [retained] });
    const { sink, requests } = transport();
    expect(await sink.postEvents([retained])).toMatchObject({ kind: 'ok' });
    expect(requests.map(request => request.method)).toEqual(methods);
    expect(requests.at(-1)!.body).toBe(original);
  }
});

it('retains an omitted-version binding entry and delivers a separate valid outbox entry', async () => {
  const outbox = new Outbox(join(dir, 'outbox'));
  const badId = await outbox.spoolEvents([event]);
  const independent = { ...event, id: buildEvent({ kind: 'round_processed', now: new Date('2026-09-22T00:00:01Z') }).id };
  const goodId = await outbox.spoolEvents([independent]);
  expect(badId < goodId).toBe(true);
  const identity = retainedIdentity();
  delete identity.version;
  const malformedBytes = JSON.stringify([withIdentity(identity)], null, 2) + '\n';
  const retainedPath = join(outbox.dir, badId, 'events.json');
  await writeFile(retainedPath, malformedBytes);
  const { sink, requests } = transport();
  expect(await outbox.flush(sink)).toMatchObject({ delivered: [goodId], remaining: [],
    failed: [{ id: badId, reason: expect.stringContaining('invalid_sighting_binding') }] });
  expect(await readFile(retainedPath, 'utf8')).toBe(malformedBytes);
  expect(requests.map(request => request.method)).toEqual(['GET', 'POST']);
  expect(requests[1]!.body).toBe(JSON.stringify({ events: [independent] }));
  expect((await outbox.list()).map(entry => entry.id)).toEqual([badId]);
  await outbox.flush(sink);
  expect(requests).toHaveLength(2);
  expect(await readFile(retainedPath, 'utf8')).toBe(malformedBytes);
});

it.each(['null', 'omitted'] as const)('refuses a retained %s payload without HTTP or mutation', async variant => {
  const malformed = corruptPayload(variant);
  const original = JSON.stringify(malformed);
  const { sink, requests } = transport();
  await expect(sink.postEvents([malformed])).resolves.toMatchObject({
    kind: 'rejected', httpStatus: 0, error: 'invalid_event_payload',
  });
  expect(requests).toEqual([]);
  expect(JSON.stringify(malformed)).toBe(original);
});

it.each(['null', 'omitted'] as const)('preserves a retained %s payload and flushes the next valid entry', async variant => {
  const outbox = new Outbox(join(dir, 'outbox'));
  const badId = await outbox.spoolEvents([event]);
  const independent = buildEvent({ kind: 'round_processed', runId: event.run_id,
    convergeTarget: event.converge_target, round: event.round, payload: event.payload,
    now: new Date('2026-09-22T00:00:01Z') });
  const goodId = await outbox.spoolEvents([independent]);
  expect(badId < goodId).toBe(true);
  const retainedPath = join(outbox.dir, badId, 'events.json');
  const malformedBytes = JSON.stringify([corruptPayload(variant)], null, 2) + '\n';
  await writeFile(retainedPath, malformedBytes);
  const { sink, requests } = transport();
  const summary = await outbox.flush(sink);
  expect(summary).toMatchObject({ delivered: [goodId], remaining: [], dropped: [],
    failed: [{ id: badId, reason: expect.stringContaining('invalid_event_payload') }] });
  expect(summary.stopped).toBeUndefined();
  expect(await readFile(retainedPath, 'utf8')).toBe(malformedBytes);
  expect(requests.map(request => request.method)).toEqual(['GET', 'POST']);
  expect(JSON.parse(requests[1]!.body!)).toEqual({ events: [independent] });
  const remaining = await outbox.list();
  expect(remaining).toHaveLength(1);
  expect(remaining[0]).toMatchObject({ id: badId, failed: { reason: expect.stringContaining('invalid_event_payload') } });
  // A later flush reports the retained failure without resending either entry.
  expect((await outbox.flush(sink)).failed).toEqual(summary.failed);
  expect(requests).toHaveLength(2);
  expect(await readFile(retainedPath, 'utf8')).toBe(malformedBytes);
});
