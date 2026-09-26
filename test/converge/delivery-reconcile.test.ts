import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createGuardedDeliveryConfirmer, matchesGuardedDelivery, verifyGuardedDelivery } from '../../src/converge/delivery-reconcile.js';
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

  it('checks downloaded report bytes against the guarded digest', async () => {
    const bytes = Buffer.from('exact report');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const identity = { ...expected, reportJsonSha256: digest };
    const delivered = { ...run(), artifacts: [{ kind: 'report_json', declared_sha256: digest,
      declared_bytes: bytes.length, stored: true }] };
    expect(await verifyGuardedDelivery(delivered, identity, async () => bytes)).toBe(true);
    expect(await verifyGuardedDelivery(delivered, identity, async () => Buffer.from('wrong report'))).toBe(false);
    expect(await verifyGuardedDelivery(delivered, identity, async () => null)).toBe(false);
    expect(await verifyGuardedDelivery({ ...delivered, artifacts: [{ kind: 'report_json', declared_sha256: digest,
      stored: true }] }, identity, async () => bytes)).toBe(false);
  });

  it('uses the stored matching report artifact for the byte receipt', async () => {
    const bytes = Buffer.from('exact report');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const identity = { ...expected, reportJsonSha256: digest };
    const delivered = { ...run(), artifacts: [
      { kind: 'report_json', declared_sha256: 'c'.repeat(64), declared_bytes: 1, stored: false },
      { kind: 'report_json', declared_sha256: digest, declared_bytes: bytes.length, stored: true },
    ] };

    expect(await verifyGuardedDelivery(delivered, identity, async () => bytes)).toBe(true);
  });

  it('confirms only an exact delivered run and downloaded report bytes through the read sink', async () => {
    const bytes = Buffer.from('exact report');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const identity = { ...expected, reportJsonSha256: digest };
    const delivered = { ...run(), artifacts: [{ kind: 'report_json', declared_sha256: digest,
      declared_bytes: bytes.length, stored: true }] };
    const sink = { getArtifact: vi.fn().mockResolvedValue({ kind: 'ok', httpStatus: 200,
      value: { bytes, sha256: digest } }) };
    const confirm = createGuardedDeliveryConfirmer({ target: identity.target, rclVersion: 'test', cwd: '/',
      dependencies: { openReadSink: vi.fn().mockResolvedValue({ sink }),
        getRun: vi.fn().mockResolvedValue({ kind: 'ok', httpStatus: 200, value: delivered }) } });

    expect(await confirm({ ...identity, status: 'completed', inputSha256: 'c'.repeat(64),
      startedAt: '2026-09-26T12:31:20.636Z', pid: 1, successfulReviews: 1, totalReviews: 2,
      deliveryPending: true, hardFailure: true })).toBe(true);
    expect(sink.getArtifact).toHaveBeenCalledWith(identity.runId, 'report_json', bytes.length);
  });

  it.each([
    ['missing', null],
    ['mismatched', Buffer.from('wrong report')],
    ['unavailable', undefined],
  ])('refuses %s report bytes through the read sink', async (_label, report) => {
    const bytes = Buffer.from('exact report');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const identity = { ...expected, reportJsonSha256: digest };
    const delivered = { ...run(), artifacts: [{ kind: 'report_json', declared_sha256: digest,
      declared_bytes: bytes.length, stored: true }] };
    const artifact = report === undefined ? { kind: 'unavailable', reason: 'fixture' }
      : report === null ? { kind: 'ok', httpStatus: 200, value: { bytes: null, sha256: digest } }
        : { kind: 'ok', httpStatus: 200, value: { bytes: report, sha256: digest } };
    const sink = { getArtifact: vi.fn().mockResolvedValue(artifact) };
    const confirm = createGuardedDeliveryConfirmer({ target: identity.target, rclVersion: 'test', cwd: '/',
      dependencies: { openReadSink: vi.fn().mockResolvedValue({ sink }),
        getRun: vi.fn().mockResolvedValue({ kind: 'ok', httpStatus: 200, value: delivered }) } });

    expect(await confirm({ ...identity, status: 'completed', inputSha256: 'c'.repeat(64),
      startedAt: '2026-09-26T12:31:20.636Z', pid: 1, successfulReviews: 1, totalReviews: 2,
      deliveryPending: true, hardFailure: true })).toBe(false);
  });

  it('fails closed before reading evidence when the guarded receipt is incomplete', async () => {
    const openReadSink = vi.fn();
    const confirm = createGuardedDeliveryConfirmer({ target: expected.target, rclVersion: 'test', cwd: '/',
      dependencies: { openReadSink, getRun: vi.fn() } });

    expect(await confirm({ ...expected, runId: '', status: 'completed', inputSha256: 'c'.repeat(64),
      startedAt: '2026-09-26T12:31:20.636Z', pid: 1, successfulReviews: 1, totalReviews: 2,
      deliveryPending: true, hardFailure: true })).toBe(false);
    expect(openReadSink).not.toHaveBeenCalled();
  });

  it.each(['unavailable sink', 'unavailable run'] as const)(
    'fails closed for an %s read', async failure => {
      const openReadSink = vi.fn().mockResolvedValue(failure === 'unavailable sink' ? { sink: null } : { sink: {} });
      const getRun = vi.fn().mockResolvedValue({ kind: 'unavailable', reason: 'fixture' });
      const confirm = createGuardedDeliveryConfirmer({ target: expected.target, rclVersion: 'test', cwd: '/',
        dependencies: { openReadSink, getRun } });

      expect(await confirm({ ...expected, status: 'completed', inputSha256: 'c'.repeat(64),
        startedAt: '2026-09-26T12:31:20.636Z', pid: 1, successfulReviews: 1, totalReviews: 2,
        deliveryPending: true, hardFailure: true })).toBe(false);
      expect(getRun).toHaveBeenCalledTimes(failure === 'unavailable sink' ? 0 : 1);
    }
  );
});
