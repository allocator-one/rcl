import { describe, expect, it } from 'vitest';
import { readClaimRecoveryContext, type ClaimRecoverySelection } from '../../src/evidence/claim-recovery/context.js';
import { HarnessSink } from '../../src/telemetry/sink.js';

const uuid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const selection: ClaimRecoverySelection = { scope: { base_url: 'https://synthetic.example.test', org_id: uuid(1),
  run_id: uuid(2), repo: 'synthetic/recovery', pr_number: 7 }, target: 'same-target', round: 2,
  reportSha256: 'a'.repeat(64), headSha: 'b'.repeat(40) };
function response() {
  return { data: { id: selection.scope.run_id, target: { kind: 'pr', repo: selection.scope.repo,
    pr_number: selection.scope.pr_number, head_sha: selection.headSha },
    actor_user_id: uuid(4), converge: { target: selection.target, round: selection.round },
    artifacts: [{ kind: 'report_json', declared_sha256: selection.reportSha256, stored: true }] },
    meta: { org_id: selection.scope.org_id, actor_user_id: uuid(3), evidence_protocol_version: 2,
      claim_recovery_version: 1, recovery: { event_sequence: 9, truncated: false } } };
}
function client(body: unknown, status = 200, credentialSource: 'login' | 'attest' = 'login') {
  const calls: Array<{ url: string; method: string }> = [];
  const sink = new HarnessSink({ credential: { url: selection.scope.base_url, token: 'synthetic', source: credentialSource },
    rclVersion: 'test', fetchImpl: async (url, request) => {
      calls.push({ url: String(url), method: request?.method ?? 'GET' }); return Response.json(body, { status });
    } });
  return { sink, calls };
}

describe('authenticated claim recovery context', () => {
  it('pins the current authenticated operator separately from the historical report actor', async () => {
    const c = client(response());
    expect(await readClaimRecoveryContext(c.sink, selection)).toMatchObject({ kind: 'ok',
      value: { actorUserId: uuid(3), eventSequence: 9 } });
    expect(c.calls).toEqual([{ method: 'GET', url: `${selection.scope.base_url}/api/v1/reviews/runs/${selection.scope.run_id}` }]);
  });

  it.each(['capability', 'actor', 'organization', 'source-run', 'target', 'round', 'report', 'stored', 'head', 'truncated', 'sequence'])
  ('refuses a missing or mismatched %s binding', async change => {
    const body = response();
    if (change === 'capability') delete (body.meta as Partial<typeof body.meta>).claim_recovery_version;
    if (change === 'actor') delete (body.meta as Partial<typeof body.meta>).actor_user_id;
    if (change === 'organization') body.meta.org_id = uuid(9);
    if (change === 'source-run') body.data.id = uuid(9);
    if (change === 'target') body.data.converge.target = 'other-target';
    if (change === 'round') body.data.converge.round = 1;
    if (change === 'report') body.data.artifacts[0]!.declared_sha256 = 'c'.repeat(64);
    if (change === 'stored') body.data.artifacts[0]!.stored = false;
    if (change === 'head') body.data.target.head_sha = 'c'.repeat(40);
    if (change === 'truncated') body.meta.recovery.truncated = true;
    if (change === 'sequence') body.meta.recovery.event_sequence = -1;
    expect(await readClaimRecoveryContext(client(body).sink, selection)).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
  });

  it('refuses a changed login even though the organization and original report still match', async () => {
    expect(await readClaimRecoveryContext(client(response()).sink, selection, uuid(9)))
      .toMatchObject({ kind: 'rejected', error: 'malformed_response' });
  });

  it('does not infer a complete source from a partial HTTP response', async () => {
    expect(await readClaimRecoveryContext(client(response(), 206).sink, selection))
      .toMatchObject({ kind: 'rejected', error: 'malformed_response' });
  });

  it('refuses changed destinations and run-bound credentials before HTTP', async () => {
    const c = client(response());
    await expect(readClaimRecoveryContext(c.sink, { ...selection, scope: { ...selection.scope, base_url: 'https://other.example.test' } }))
      .rejects.toThrow('claim_recovery_destination_conflict');
    expect(c.calls).toEqual([]);
    const attested = client(response(), 200, 'attest');
    await expect(readClaimRecoveryContext(attested.sink, selection)).rejects.toThrow('unsupported_attested_recovery');
    expect(attested.calls).toEqual([]);
  });
});
