import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { sampleResult } from './fixtures.js';

it.each(['duplicate digest', 'error alongside receipt', 'inexact number'] as const)(
  'refuses %s as proof of an accepted attested envelope', async fault => {
    const original = buildRunEnvelope(sampleResult(), { report_json: '{"r":1}' }, { level: 'full', delivery: { mode: 'direct' } });
    const serialized = JSON.stringify(original);
    const digest = createHash('sha256').update(serialized).digest('hex');
    const data = JSON.stringify({
      id: original.run.id, url: `https://harness.example.test/api/v1/reviews/runs/${original.run.id}`,
      envelope_sha256: digest, artifacts_declared: original.artifacts_declared,
    });
    const valid = `{"data":${data},"meta":{"status":"existing"}}`;
    const body = fault === 'duplicate digest'
      ? valid.replace('"envelope_sha256":', `"envelope_sha256":"${'0'.repeat(64)}","envelope_sha256":`)
      : fault === 'error alongside receipt'
        ? valid.replace('{', '{"error":"incomplete_receipt",')
        : valid.replace('"status":"existing"', '"status":"existing","sequence":9007199254740993');
    const requests: string[] = [];
    const sink = new HarnessSink({
      credential: { url: 'https://harness.example.test', token: 'rbc_synthetic', source: 'attest' },
      rclVersion: 'test', fetchImpl: async (url, init) => {
        requests.push(`${init?.method} ${url}`);
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    expect(await sink.getAttestedRunReceipt(original, serialized)).toEqual({ kind: 'rejected' });
    expect(requests).toEqual([`GET https://harness.example.test/api/v1/reviews/runs/${original.run.id}`]);
  },
);
