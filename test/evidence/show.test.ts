import { describe, expect, it } from 'vitest';
import { runEvidenceShow } from '../../src/evidence/show.js';
import { EVIDENCE_EXIT } from '../../src/evidence/status.js';
import { fakeFetch } from '../telemetry/fixtures.js';

const ENV = { HARNESS_API_TOKEN: 'aone_TESTTOKEN0123456789', HARNESS_API_URL: 'https://harness.example.test' };
const RUN_ID = '01a08032-0838-76db-ade3-1990f6e54072';

function runDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    command: 'review',
    url: `https://harness.example.test/api/v1/reviews/runs/${RUN_ID}`,
    target: {
      kind: 'pr',
      repo: 'allocator-one/allocator-one',
      pr_number: 8524,
      url: 'https://github.com/allocator-one/allocator-one/pull/8524',
      head_sha: '25c4fed69342060ae596417a6ccf1be2262a212c',
      base_sha: 'c'.repeat(40),
      head_ref: 'io-12479-review-ci-evidence',
      base_ref: 'main',
      diff_sha256: 'd'.repeat(64),
      files: 4,
      additions: 109,
      deletions: 9,
    },
    credential_kind: 'api_token',
    tier: 'asserted',
    head_verified: 'current',
    repo_verified: true,
    is_cross_repository: false,
    provenance: 'live',
    rcl_version: '3.0.0',
    runner: { kind: 'ci', ci_run_id: '34205909167' },
    converge: null,
    ordering_at: '2026-09-08T08:45:00.000Z',
    received_at: '2026-09-08T08:45:57.000Z',
    roster: [{ model: 'anthropic/claude', role: 'bug-hunter' }],
    stats: { totalReviews: 16, successfulReviews: 16 },
    artifacts: [
      { kind: 'report_json', declared_sha256: 'a'.repeat(64), declared_bytes: 10, stored: true, url: 'https://harness.example.test/x.json' },
      { kind: 'report_md', declared_sha256: 'b'.repeat(64), declared_bytes: 10, stored: false, url: null },
    ],
    findings: [
      {
        ref: 'F1',
        identity_key: 'abc123def4567890',
        file: 'lib/foo.ex',
        start_line: 10,
        end_line: 12,
        severity: 'important',
        category: 'correctness',
        title: 'Pagination misses tiebreak',
        gating_reason: 'consensus',
        verification_verdict: 'confirmed',
        below_threshold: false,
        verdict: { verdict: 'fixed', reason: 'tiebreak added', round: 2 },
      },
      {
        ref: 'F2',
        identity_key: 'fedcba9876543210',
        file: 'lib/bar.ex',
        start_line: 3,
        end_line: 3,
        severity: 'minor',
        category: 'style',
        title: 'Typo',
        gating_reason: 'none',
        verification_verdict: null,
        below_threshold: true,
      },
    ],
    calls: [
      { model: 'anthropic/claude', role: 'bug-hunter', status: 'success', duration_ms: 1200 },
      { model: 'openai/gpt', role: 'security-auditor', status: 'timeout', duration_ms: 0 },
    ],
    ...overrides,
  };
}

function run(id: string, handler: Parameters<typeof fakeFetch>[0], options: { json?: boolean } = {}) {
  const { fetch, requests } = fakeFetch(handler);
  const out: string[] = [];
  const err: string[] = [];
  const code = runEvidenceShow(id, options, {
    rclVersion: '3.1.0',
    fetchImpl: fetch,
    env: ENV,
    cwd: '/nowhere',
    credentialsPath: '/nowhere/credentials.json',
    remoteRepo: async () => null,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, requests, out, err };
}

describe('rcl evidence show', () => {
  it('fetches the run from the credential host and lists findings with identity, gating reason and verdict', async () => {
    const { code, requests, out } = run(RUN_ID, () => ({ status: 200, body: { data: runDetail() } }));

    expect(await code).toBe(0);
    expect(requests[0]!.url).toBe(`https://harness.example.test/api/v1/reviews/runs/${RUN_ID}`);
    const text = out.join('\n');
    expect(text).toContain('allocator-one/allocator-one#8524');
    expect(text).toContain('25c4fed693');
    expect(text).toContain('api_token');
    expect(text).toContain('ci');
    expect(text).toContain('16/16');
    expect(text).toContain('abc123def4567890');
    expect(text).toContain('consensus');
    expect(text).toContain('fixed');
    expect(text).toContain('fedcba9876543210');
    expect(text).toMatch(/report_json .*stored/);
    expect(text).toMatch(/report_md .*missing/);
  });

  it('shows — for a finding without a recorded verdict and marks dead reviewer calls', async () => {
    const { code, out } = run(RUN_ID, () => ({ status: 200, body: { data: runDetail() } }));
    expect(await code).toBe(0);
    const typo = out.find((line) => line.includes('fedcba9876543210'));
    expect(typo).toMatch(/—/);
    expect(out.join('\n')).toMatch(/openai\/gpt .*timeout/);
  });

  it('prints the run object verbatim with --json', async () => {
    const data = runDetail();
    const { code, out } = run(RUN_ID, () => ({ status: 200, body: { data } }), { json: true });
    expect(await code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual(data);
  });

  it('renders a converge round and refuses a run without its target', async () => {
    const converge = run(RUN_ID, () => ({
      status: 200,
      body: { data: runDetail({ target: { kind: 'patch', head_sha: 'e'.repeat(40) }, converge: { target: 'allocator-one/allocator-one#8524', round: 3, attempt: 4 } }) },
    }));
    expect(await converge.code).toBe(0);
    expect(converge.out.join('\n')).toMatch(/target patch @ eeeeeeeeee/);
    expect(converge.out.join('\n')).toMatch(/converge allocator-one\/allocator-one#8524 round 3/);

    const { target: _dropped, ...withoutTarget } = runDetail();
    const malformed = run(RUN_ID, () => ({ status: 200, body: { data: withoutTarget } }));
    expect(await malformed.code).toBe(EVIDENCE_EXIT.unanswered);
  });

  it('exits 3 when the run is unknown, names another run, or evidence is off', async () => {
    const missing = run(RUN_ID, () => ({ status: 404, body: { error: 'not_found', message: 'no such run' } }));
    expect(await missing.code).toBe(EVIDENCE_EXIT.unanswered);
    expect(missing.err.join('\n')).toMatch(/not_found/);

    const other = run(RUN_ID, () => ({ status: 200, body: { data: runDetail({ id: 'someone-else' }) } }));
    expect(await other.code).toBe(EVIDENCE_EXIT.unanswered);
    expect(other.err.join('\n')).toMatch(/malformed/);

    const off = run(RUN_ID, () => ({ status: 403, body: { error: 'reviews_disabled', message: 'off' } }));
    expect(await off.code).toBe(EVIDENCE_EXIT.unanswered);
  });

  it('reads a run far larger than a delivery receipt', async () => {
    // A real run carries dozens of findings with descriptions; the receipt
    // bound (64 KB) that guards deliveries must not cut reads short.
    const findings = Array.from({ length: 400 }, (_, i) => ({
      ref: `F${i}`,
      identity_key: i.toString(16).padStart(16, '0'),
      file: 'lib/foo.ex',
      start_line: i,
      end_line: i,
      severity: 'important',
      category: 'correctness',
      title: 'x'.repeat(200),
      gating_reason: 'consensus',
      verification_verdict: null,
      below_threshold: false,
    }));
    const data = runDetail({ findings });
    expect(JSON.stringify({ data }).length).toBeGreaterThan(64 * 1024);
    const { code, out } = run(RUN_ID, () => ({ status: 200, body: { data } }));
    expect(await code).toBe(0);
    expect(out.join('\n')).toContain('findings (400)');
  });

  it('refuses findings or calls that are not records, and keeps server text on one clean line', async () => {
    const nullFinding = runDetail({ findings: [null] });
    expect(await run(RUN_ID, () => ({ status: 200, body: { data: nullFinding } })).code).toBe(EVIDENCE_EXIT.unanswered);
    const bareCall = runDetail({ calls: [{}] });
    expect(await run(RUN_ID, () => ({ status: 200, body: { data: bareCall } })).code).toBe(EVIDENCE_EXIT.unanswered);

    const hostile = runDetail({
      findings: [
        {
          ref: 'F9',
          identity_key: 'deadbeefdeadbeef',
          file: 'lib/\u001b]8;;https://evil\u0007link.ex',
          start_line: 1,
          end_line: 1,
          severity: 'important',
          category: 'x',
          title: 'multi\nline\rtitle',
          gating_reason: 'consensus',
        },
      ],
      calls: [{ model: 'm', role: 'r', status: 'error', duration_ms: 1, error: 'boom\u001b[2J' }],
    });
    const { code, out } = run(RUN_ID, () => ({ status: 200, body: { data: hostile } }));
    expect(await code).toBe(0);
    for (const line of out) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(out.find((l) => l.includes('deadbeefdeadbeef'))).toContain('multi line title');
  });

  it('refuses an empty run id before touching the network', async () => {
    const { code, requests, err } = run('   ', () => ({ status: 200, body: {} }));
    expect(await code).toBe(EVIDENCE_EXIT.usage);
    expect(requests).toHaveLength(0);
    expect(err.join('\n')).toMatch(/run id/);
  });
});
