import { describe, expect, it } from 'vitest';
import { matchesGuardedDelivery } from '../../src/converge/delivery-reconcile.js';
import type { RunDetail } from '../../src/evidence/types.js';

const expected = {
  runId: '019921a0-0000-7000-8000-000000000001', target: 'allocator-one-9312',
  round: 7, attempt: 14, headSha: 'a'.repeat(40), reportJsonSha256: 'b'.repeat(64),
};

function run(): RunDetail {
  return { id: expected.runId, target: { kind: 'patch', head_sha: expected.headSha },
    converge: { target: expected.target, round: expected.round, attempt: expected.attempt },
    received_at: '2026-09-26T12:31:20.636Z', repo_verified: true,
    artifacts: [{ kind: 'report_json', declared_sha256: expected.reportJsonSha256, stored: true }],
    findings: [], calls: [] };
}

describe('guarded delivery receipt', () => {
  it('accepts the exact stored run and report artifact', () => {
    expect(matchesGuardedDelivery(run(), expected)).toBe(true);
  });

  it('refuses missing, mismatched or unverified evidence', () => {
    expect(matchesGuardedDelivery(null, expected)).toBe(false);
    expect(matchesGuardedDelivery({ ...run(), id: '019921a0-0000-7000-8000-000000000002' }, expected)).toBe(false);
    expect(matchesGuardedDelivery({ ...run(), target: { kind: 'patch', head_sha: 'c'.repeat(40) } }, expected)).toBe(false);
    expect(matchesGuardedDelivery({ ...run(), converge: { target: expected.target, round: 7, attempt: 13 } }, expected)).toBe(false);
    expect(matchesGuardedDelivery({ ...run(), artifacts: [{ kind: 'report_json', declared_sha256: 'c'.repeat(64), stored: true }] }, expected)).toBe(false);
    expect(matchesGuardedDelivery({ ...run(), artifacts: [{ kind: 'report_json', declared_sha256: expected.reportJsonSha256, stored: false }] }, expected)).toBe(false);
    expect(matchesGuardedDelivery({ ...run(), repo_verified: false }, expected)).toBe(false);
  });
});
