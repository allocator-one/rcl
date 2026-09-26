import { describe, expect, it } from 'vitest';
import { readCarrierInventory, readClaimTargetHistory } from '../../src/evidence/claim-recovery/carrier-inventory.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { projectionFixture } from './recovery-validation/carrier-fixtures.js';
import { uuid } from './recovery-validation/fixtures.js';

describe('claim reader scope pinning', () => {
  it.each(['carrier', 'history'])('validates the pinned %s scope before transport when caller accessors vary', async kind => {
    const projection = projectionFixture(false).projection;
    const carrier = projection.carrier;
    const validId = carrier.scope.run_id; let reads = 0;
    Object.defineProperty(carrier.scope, 'run_id', { enumerable: true,
      get: () => ++reads === 1 ? validId : '../../admin' });
    const requests: string[] = [];
    const sink = new HarnessSink({ credential: { url: carrier.scope.base_url, token: 'synthetic-only', source: 'login' },
      rclVersion: 'test', fetchImpl: async input => {
        const url = new URL(String(input)); requests.push(url.pathname);
        if (url.pathname === '/api/v1/reviews/runs') return Response.json({
          data: projection.sources.map(source => ({ id: source.selector.scope.run_id,
            target: source.storedRun!.target, converge: source.storedRun!.converge })),
          meta: { org_id: carrier.scope.org_id, evidence_protocol_version: 2,
            page: 1, page_size: 100, total: 1, total_pages: 1 },
        });
        return Response.json({ data: {}, meta: {} });
      } });
    // The endpoint deliberately refuses its result; the asserted boundary is
    // the exact authenticated request target, before any response is trusted.
    const result = kind === 'carrier'
      ? readCarrierInventory(sink, carrier, uuid(900))
      : readClaimTargetHistory(sink, carrier);
    expect((await result).kind).not.toBe('ok');
    expect(requests).toEqual(kind === 'carrier'
      ? ['/api/v1/reviews/runs', `/api/v1/reviews/runs/${validId}`]
      : [`/api/v1/reviews/runs/${validId}`]);
    expect(reads).toBe(1);
  });
});
