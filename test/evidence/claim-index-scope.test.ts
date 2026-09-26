import { describe, expect, it } from 'vitest';
import { readClaimEventIndex } from '../../src/evidence/claim-recovery/claim-index.js';
import type { EventReceiptScope } from '../../src/evidence/event-receipts.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { uuid } from './recovery-validation/uuid.js';

const selection = (): EventReceiptScope => ({ base_url: 'https://synthetic.example.test',
  org_id: uuid(2), run_id: uuid(1), repo: 'synthetic/recovery', pr_number: 7 });

describe('claim event index scope', () => {
  it.each(['path', 'null'])('rejects an invalid %s scope before authenticated transport', async kind => {
    const scope = selection(); const requests: string[] = [];
    const sink = new HarnessSink({ credential: { url: scope.base_url, token: 'synthetic-only', source: 'login' },
      rclVersion: 'test', fetchImpl: async input => {
        requests.push(String(input));
        return Response.json({ data: [], meta: {} });
      } });
    const invalid = kind === 'path' ? { ...scope, run_id: '../../admin' } : null;

    await expect(readClaimEventIndex(sink, invalid as EventReceiptScope, 1))
      .rejects.toThrow('invalid_claim_index_selection');
    expect(requests).toEqual([]);
  });

  it('pins the validated scope across paginated authenticated reads', async () => {
    const scope = selection(); const original = structuredClone(scope); const paths: string[] = [];
    const sink = new HarnessSink({ credential: { url: scope.base_url, token: 'synthetic-only', source: 'login' },
      rclVersion: 'test', fetchImpl: async input => {
        const url = new URL(String(input)); paths.push(url.pathname);
        const after = Number(url.searchParams.get('after_sequence'));
        const sequences = after === 0 ? Array.from({ length: 50 }, (_, index) => index + 1) : [51];
        scope.run_id = uuid(999); scope.org_id = uuid(998);
        return Response.json({ data: sequences.map(sequence => ({ id: uuid(100 + sequence), sequence, kind: 'round_processed' })),
          meta: { org_id: original.org_id, run_id: original.run_id, claim_recovery_version: 1,
            through_sequence: 51, complete: after !== 0, next_after_sequence: after === 0 ? 50 : null } });
      } });

    const result = await readClaimEventIndex(sink, scope, 51);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error(JSON.stringify(result));
    expect(result.value.map(row => row.sequence)).toEqual(Array.from({ length: 51 }, (_, index) => index + 1));
    expect(paths).toEqual(Array(2).fill(`/api/v1/reviews/runs/${original.run_id}/events`));
  });
});
