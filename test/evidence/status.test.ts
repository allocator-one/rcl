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

  it('reports a pull request without judged evidence — Harness sends conclusive: null for both projections', async () => {
    // The production shape for a pull request no current-head run has been judged for.
    const unjudged = { status: 'none', head_sha: HEAD, conclusive: null, run_id: null, run_url: null, actionable: [], rounds: [] };
    const data = { ...gateStatus('none'), advisory: unjudged, enforced: unjudged };
    const { code, out } = run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data } }));
    expect(await code).toBe(EVIDENCE_EXIT.notConverged);
    const text = out.join('\n');
    expect(text).toContain('advisory: none');
    expect(text).toContain('enforced: none');
    expect(text).not.toContain('inconclusive');
    expect(text).not.toContain('malformed_response');
  });

  it('does not open the gate on a converged projection the server marks inconclusive', async () => {
    const data = gateStatus('converged');
    data.advisory.conclusive = false;
    const { code, out } = run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data } }));
    expect(await code).toBe(EVIDENCE_EXIT.notConverged);
    expect(out.join('\n')).toContain('converged (inconclusive)');
  });

  it('renders a merged fork head and the merge decision', async () => {
    const data = gateStatus('converged');
    data.head = { ...data.head!, merged: true, merge_commit_sha: 'f'.repeat(40), is_cross_repository: true, merged_at: '2026-09-08T09:28:58.000Z' };
    (data as Record<string, unknown>)['decision'] = {
      decision: 'converged',
      reviewed_head_sha: HEAD,
      merge_commit_sha: 'f'.repeat(40),
      merged_by_login: 'mstroeck',
      merged_at: '2026-09-08T09:28:58.000Z',
      source: 'webhook',
      decided_at: '2026-09-08T09:29:00.000Z',
      evidence: {},
    };
    const { code, out } = run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data } }));
    expect(await code).toBe(EVIDENCE_EXIT.converged);
    expect(out[0]).toContain('merged as ffffffffff');
    expect(out[0]).toContain('fork');
    expect(out.at(-1)).toBe('decision: converged at 25c4fed693 (webhook, merged 2026-09-08T09:28:58.000Z)');

    // A head record missing its flags is not a head.
    const flagless = gateStatus('converged');
    delete (flagless.head as Record<string, unknown>)['merged'];
    expect(await run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data: flagless } })).code).toBe(EVIDENCE_EXIT.unanswered);
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

  it('keeps control characters out of its messages and escapes C1 characters in --json', async () => {
    const hostile = run('allocator-one/allocator-one#8524', () => ({ status: 404, body: { error: 'not_found', message: 'gone\u001b[2J' } }));
    expect(await hostile.code).toBe(EVIDENCE_EXIT.unanswered);
    for (const line of hostile.err) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);

    const badArg = run('\u001b]8;;x\u0007/repo#1', () => ({ status: 200, body: {} }));
    expect(await badArg.code).toBe(EVIDENCE_EXIT.usage);
    for (const line of badArg.err) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);

    const data = gateStatus('converged');
    data.advisory.actionable = [
      { ref: 'F1', identity_key: 'k', severity: 'important', gating_reason: 'consensus', file: 'f', start_line: 1, end_line: 1, title: 'csi\u009b31m and del\u007f' },
    ];
    const json = run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data } }), { json: true });
    expect(await json.code).toBe(EVIDENCE_EXIT.converged);
    const printed = json.out.join('\n');
    expect(printed).not.toMatch(/[\u007f-\u009f]/);
    expect(printed).toContain('\\u009b');
    expect(JSON.parse(printed)).toEqual(data);
  });

  it('treats a body that is not a gate status as unanswered rather than converged', async () => {
    const { code, err } = run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data: { hello: 'world' } } }));
    expect(await code).toBe(EVIDENCE_EXIT.unanswered);
    expect(err.join('\n')).toMatch(/malformed/);
  });

  it('refuses an answer about another repository, a malformed round, or a projection without its fields', async () => {
    const otherRepo = { ...gateStatus('converged'), repo: 'allocator-one/rcl' };
    expect(await run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data: otherRepo } })).code).toBe(EVIDENCE_EXIT.unanswered);

    const nullRound = gateStatus('converged');
    (nullRound.advisory.rounds as unknown[]).push(null);
    expect(await run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data: nullRound } })).code).toBe(EVIDENCE_EXIT.unanswered);

    const bare = { ...gateStatus('converged'), enforced: { status: 'converged' } };
    expect(await run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data: bare } })).code).toBe(EVIDENCE_EXIT.unanswered);

    // Case only differs in the repository name: the same repository to GitHub.
    const cased = { ...gateStatus('converged'), repo: 'Allocator-One/Allocator-One' };
    expect(await run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data: cased } })).code).toBe(EVIDENCE_EXIT.converged);

    // A head whose flags are not booleans could read as merged; it is refused instead.
    const stringyHead = gateStatus('converged');
    (stringyHead.head as Record<string, unknown>)['merged'] = 'false';
    expect(await run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data: stringyHead } })).code).toBe(EVIDENCE_EXIT.unanswered);
  });

  it('renders a pull request Harness holds no head for, and strips control characters from server text', async () => {
    const { head: _dropped, ...headless } = gateStatus('none');
    headless.advisory.actionable = [
      {
        ref: 'F1',
        identity_key: 'abc123def4567890',
        severity: 'important',
        gating_reason: 'consensus',
        file: 'lib/foo.ex',
        start_line: 1,
        end_line: 1,
        title: 'Title with \u001b[31mescape\u001b[0m and\nnewline',
      },
    ];
    const { code, out } = run('allocator-one/allocator-one#8524', () => ({ status: 200, body: { data: headless } }));
    expect(await code).toBe(EVIDENCE_EXIT.notConverged);
    expect(out[0]).toContain('no head known');
    const line = out.find((l) => l.includes('abc123def4567890'))!;
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(line).toContain('escape');
  });
});
