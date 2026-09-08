import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { UUID_NAMESPACE_RCL_BACKFILL, uuidv5 } from '../../src/report/uuid.js';
import { buildBackfillRuns, runBackfill } from '../../src/telemetry/backfill.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { fakeFetch } from './fixtures.js';

const CREDENTIAL = { url: 'https://harness.example.test', token: 'aone_TESTTOKEN0123456789', source: 'login' as const };
const dirs: string[] = [];

function report(models: string[], findings: Array<{ file: string; title: string; models: string[] }>) {
  return {
    reviews: models.map((model, i) => ({ model, role: 'general', provider: model.split('/')[0], durationMs: 1000 * (i + 1), status: i === 1 ? 'timeout' : 'success' })),
    findings: findings.map((f, i) => ({
      id: `f00${i + 1}`,
      file: f.file,
      startLine: 10 + i,
      endLine: 12 + i,
      severity: 'important',
      category: 'correctness',
      title: f.title,
      description: 'desc',
      consensus: { score: 2, total: 3, models: f.models, roles: ['general'], crossRole: false, crossModel: true, elevated: false },
    })),
    belowThresholdFindings: [],
    stats: { totalReviews: models.length, successfulReviews: models.length - 1, totalRawFindings: 4, totalDeduped: findings.length, belowThreshold: 0, durationMs: 4000 },
  };
}

function corpus(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rcl-backfill-'));
  dirs.push(dir);
  const r1 = report(['anthropic/claude', 'openai/gpt', 'google/gemini'], [
    { file: 'lib/foo.ex', title: 'Pagination misses tiebreak', models: ['anthropic/claude', 'openai/gpt'] },
    { file: 'lib/bar.ex', title: 'Unused variable', models: ['google/gemini'] },
  ]);
  const r2 = report(['anthropic/claude', 'openai/gpt'], [{ file: 'lib/foo.ex', title: 'Pagination misses tiebreak', models: ['anthropic/claude'] }]);
  writeFileSync(join(dir, 'rcl-report-allocator-one-42-r1.json'), JSON.stringify(r1));
  writeFileSync(join(dir, 'rcl-report-allocator-one-42-r1.md'), '# report r1\n');
  writeFileSync(join(dir, 'rcl-report-allocator-one-42-r2.json'), JSON.stringify(r2));
  writeFileSync(join(dir, 'rcl-report-broken.json'), '{"not": "a report"}');
  writeFileSync(join(dir, 'notes.txt'), 'ignored');
  writeFileSync(
    join(dir, 'rcl-converge-allocator-one-42-ledger.md'),
    [
      '# RCL converge ledger — allocator-one-42',
      '',
      '## Round 1 — report /tmp/rcl-report-allocator-one-42-r1.json — 2 findings',
      '- [fixed] lib/foo.ex — pagination misses tiebreak on inserted_at — commit abc',
      '- [dismissed] lib/bar.ex — "unused variable" — used by the macro',
      '',
      '## Round 2 — report /tmp/rcl-report-allocator-one-42-r2.json — 1 finding',
      '- [dismissed] lib/foo.ex — pagination misses tiebreak — same code, verified fixed',
      '',
    ].join('\n')
  );
  const stamp = new Date('2026-08-15T10:00:00Z');
  for (const f of ['rcl-report-allocator-one-42-r1.json', 'rcl-report-allocator-one-42-r2.json', 'rcl-converge-allocator-one-42-ledger.md']) {
    utimesSync(join(dir, f), stamp, stamp);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('buildBackfillRuns', () => {
  it('turns pre-3.0 reports into backfill envelopes with deterministic ids, findings, calls and ledger verdicts', async () => {
    const dir = corpus();
    const built = await buildBackfillRuns({ dir, repo: 'allocator-one/allocator-one', host: 'harness.example.test', rclVersion: '3.1.0' });

    expect(built.runs).toHaveLength(2);
    expect(built.skipped).toEqual([{ file: 'rcl-report-broken.json', reason: expect.stringMatching(/reviews/) }]);
    const [r1, r2] = built.runs;
    // The id is the UUIDv5 of (host, repo, sha256 of the file's bytes), computed here independently.
    const digest = createHash('sha256').update(readFileSync(join(dir, 'rcl-report-allocator-one-42-r1.json'))).digest('hex');
    expect(r1!.envelope.run.id).toBe(uuidv5(`harness.example.test|allocator-one/allocator-one|${digest}`, UUID_NAMESPACE_RCL_BACKFILL));
    expect(r1!.envelope.run.id).not.toBe(r2!.envelope.run.id);
    expect(r1!.envelope.run).toMatchObject({
      provenance: 'backfill',
      command: 'review',
      rcl_version: 'pre-3.0',
      target: { kind: 'patch', repo: 'allocator-one/allocator-one', files: 0 },
      runner: { kind: 'agent', agent: 'rcl telemetry backfill' },
      finished_at: '2026-08-15T10:00:00.000Z',
      duration_ms: 4000,
    });
    expect(r1!.envelope.run.started_at).toBe('2026-08-15T09:59:56.000Z');
    expect(r1!.envelope.run.roster).toEqual([
      { model: 'anthropic/claude', role: 'general', provider: 'anthropic', lane: 'blocking' },
      { model: 'openai/gpt', role: 'general', provider: 'openai', lane: 'blocking' },
      { model: 'google/gemini', role: 'general', provider: 'google', lane: 'blocking' },
    ]);
    expect(r1!.envelope.findings).toHaveLength(2);
    expect(r1!.envelope.findings[0]).toMatchObject({ ref: 'f001', file: 'lib/foo.ex', start_line: 10, gating_reason: 'none', below_threshold: false });
    expect(r1!.envelope.findings[0]!.identity_key).toMatch(/^[0-9a-f]{16}$/);
    expect(r1!.envelope.calls.map((c) => c.status)).toEqual(['success', 'timeout', 'success']);
    expect(r1!.envelope.artifacts_declared.map((a) => a.kind)).toEqual(['report_json', 'report_md']);
    expect(r1!.artifacts.report_md).toBe('# report r1\n');
    expect(r2!.envelope.artifacts_declared.map((a) => a.kind)).toEqual(['report_json']);

    // Ledger bullets become verdict events bound to their round's run, with deterministic ids.
    expect(r1!.events).toHaveLength(1);
    expect(r1!.events[0]).toMatchObject({
      kind: 'verdicts_recorded',
      run_id: r1!.envelope.run.id,
      converge_target: 'allocator-one-42',
      round: 1,
      occurred_at: '2026-08-15T10:00:00.000Z',
    });
    const verdicts = r1!.events[0]!.payload['verdicts'] as Array<Record<string, unknown>>;
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toMatchObject({ identity_key: r1!.envelope.findings[0]!.identity_key, verdict: 'fixed', severity: 'important', models: ['anthropic/claude', 'openai/gpt'] });
    expect(verdicts[1]).toMatchObject({ identity_key: r1!.envelope.findings[1]!.identity_key, verdict: 'dismissed' });
    expect(r2!.events[0]!.payload['verdicts']).toEqual([expect.objectContaining({ verdict: 'dismissed' })]);
    expect(built.bulletsMatched).toBe(3);
    expect(built.bulletsUnmatched).toBe(0);

    // Same corpus, same repo, same host → the same ids; another repository → other ids.
    const again = await buildBackfillRuns({ dir, repo: 'allocator-one/allocator-one', host: 'harness.example.test', rclVersion: '3.1.0' });
    expect(again.runs.map((r) => r.envelope.run.id)).toEqual(built.runs.map((r) => r.envelope.run.id));
    expect(again.runs.map((r) => r.events[0]!.id)).toEqual(built.runs.map((r) => r.events[0]!.id));
    const elsewhere = await buildBackfillRuns({ dir, repo: 'allocator-one/rcl', host: 'harness.example.test', rclVersion: '3.1.0' });
    expect(elsewhere.runs[0]!.envelope.run.id).not.toBe(r1!.envelope.run.id);
    // GitHub names are case-insensitive; so is the id.
    const cased = await buildBackfillRuns({ dir, repo: 'Allocator-One/Allocator-One', host: 'Harness.Example.Test', rclVersion: '3.1.0' });
    expect(cased.runs.map((r) => r.envelope.run.id)).toEqual(built.runs.map((r) => r.envelope.run.id));
  });

  it('skips what is not a regular readable report — symlinks, absurd durations, unreadable ledgers — and keeps going', async () => {
    const dir = corpus();
    writeFileSync(join(dir, 'notes.txt'), 'a regular file a link could point at');
    symlinkSync(join(dir, 'notes.txt'), join(dir, 'rcl-report-allocator-one-42-r2.md'));
    symlinkSync(join(dir, 'notes.txt'), join(dir, 'rcl-report-linked.json'));
    const long = report(['anthropic/claude'], []);
    long.stats.durationMs = 1e15;
    writeFileSync(join(dir, 'rcl-report-long.json'), JSON.stringify(long));
    symlinkSync(join(dir, 'notes.txt'), join(dir, 'rcl-converge-linked-ledger.md'));
    writeFileSync(
      join(dir, 'rcl-converge-allocator-one-42b-ledger.md'),
      '## Round 1 — report `/tmp/rcl-report-allocator-one-42-r1.json` — 2 findings\n* [Fixed] lib/foo.ex — pagination misses tiebreak on inserted_at\n'
    );

    writeFileSync(join(dir, 'rcl-report-huge.json'), Buffer.alloc(25 * 1024 * 1024 + 1, 0x20));

    const built = await buildBackfillRuns({ dir, repo: 'allocator-one/allocator-one', host: 'harness.example.test', rclVersion: '3.1.0' });
    expect(built.runs.map((r) => r.file)).toEqual(['rcl-report-allocator-one-42-r1.json', 'rcl-report-allocator-one-42-r2.json']);
    const reasons = Object.fromEntries(built.skipped.map((s) => [s.file, s.reason]));
    expect(reasons['rcl-report-huge.json']).toMatch(/artifact cap/);
    expect(reasons['rcl-report-allocator-one-42-r2.md']).toMatch(/symbolic link/);
    expect(reasons['rcl-report-linked.json']).toMatch(/symbolic link/);
    expect(reasons['rcl-report-long.json']).toMatch(/durationMs/);
    expect(reasons['rcl-converge-linked-ledger.md']).toMatch(/symbolic link/);
    expect(built.runs[1]!.artifacts.report_md).toBeUndefined();
    // A backticked report path, a `*` bullet and an upper-case verdict still parse.
    const r1 = built.runs[0]!;
    expect(r1.events.map((e) => e.converge_target).sort()).toEqual(['allocator-one-42', 'allocator-one-42b']);
  });
});

function server(state: { existing: Set<string>; missing?: Set<string> }) {
    return fakeFetch((request) => {
      if (request.method === 'POST' && request.url.endsWith('/api/v1/reviews/runs')) {
        const id = (JSON.parse(request.body!) as { run: { id: string } }).run.id;
        const fresh = !state.existing.has(id);
        state.existing.add(id);
        return {
          status: fresh ? 201 : 200,
          body: { data: { id, url: `https://harness.example.test/api/v1/reviews/runs/${id}`, artifacts_expected: ['report_json', 'report_md'] }, meta: { status: fresh ? 'created' : 'existing' } },
        };
      }
      if (request.method === 'PUT') {
        const kind = request.url.split('/').pop()!;
        const sha256 = createHash('sha256').update(request.body!, 'utf8').digest('hex');
        return { status: 201, body: { data: { kind, sha256 }, meta: { status: 'created' } } };
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/reviews/converge/events')) {
        const events = (JSON.parse(request.body!) as { events: Array<{ id: string }> }).events;
        const inserted = events.filter((e) => !state.existing.has(e.id)).length;
        for (const e of events) state.existing.add(e.id);
        return { status: 201, body: { data: { inserted, duplicates: events.length - inserted } } };
      }
      if (request.method === 'GET' && /\/api\/v1\/reviews\/runs\/[0-9a-f-]+$/.test(request.url)) {
        const id = request.url.split('/').pop()!;
        // The server holds every artifact except the one the test marks missing.
        const missing = state.missing ?? new Set<string>();
        return {
          status: 200,
          body: {
            data: {
              id,
              target: { kind: 'patch' },
              findings: [],
              calls: [],
              artifacts: [
                { kind: 'report_json', stored: !missing.has(`${id}:report_json`) },
                { kind: 'report_md', stored: !missing.has(`${id}:report_md`) },
              ],
            },
          },
        };
      }
      return { status: 404, body: { error: 'not_found', message: 'no' } };
    });
  }

describe('runBackfill', () => {
  it('posts every run, its artifacts and its verdicts once; a second run finds everything existing', async () => {
    const dir = corpus();
    const state = { existing: new Set<string>() };
    const first = server(state);
    const sink = new HarnessSink({ credential: CREDENTIAL, rclVersion: '3.1.0', fetchImpl: first.fetch });
    const summary = await runBackfill({ dir, repo: 'allocator-one/allocator-one', rclVersion: '3.1.0' }, { sink, host: 'harness.example.test' });

    expect(summary).toMatchObject({ runs: 2, created: 2, existing: 0, skipped: 1, artifacts: 3, planned: { artifacts: 3, events: 2, verdicts: 3 }, events: { inserted: 2, duplicates: 0 }, failed: [] });
    expect(first.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/reviews/runs'))).toHaveLength(2);
    expect(first.requests.filter((r) => r.method === 'PUT')).toHaveLength(3);
    const posted = JSON.parse(first.requests[0]!.body!) as { run: { provenance: string } };
    expect(posted.run.provenance).toBe('backfill');

    const second = server(state);
    const again = await runBackfill(
      { dir, repo: 'allocator-one/allocator-one', rclVersion: '3.1.0' },
      { sink: new HarnessSink({ credential: CREDENTIAL, rclVersion: '3.1.0', fetchImpl: second.fetch }), host: 'harness.example.test' }
    );
    expect(again).toMatchObject({ runs: 2, created: 0, existing: 2, artifacts: 0, events: { inserted: 0, duplicates: 2 } });
    // Already-recorded runs keep their artifacts: no report body moves twice.
    expect(second.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);

    // A run whose first upload was lost gets exactly that artifact on the next pass.
    const r1Id = (JSON.parse(first.requests[0]!.body!) as { run: { id: string } }).run.id;
    const healing = server({ existing: state.existing, missing: new Set([`${r1Id}:report_md`]) });
    const healed = await runBackfill(
      { dir, repo: 'allocator-one/allocator-one', rclVersion: '3.1.0' },
      { sink: new HarnessSink({ credential: CREDENTIAL, rclVersion: '3.1.0', fetchImpl: healing.fetch }), host: 'harness.example.test' }
    );
    expect(healed).toMatchObject({ existing: 2, artifacts: 1 });
    const puts = healing.requests.filter((r) => r.method === 'PUT');
    expect(puts.map((r) => r.url)).toEqual([`https://harness.example.test/api/v1/reviews/runs/${r1Id}/artifacts/report_md`]);
  });

  it('scrubs secrets from the report bytes it uploads, matches `report:` headings, and refuses implausible file times', async () => {
    const dir = corpus();
    const leaky = report(['anthropic/claude'], [{ file: 'lib/leak.ex', title: 'Token in code', models: ['anthropic/claude'] }]);
    (leaky.findings[0] as { description: string }).description = 'Authorization: Bearer ghp_' + 'A'.repeat(36);
    writeFileSync(join(dir, 'rcl-report-leak.json'), JSON.stringify(leaky));
    writeFileSync(join(dir, 'rcl-converge-leak-ledger.md'), '## Round 1 — report: rcl-report-leak.json — 1 finding\n- [fixed] lib/leak.ex — token in code\n');
    const old = report(['anthropic/claude'], []);
    writeFileSync(join(dir, 'rcl-report-old.json'), JSON.stringify(old));
    utimesSync(join(dir, 'rcl-report-old.json'), new Date('1999-01-01T00:00:00Z'), new Date('1999-01-01T00:00:00Z'));

    const built = await buildBackfillRuns({ dir, repo: 'allocator-one/allocator-one', host: 'harness.example.test', rclVersion: '3.1.0' });
    const leak = built.runs.find((r) => r.file === 'rcl-report-leak.json')!;
    expect(leak.artifacts.report_json).not.toContain('ghp_' + 'A'.repeat(36));
    expect(leak.artifacts.report_json).toContain('[redacted]');
    expect(leak.envelope.artifacts_declared[0]!.sha256).toBe(createHash('sha256').update(leak.artifacts.report_json, 'utf8').digest('hex'));
    expect(leak.events).toHaveLength(1);
    expect(built.skipped).toEqual(expect.arrayContaining([{ file: 'rcl-report-old.json', reason: expect.stringMatching(/plausible finishing time/) }]));

    // What is PUT is the scrubbed text, and its digest is the one the run declared.
    const state = { existing: new Set<string>() };
    const srv = server(state);
    await runBackfill({ dir, repo: 'allocator-one/allocator-one', rclVersion: '3.1.0' }, { sink: new HarnessSink({ credential: CREDENTIAL, rclVersion: '3.1.0', fetchImpl: srv.fetch }), host: 'harness.example.test' });
    const put = srv.requests.find((r) => r.method === 'PUT' && r.url.includes(leak.envelope.run.id) && r.url.endsWith('report_json'))!;
    expect(put.body).toContain('[redacted]');
    expect(put.body).not.toContain('ghp_' + 'A'.repeat(36));
    expect(createHash('sha256').update(put.body!, 'utf8').digest('hex')).toBe(leak.envelope.artifacts_declared[0]!.sha256);
  });

  it('sends one verdict per identity in a round and keeps NUL out of the text it synthesizes', async () => {
    const dir = corpus();
    writeFileSync(
      join(dir, 'rcl-converge-allocator-one-42-ledger.md'),
      [
        '## Round 1 — report /tmp/rcl-report-allocator-one-42-r1.json — 2 findings',
        '- [dismissed] lib/foo.ex — pagination misses tiebreak — first look',
        '- [fixed] lib/foo.ex — pagination misses tiebreak on inserted_at — second look, fixed after all',
        '',
      ].join('\n')
    );
    const nul = report(['anthropic/claude\u0000x'], [{ file: 'lib/nul.ex', title: 'Title with \u0000 NUL and \u0007 bell', models: ['anthropic/claude'] }]);
    writeFileSync(join(dir, 'rcl-report-nul.json'), JSON.stringify(nul));

    const built = await buildBackfillRuns({ dir, repo: 'allocator-one/allocator-one', host: 'harness.example.test', rclVersion: '3.1.0' });
    const r1 = built.runs.find((r) => r.file === 'rcl-report-allocator-one-42-r1.json')!;
    const verdicts = r1.events[0]!.payload['verdicts'] as Array<Record<string, unknown>>;
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ verdict: 'fixed' });

    const nulRun = built.runs.find((r) => r.file === 'rcl-report-nul.json')!;
    expect(JSON.stringify(nulRun.envelope)).not.toMatch(/\\u0000|\\u0007/);
    expect(nulRun.envelope.findings[0]!.title).toBe('Title with   NUL and   bell');
    expect(nulRun.envelope.run.roster).toEqual([]);
  });

  it('builds without posting in dry-run mode and reports a refused run without stopping the others', async () => {
    const dir = corpus();
    const dry = fakeFetch(() => ({ status: 500, body: {} }));
    const sink = new HarnessSink({ credential: CREDENTIAL, rclVersion: '3.1.0', fetchImpl: dry.fetch });
    const summary = await runBackfill({ dir, repo: 'allocator-one/allocator-one', rclVersion: '3.1.0', dryRun: true }, { sink, host: 'harness.example.test' });
    expect(summary).toMatchObject({ runs: 2, created: 0, existing: 0, dryRun: true, planned: { artifacts: 3, events: 2 }, host: 'harness.example.test', placeholderHost: false });
    expect(dry.requests).toHaveLength(0);

    // Without a credential a dry run still builds, says its host is a stand-in, and a real run refuses.
    const noCredential = await runBackfill({ dir, repo: 'allocator-one/allocator-one', rclVersion: '3.1.0', dryRun: true }, { host: 'no-credential', placeholderHost: true });
    expect(noCredential).toMatchObject({ runs: 2, placeholderHost: true });
    await expect(runBackfill({ dir, repo: 'allocator-one/allocator-one', rclVersion: '3.1.0' }, { host: 'no-credential' })).rejects.toThrow(/sink/);

    let calls = 0;
    const flaky = fakeFetch((request) => {
      if (request.method === 'POST' && request.url.endsWith('/reviews/runs')) {
        calls += 1;
        if (calls === 1) return { status: 422, body: { error: 'invalid', message: 'run.target.diff_sha256 is required' } };
        const id = (JSON.parse(request.body!) as { run: { id: string } }).run.id;
        return { status: 201, body: { data: { id, url: 'u', artifacts_expected: [] }, meta: { status: 'created' } } };
      }
      if (request.method === 'PUT') return { status: 201, body: { data: { kind: request.url.split('/').pop(), sha256: createHash('sha256').update(request.body!, 'utf8').digest('hex') }, meta: { status: 'created' } } };
      return { status: 201, body: { data: { inserted: 1, duplicates: 0 } } };
    });
    const partial = await runBackfill(
      { dir, repo: 'allocator-one/allocator-one', rclVersion: '3.1.0' },
      { sink: new HarnessSink({ credential: CREDENTIAL, rclVersion: '3.1.0', fetchImpl: flaky.fetch }), host: 'harness.example.test' }
    );
    expect(partial).toMatchObject({ runs: 2, created: 1 });
    expect(partial.failed).toEqual([{ file: 'rcl-report-allocator-one-42-r1.json', reason: expect.stringMatching(/422/) }]);
  });
});
