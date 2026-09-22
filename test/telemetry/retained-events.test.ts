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
