import { describe, expect, it } from 'vitest';
import { runEvidenceStatus, EVIDENCE_EXIT } from '../../src/evidence/status.js';
import { fakeFetch } from '../telemetry/fixtures.js';

const ENV = { HARNESS_API_TOKEN: 'aone_TESTTOKEN0123456789', HARNESS_API_URL: 'https://harness.example.test' };
const HEAD = '25c4fed69342060ae596417a6ccf1be2262a212c';

function projection(status: string, overrides: Record<string, unknown> = {}) {
  return {
    status,
    head_sha: HEAD,
    conclusive: status !== 'inconclusive' && status !== 'none',
    run_id: '01a08032-0838-76db-ade3-1990f6e54072',
    run_url: 'https://harness.example.test/api/v1/reviews/runs/01a08032-0838-76db-ade3-1990f6e54072',
    actionable: [],
    rounds: [
      {
        id: '01a08032-0838-76db-ade3-1990f6e54072',
        url: 'https://harness.example.test/api/v1/reviews/runs/01a08032-0838-76db-ade3-1990f6e54072',
        tier: 'asserted',
        head_sha: HEAD,
        converge_round: 2,
        ordering_at: '2026-09-08T08:45:00.000Z',
        received_at: '2026-09-08T08:45:57.000Z',
      },
    ],
    ...overrides,
  };
}

function gateStatus(advisory: string, enforced = 'none') {
  return {
    repo: 'allocator-one/allocator-one',
    pr_number: 8524,
    head: {
      sha: HEAD,
      base_sha: 'c'.repeat(40),
      source: 'webhook',
      updated_at: '2026-09-08T08:40:00.000Z',
      is_cross_repository: false,
      merged: false,
      reviewed_head_sha: null,
      merge_commit_sha: null,
      merged_at: null,
    },
    advisory: projection(advisory),
    enforced: projection(enforced, { run_id: null, run_url: null, rounds: [] }),
    decision: null,
  };
}

function run(
  pr: string | undefined,
  handler: Parameters<typeof fakeFetch>[0],
  options: { json?: boolean; enforced?: boolean } = {},
  deps: { env?: Record<string, string>; remoteRepo?: () => Promise<{ owner: string; repo: string } | null> } = {}
) {
  const { fetch, requests } = fakeFetch(handler);
  const out: string[] = [];
  const err: string[] = [];
  const code = runEvidenceStatus(pr, options, {
    rclVersion: '3.1.0',
    fetchImpl: fetch,
    env: deps.env ?? ENV,
    cwd: '/nowhere',
    credentialsPath: '/nowhere/credentials.json',
    remoteRepo: deps.remoteRepo ?? (async () => ({ owner: 'allocator-one', repo: 'allocator-one' })),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, requests, out, err };
}

describe('rcl evidence status', () => {
  it('asks the credential host for the pull request named by owner/repo#N and exits 0 on a converged advisory projection', async () => {
    const { code, requests, out } = run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data: gateStatus('converged') } }));

    expect(await code).toBe(EVIDENCE_EXIT.converged);
    expect(requests[0]!.url).toBe('https://harness.example.test/api/v1/reviews/prs/allocator-one/allocator-one/8524');
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${ENV.HARNESS_API_TOKEN}`);
    const text = out.join('\n');
    expect(text).toContain('allocator-one/allocator-one#8524');
    expect(text).toContain('advisory: converged');
    expect(text).toContain(HEAD.slice(0, 10));
    expect(text).toContain('01a08032');
  });

  it('exits 1 for every status other than converged, naming it', async () => {
    for (const status of ['none', 'stale', 'unverified', 'inconclusive', 'fixes_pending', 'unresolved']) {
      const { code, out } = run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data: gateStatus(status) } }));
      expect(await code, status).toBe(EVIDENCE_EXIT.notConverged);
      expect(out.join('\n'), status).toContain(`advisory: ${status}`);
    }
  });

  it('judges the enforced projection with --enforced', async () => {
    const body = { data: gateStatus('converged', 'unverified') };
    expect(await run('allocator-one/allocator-one#8524', () => ({ status: 200, body })).code).toBe(EVIDENCE_EXIT.converged);
    expect(await run('allocator-one/allocator-one#8524', () => ({ status: 200, body }), { enforced: true }).code).toBe(EVIDENCE_EXIT.notConverged);
  });

  it('resolves a bare number or #number through the current git remote', async () => {
    for (const pr of ['8524', '#8524']) {
      const { code, requests } = run(pr, () => ({ status: 200, body: { data: gateStatus('converged') } }));
      expect(await code).toBe(EVIDENCE_EXIT.converged);
      expect(requests[0]!.url).toContain('/api/v1/reviews/prs/allocator-one/allocator-one/8524');
    }
  });

  it('prints the API status object verbatim with --json', async () => {
    const data = gateStatus('unresolved');
    const { code, out } = run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data } }), { json: true });
    expect(await code).toBe(EVIDENCE_EXIT.notConverged);
    expect(JSON.parse(out.join('\n'))).toEqual(data);
  });

  it('lists the actionable findings that keep a projection unresolved', async () => {
    const data = gateStatus('unresolved');
    data.advisory.actionable = [
      {
        ref: 'F3',
        identity_key: 'abc123def4567890',
        severity: 'important',
        gating_reason: 'consensus',
        file: 'lib/foo.ex',
        start_line: 10,
        end_line: 12,
        title: 'Pagination misses tiebreak',
      },
    ];
    const { code, out } = run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data } }));
    expect(await code).toBe(EVIDENCE_EXIT.notConverged);
    const text = out.join('\n');
    expect(text).toContain('abc123def4567890');
    expect(text).toContain('consensus');
    expect(text).toContain('lib/foo.ex:10');
  });

  it('exits 2 when the pull request cannot be named', async () => {
    const { code: missing, err: missingErr } = run(undefined, () => ({ status: 200, body: {} }));
    expect(await missing).toBe(EVIDENCE_EXIT.usage);
    expect(missingErr.join('\n')).toMatch(/owner\/repo#N/);

    const { code: noRemote, err, requests } = run('42', () => ({ status: 200, body: {} }), {}, { remoteRepo: async () => null });
    expect(await noRemote).toBe(EVIDENCE_EXIT.usage);
    expect(err.join('\n')).toMatch(/owner\/repo#42/);
    expect(requests).toHaveLength(0);
  });

  it('exits 3 when the read cannot be answered: no credential, evidence off, not found, refused credential, unreachable', async () => {
    const noCredential = run('allocator-one/allocator-one#8524', () => ({ status: 200, body: {} }), {}, { env: {} });
    expect(await noCredential.code).toBe(EVIDENCE_EXIT.unanswered);
    expect(noCredential.err.join('\n')).toMatch(/harness login/);
    expect(noCredential.requests).toHaveLength(0);

    const off = run('allocator-one/allocator-one#8524', () => ({
      status: 403,
      body: { error: 'reviews_disabled', message: 'review evidence is not enabled for this organization' },
    }));
    expect(await off.code).toBe(EVIDENCE_EXIT.unanswered);
    expect(off.err.join('\n')).toMatch(/not enabled review evidence/);

    const missing = run('allocator-one/allocator-one#8524', () => ({ status: 404, body: { error: 'not_found', message: 'no such pull request' } }));
    expect(await missing.code).toBe(EVIDENCE_EXIT.unanswered);
    expect(missing.err.join('\n')).toMatch(/not_found/);

    const rejected = run('allocator-one/allocator-one#8524', () => ({ status: 401, body: { error: 'unauthorized', message: 'token revoked' } }));
    expect(await rejected.code).toBe(EVIDENCE_EXIT.unanswered);
    expect(rejected.err.join('\n')).toMatch(/401/);

    const down = run('allocator-one/allocator-one#8524', () => new Error('ECONNREFUSED'));
    expect(await down.code).toBe(EVIDENCE_EXIT.unanswered);
    expect(down.err.join('\n')).toMatch(/unreachable/);
  });

  it('treats a body that is not a gate status as unanswered rather than converged', async () => {
    const { code, err } = run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data: { hello: 'world' } } }));
    expect(await code).toBe(EVIDENCE_EXIT.unanswered);
    expect(err.join('\n')).toMatch(/malformed/);
  });
});
