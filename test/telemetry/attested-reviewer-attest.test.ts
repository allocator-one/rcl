import { describe, expect, it } from 'vitest';
import { attestRun, renewAttestation } from '../../src/telemetry/attest.js';
import { fakeFetch } from './fixtures.js';

const runId = '00000000-0000-4000-8000-000000000101';
const request = { version: 1 as const, source: { run_id: '00000000-0000-4000-8000-000000000100',
  report_sha256: 'a'.repeat(64), reviewer_artifact_sha256: 'b'.repeat(64) } };
const env = { HARNESS_API_URL: 'https://harness.example.test',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example.test/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-oidc-request' };

function remote() {
  return fakeFetch(r => r.url.includes('/oidc') ? { status: 200, body: { value: 'synthetic.jwt' } }
    : { status: 201, body: { data: { credential: 'rbc_synthetic', run_id: runId, expires_at: '2030-01-01T00:00:00Z' } } });
}

describe('attested exact-parent grant request', () => {
  it('sends and retains only the exact immutable parent tuple, including through renewal', async () => {
    const server = remote(), source = structuredClone(request);
    const pending = attestRun({ runId, rclVersion: '4.1.5', env, fetchImpl: server.fetch, reviewerRecovery: source });
    source.source.report_sha256 = 'c'.repeat(64);
    const attestation = await pending;
    expect(JSON.parse(server.requests[1]!.body!)).toEqual({ run_id: runId, reviewer_recovery: request });
    expect(attestation.reviewerRecovery).toEqual(request);
    const renewal = await renewAttestation(attestation, { rclVersion: '4.1.5', env, fetchImpl: server.fetch,
      now: () => Date.parse('2030-01-01T00:00:00Z') });
    expect(renewal.renewed).toBe(true);
    expect(JSON.parse(server.requests.at(-1)!.body!)).toEqual({ run_id: runId, reviewer_recovery: request });
  });

  it('refuses malformed, self-source and expanded grant requests before OIDC or Harness access', async () => {
    for (const value of [
      { ...request, version: 2 },
      { ...request, ancestors: [request.source] },
      { ...request, source: { ...request.source, run_id: runId } },
      { ...request, source: { ...request.source, report_sha256: 'bad' } },
      { ...request, source: { ...request.source, arbitrary: true } },
    ]) {
      const server = remote();
      await expect(attestRun({ runId, rclVersion: '4.1.5', env, fetchImpl: server.fetch,
        reviewerRecovery: value as typeof request })).rejects.toThrow('Invalid reviewer recovery attestation request');
      expect(server.requests).toEqual([]);
    }
  });
});
