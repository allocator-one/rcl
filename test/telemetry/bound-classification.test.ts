import { expect, it } from 'vitest';
import { buildEvent } from '../../src/telemetry/events.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { describeClaim } from '../../src/consensus/claim-identity.js';
import { fakeFetch, sampleFinding, sampleResult, sampleRunHeader } from './fixtures.js';

const marker = { classification_version: 1, report_json_sha256: 'a'.repeat(64) };
const runId = sampleRunHeader().id;
const classified = (payload: Record<string, unknown>) => buildEvent({ kind: 'round_processed',
  runId, convergeTarget: 'synthetic-bound-classification', round: 2,
  payload: { identities: [], ...payload } });

const semanticIdentity = {
  identity_key: `report:${runId}:original`, matched_identity: '0000000000000001', status: 'repeat',
  version: 1, finding_ref: 'f001', report_json_sha256: marker.report_json_sha256,
  claim_descriptor: describeClaim(sampleFinding()), match_rationale: 'exact_descriptor',
};
const supportedTransport = () => fakeFetch(request => request.method === 'GET'
  ? { status: 200, body: { data: [], meta: { evidence_protocol_version: 2, bound_classification_protocol: 1 } } }
  : { status: 201, body: { data: { inserted: 1, duplicates: 0 } } });

it.each([undefined, 0, -1, 1.5, '1', false, {}, [], 3, Number.MAX_SAFE_INTEGER + 1])(
  'refuses missing or malformed marked pending_round before HTTP: %j', async pending => {
    const identity = { ...semanticIdentity, ...(pending === undefined ? {} : { pending_round: pending }) };
    const event = classified({ ...marker, identities: [identity] });
    const before = JSON.stringify(event);
    const fake = supportedTransport();
    const sink = new HarnessSink({ credential: { url: 'https://synthetic.invalid', token: 'synthetic-token', source: 'login' },
      rclVersion: '3.8.0', fetchImpl: fake.fetch });
    expect(await sink.postEvents([event])).toMatchObject({ kind: 'rejected', httpStatus: 0, error: 'invalid_bound_classification' });
    expect(fake.requests).toEqual([]);
    expect(JSON.stringify(event)).toBe(before);
  });

it.each([undefined, null, {}, [null], [[]]])('refuses a malformed marked identities collection: %j', async identities => {
  const event = classified({ ...marker, identities });
  const fake = supportedTransport();
  const sink = new HarnessSink({ credential: { url: 'https://synthetic.invalid', token: 'synthetic-token', source: 'login' },
    rclVersion: '3.8.0', fetchImpl: fake.fetch });
  expect(await sink.postEvents([event])).toMatchObject({ kind: 'rejected', httpStatus: 0, error: 'invalid_bound_classification' });
  expect(fake.requests).toEqual([]);
});

it.each([null, 1, 2])('preserves marked pending_round %j without changing the event', async pending_round => {
  const event = classified({ ...marker, identities: [{ ...semanticIdentity, pending_round }] });
  const fake = supportedTransport();
  const sink = new HarnessSink({ credential: { url: 'https://synthetic.invalid', token: 'synthetic-token', source: 'login' },
    rclVersion: '3.8.0', fetchImpl: fake.fetch });
  expect(await sink.postEvents([event])).toMatchObject({ kind: 'ok' });
  expect(fake.requests.map(request => request.method)).toEqual(['GET', 'POST']);
  expect(fake.requests[1]!.body).toBe(JSON.stringify({ events: [event] }));
});

it('keeps an old unmarked version 1 identity deliverable without pending_round', async () => {
  const event = classified({ identities: [semanticIdentity] });
  const fake = fakeFetch(request => request.method === 'GET'
    ? { status: 200, body: { data: [], meta: { evidence_protocol_version: 2 } } }
    : { status: 201, body: { data: { inserted: 1, duplicates: 0 } } });
  const sink = new HarnessSink({ credential: { url: 'https://synthetic.invalid', token: 'synthetic-token', source: 'login' },
    rclVersion: '3.8.0', fetchImpl: fake.fetch });
  expect(await sink.postEvents([event])).toMatchObject({ kind: 'ok' });
  expect(fake.requests[1]!.body).toBe(JSON.stringify({ events: [event] }));
});

it('preserves digest-only legacy metadata without opting into bound classification', async () => {
  const event = classified({ report_json_sha256: 'opaque legacy audit metadata' });
  const fake = supportedTransport();
  const sink = new HarnessSink({ credential: { url: 'https://synthetic.invalid', token: 'synthetic-token', source: 'login' },
    rclVersion: '3.8.0', fetchImpl: fake.fetch });
  expect(await sink.postEvents([event])).toMatchObject({ kind: 'ok' });
  expect(fake.requests.map(request => request.method)).toEqual(['POST']);
  expect(fake.requests[0]!.body).toBe(JSON.stringify({ events: [event] }));
});

it.each([
  { classification_version: 1 },
  { ...marker, classification_version: null },
  { ...marker, classification_version: '1' },
  { ...marker, classification_version: 2 },
  { ...marker, report_json_sha256: null },
  { ...marker, report_json_sha256: 'A'.repeat(64) },
  { ...marker, report_json_sha256: 'a'.repeat(63) },
  { ...marker, report_json_sha256: 'z'.repeat(64) },
  { ...marker, report_json_sha256: 'a'.repeat(64) + '\n' },
  { legacy_pending_identities: ['0000000000000001'] },
  { ...marker, legacy_pending_identities: null },
  { ...marker, legacy_pending_identities: '0000000000000001' },
  { ...marker, legacy_pending_identities: [] },
  { ...marker, legacy_pending_identities: [''] },
  { ...marker, legacy_pending_identities: [' '] },
  { ...marker, legacy_pending_identities: ['0000000000000002', '0000000000000001'] },
  { ...marker, legacy_pending_identities: ['0000000000000001', '0000000000000001'] },
  { ...marker, legacy_pending_identities: ['abc'] },
  { ...marker, legacy_pending_identities: ['A'.repeat(16)] },
  { ...marker, legacy_pending_identities: ['a'.repeat(16) + '\n'] },
])('refuses malformed or partial bound classification before HTTP: %j', async payload => {
  // Retained JSON does not pass through the fresh producer's text scrubbing.
  const event = { ...classified({}), payload: { identities: [], ...payload } };
  const before = JSON.stringify(event);
  const fake = fakeFetch(() => ({ status: 201, body: { data: { inserted: 1, duplicates: 0 } } }));
  const sink = new HarnessSink({ credential: { url: 'https://synthetic.invalid', token: 'synthetic-token', source: 'login' },
    rclVersion: '3.8.0', fetchImpl: fake.fetch });
  await expect(sink.postEvents([event])).resolves.toMatchObject({
    kind: 'rejected', httpStatus: 0, error: 'invalid_bound_classification',
  });
  expect(fake.requests).toEqual([]);
  expect(JSON.stringify(event)).toBe(before);
});

it('refuses more than 2000 legacy pending identities without truncating or posting', async () => {
  const pending = Array.from({ length: 2001 }, (_, index) => index.toString(16).padStart(16, '0'));
  const event = classified({ ...marker, legacy_pending_identities: pending });
  const fake = fakeFetch(() => ({ status: 200, body: { data: [],
    meta: { evidence_protocol_version: 2, bound_classification_protocol: 1 } } }));
  const sink = new HarnessSink({ credential: { url: 'https://synthetic.invalid', token: 'synthetic-token', source: 'login' },
    rclVersion: '3.8.0', fetchImpl: fake.fetch });
  expect(await sink.postEvents([event])).toMatchObject({ kind: 'rejected', error: 'invalid_bound_classification' });
  expect(fake.requests).toEqual([]);
  expect(event.payload.legacy_pending_identities).toEqual(pending);
});

it.each(['login', 'attest'] as const)('checks the declared empty envelope capability using %s', async source => {
  const report = sampleResult({ findings: [], belowThresholdFindings: [] });
  const envelope = buildRunEnvelope(report, { report_json: JSON.stringify(report) }, { level: 'full', delivery: { mode: 'direct' } });
  Object.assign(envelope.run.gating, { bound_classification_protocol: 1 });
  for (const supported of [false, true]) {
    const before = JSON.stringify(envelope);
    const fake = fakeFetch(request => request.method === 'GET'
      ? { status: 200, body: { data: source === 'attest' ? { models: [] } : [],
        meta: { evidence_protocol_version: 2, ...(supported ? { bound_classification_protocol: 1 } : {}) } } }
      : { status: 201, body: { data: { id: report.run!.id, url: 'https://synthetic.invalid/run', artifacts_expected: [] } } });
    const sink = new HarnessSink({ credential: { url: 'https://synthetic.invalid', token: 'synthetic-token', source },
      rclVersion: '3.8.0', fetchImpl: fake.fetch });
    expect(await sink.postRun(envelope)).toMatchObject(supported
      ? { kind: 'ok' } : { kind: 'rejected', error: 'unsupported_bound_classification_protocol' });
    expect(fake.requests.map(request => request.method)).toEqual(supported ? ['GET', 'POST'] : ['GET']);
    expect(new URL(fake.requests[0]!.url).pathname).toBe(source === 'attest'
      ? '/api/v1/reviews/model-stats' : '/api/v1/reviews/runs');
    if (supported) expect(fake.requests[1]!.body).toBe(before);
    expect(JSON.stringify(envelope)).toBe(before);
  }
});

it.each([null, '1', 2])('refuses an unsupported envelope declaration %j before HTTP', async version => {
  const report = sampleResult({ findings: [], belowThresholdFindings: [] });
  const envelope = buildRunEnvelope(report, { report_json: JSON.stringify(report) },
    { level: 'full', delivery: { mode: 'direct' } });
  Object.assign(envelope.run.gating, { bound_classification_protocol: version });
  const fake = fakeFetch(() => ({ status: 200 }));
  const sink = new HarnessSink({ credential: { url: 'https://synthetic.invalid', token: 'synthetic-token', source: 'login' },
    rclVersion: '3.8.0', fetchImpl: fake.fetch });
  expect(await sink.postRun(envelope)).toMatchObject({ kind: 'rejected', error: 'invalid_bound_classification' });
  expect(fake.requests).toEqual([]);
});

it.each(['login', 'attest'] as const)('requires both capabilities for empty classifications using %s', async source => {
  const event = classified(marker);
  for (const meta of [
    { evidence_protocol_version: 2 },
    { evidence_protocol_version: 2, bound_classification_protocol: '1' },
    { evidence_protocol_version: 2, bound_classification_protocol: 2 },
    { bound_classification_protocol: 1 },
  ]) {
    const fake = fakeFetch(request => request.method === 'GET'
      ? { status: 200, body: { data: source === 'attest' ? { models: [] } : [], meta } }
      : { status: 201, body: { data: { inserted: 1, duplicates: 0 } } });
    const sink = new HarnessSink({ credential: { url: 'https://synthetic.invalid', token: 'synthetic-token', source },
      rclVersion: '3.8.0', fetchImpl: fake.fetch });
    expect(await sink.postEvents([event])).toMatchObject({ kind: 'rejected', error: 'unsupported_bound_classification_protocol' });
    expect(fake.requests.map(request => request.method)).toEqual(['GET']);
    expect(new URL(fake.requests[0]!.url).pathname).toBe(source === 'attest'
      ? '/api/v1/reviews/model-stats' : '/api/v1/reviews/runs');
  }
});

it.each(['login', 'attest'] as const)('preserves a supported bound event and its idempotent retry using %s', async source => {
  const event = classified({ ...marker, legacy_pending_identities: ['0000000000000001', '0000000000000002'],
    additional_audit_field: 'retained' });
  let posts = 0;
  const fake = fakeFetch(request => request.method === 'GET'
    ? { status: 200, body: { data: source === 'attest' ? { models: [] } : [],
      meta: { evidence_protocol_version: 2, bound_classification_protocol: 1 } } }
    : { status: 201, body: { data: posts++ === 0 ? { inserted: 1, duplicates: 0 } : { inserted: 0, duplicates: 1 } } });
  const sink = new HarnessSink({ credential: { url: 'https://synthetic.invalid', token: 'synthetic-token', source },
    rclVersion: '3.8.0', fetchImpl: fake.fetch });
  expect(await sink.postEvents([event])).toMatchObject({ kind: 'ok', value: { inserted: 1, duplicates: 0 } });
  expect(await sink.postEvents([event])).toMatchObject({ kind: 'ok', value: { inserted: 0, duplicates: 1 } });
  expect(fake.requests.map(request => request.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
  for (const request of fake.requests.filter(request => request.method === 'POST')) {
    expect(request.body).toBe(JSON.stringify({ events: [event] }));
    expect(request.url).toBe('https://synthetic.invalid/api/v1/reviews/converge/events');
  }
});
