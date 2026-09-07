import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTelemetryRuntime,
  deliverRun,
  emitConvergeEvents,
  EVIDENCE_REQUIRED_EXIT_CODE,
  flushOutboxAtStart,
  resolveTelemetryLevel,
} from '../../src/telemetry/deliver.js';
import { buildEvent } from '../../src/telemetry/events.js';
import { NOTICE_FILE } from '../../src/telemetry/notice.js';
import { fakeFetch, sampleResult, type RecordedRequest } from './fixtures.js';

const ARTIFACTS = { report_json: '{"r":1}', report_md: '# r' };

function acceptEverything(request: RecordedRequest): { status: number; body?: unknown } {
  if (request.url.endsWith('/api/v1/reviews/runs')) {
    const envelope = JSON.parse(request.body!) as { run: { id: string } };
    return {
      status: 201,
      body: { data: { id: envelope.run.id, url: `https://harness.example.test/api/v1/reviews/runs/${envelope.run.id}`, artifacts_expected: ['report_json', 'report_md'] }, meta: { status: 'created' } },
    };
  }
  if (request.url.includes('/artifacts/')) return { status: 201, body: { data: { kind: 'report_json', sha256: 'x' } } };
  if (request.url.endsWith('/converge/events')) return { status: 201, body: { data: { inserted: 1, duplicates: 0 } } };
  return { status: 404, body: { error: 'not_found' } };
}

describe('telemetry delivery', () => {
  let repo: string;
  let dataDir: string;
  let credentialsPath: string;
  let lines: string[];

  async function runtime(handler: Parameters<typeof fakeFetch>[0], extra: Parameters<typeof createTelemetryRuntime>[0] extends infer O ? Partial<O> : never = {}) {
    const { fetch, requests } = fakeFetch(handler);
    const rt = await createTelemetryRuntime({
      rclVersion: '3.0.0',
      env: {},
      cwd: repo,
      dataDir,
      credentialsPath,
      fetchImpl: fetch,
      stderr: (line) => lines.push(line),
      ...extra,
    });
    return { rt, requests };
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'rcl-deliver-repo-'));
    dataDir = await mkdtemp(join(tmpdir(), 'rcl-deliver-data-'));
    await mkdir(join(repo, '.harness-cli'), { recursive: true });
    await writeFile(join(repo, '.harness-cli', 'config.json'), JSON.stringify({ team: 'RCL' }));
    credentialsPath = join(repo, 'credentials.json');
    await writeFile(credentialsPath, JSON.stringify({ url: 'https://harness.example.test', token: 'aone_login' }));
    lines = [];
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('resolveTelemetryLevel', () => {
    it('defaults to full; config, RCL_TELEMETRY=off and --no-telemetry override in that order of strength', () => {
      expect(resolveTelemetryLevel(undefined, {}, {})).toBe('full');
      expect(resolveTelemetryLevel({ harness: { telemetry: 'findings' } }, {}, {})).toBe('findings');
      expect(resolveTelemetryLevel({ harness: { telemetry: 'full' } }, {}, { RCL_TELEMETRY: 'off' })).toBe('off');
      expect(resolveTelemetryLevel({ harness: { telemetry: 'full' } }, { noTelemetry: true }, {})).toBe('off');
    });
  });

  it('records a run: envelope, both artifacts, the notice once, and the status line', async () => {
    const { rt, requests } = await runtime(acceptEverything);
    const result = sampleResult();
    const outcome = await deliverRun(rt, { result, artifacts: ARTIFACTS });

    expect(outcome.status).toBe('recorded');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.line).toBe(`Evidence recorded: https://harness.example.test/api/v1/reviews/runs/${result.run!.id}`);
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'POST /api/v1/reviews/runs',
      `PUT /api/v1/reviews/runs/${result.run!.id}/artifacts/report_json`,
      `PUT /api/v1/reviews/runs/${result.run!.id}/artifacts/report_md`,
    ]);
    expect(requests[1]!.body).toBe(ARTIFACTS.report_json);
    expect(lines.join('\n')).toContain('records evidence of this review on harness.example.test');
    expect(JSON.parse(await readFile(join(dataDir, NOTICE_FILE), 'utf8')).shown['harness.example.test']).toBeDefined();

    lines = [];
    await deliverRun(rt, { result: sampleResult(), artifacts: ARTIFACTS });
    expect(lines).toEqual([]);
  });

  it('uploads no artifacts at the findings level and none of the report rows at envelope level', async () => {
    const { rt, requests } = await runtime(acceptEverything, { config: { harness: { telemetry: 'findings' } } });
    await deliverRun(rt, { result: sampleResult(), artifacts: ARTIFACTS });
    expect(requests).toHaveLength(1);
    const posted = JSON.parse(requests[0]!.body!) as { findings: unknown[]; calls: unknown[]; artifacts_declared: unknown[] };
    expect(posted.findings).toHaveLength(2);
    expect(posted.artifacts_declared).toHaveLength(2);

    const envelopeOnly = await runtime(acceptEverything, { config: { harness: { telemetry: 'envelope' } } });
    await deliverRun(envelopeOnly.rt, { result: sampleResult(), artifacts: ARTIFACTS });
    expect((JSON.parse(envelopeOnly.requests[0]!.body!) as { findings: unknown[] }).findings).toEqual([]);
  });

  it('spools when Harness is unreachable and exits 4 under --evidence-required; a later flush delivers it as retried', async () => {
    const down = await runtime(() => new TypeError('fetch failed'));
    const result = sampleResult();
    const outcome = await deliverRun(down.rt, { result, artifacts: ARTIFACTS, evidenceRequired: true });
    expect(outcome.status).toBe('spooled');
    expect(outcome.exitCode).toBe(EVIDENCE_REQUIRED_EXIT_CODE);
    expect(outcome.line).toMatch(/^Evidence spooled \(Harness unreachable: TypeError: fetch failed\); run rcl telemetry flush/);
    expect((await down.rt.outbox.list()).map((e) => e.id)).toEqual([result.run!.id]);

    const up = await runtime(acceptEverything);
    const summary = await up.rt.outbox.flush(up.rt.sink!);
    expect(summary.delivered).toEqual([result.run!.id]);
    const retried = JSON.parse(up.requests[0]!.body!) as { run: { id: string }; delivery: { mode: string; spooled_at?: string } };
    expect(retried.run.id).toBe(result.run!.id);
    expect(retried.delivery.mode).toBe('retried');
    expect(retried.delivery.spooled_at).toBeDefined();
  });

  it('flushes at command start, bounded, and says how many it delivered', async () => {
    const down = await runtime(() => new TypeError('fetch failed'));
    await deliverRun(down.rt, { result: sampleResult(), artifacts: ARTIFACTS });
    lines = [];
    const up = await runtime(acceptEverything);
    await flushOutboxAtStart(up.rt, 5_000);
    expect(lines).toEqual(['Delivered 1 spooled evidence entry to harness.example.test.']);
    expect(await up.rt.outbox.list()).toEqual([]);
  });

  it('reports an org that has not enabled evidence without spooling', async () => {
    const { rt } = await runtime(() => ({ status: 403, body: { error: 'reviews_disabled', message: 'off' } }));
    const outcome = await deliverRun(rt, { result: sampleResult(), artifacts: ARTIFACTS, evidenceRequired: true });
    expect(outcome.status).toBe('disabled');
    expect(outcome.line).toBe('Evidence not sent: harness.example.test has not enabled review evidence for this organization');
    expect(outcome.exitCode).toBe(EVIDENCE_REQUIRED_EXIT_CODE);
    expect(await rt.outbox.list()).toEqual([]);
  });

  it('accepts an org that caps artifacts, and does not spool a refused digest', async () => {
    const capped = await runtime((request) =>
      request.url.includes('/artifacts/') ? { status: 403, body: { error: 'artifacts_disabled', message: 'capped' } } : acceptEverything(request)
    );
    const outcome = await deliverRun(capped.rt, { result: sampleResult(), artifacts: ARTIFACTS });
    expect(outcome.status).toBe('recorded');
    expect(outcome.line).toContain('artifacts capped by the organization');
    expect(await capped.rt.outbox.list()).toEqual([]);
  });

  it('is off outside a Harness-managed repository and says why when there is no login', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'rcl-deliver-plain-'));
    try {
      const { rt } = await runtime(acceptEverything, { cwd: plain });
      expect(rt.level).toBe('off');
      expect(await deliverRun(rt, { result: sampleResult(), artifacts: ARTIFACTS })).toMatchObject({ status: 'off', line: '' });
    } finally {
      await rm(plain, { recursive: true, force: true });
    }

    const noLogin = await runtime(acceptEverything, { credentialsPath: join(repo, 'missing.json') });
    const outcome = await deliverRun(noLogin.rt, { result: sampleResult(), artifacts: ARTIFACTS });
    expect(outcome).toMatchObject({ status: 'skipped', spooled: false, exitCode: 0 });
    expect(outcome.line).toMatch(/^Evidence not sent: not logged in to Harness/);
    expect(await noLogin.rt.outbox.list()).toEqual([]);
  });

  it('spools an evidence-required run when no credential is available, and says so when telemetry is off', async () => {
    const noLogin = await runtime(acceptEverything, { credentialsPath: join(repo, 'missing.json') });
    const result = sampleResult();
    const outcome = await deliverRun(noLogin.rt, { result, artifacts: ARTIFACTS, evidenceRequired: true });
    expect(outcome).toMatchObject({ status: 'skipped', spooled: true, exitCode: EVIDENCE_REQUIRED_EXIT_CODE });
    expect(outcome.line).toMatch(/^Evidence spooled \(not logged in to Harness/);
    expect((await noLogin.rt.outbox.list()).map((e) => e.id)).toEqual([result.run!.id]);

    const off = await runtime(acceptEverything, { noTelemetry: true });
    expect(await deliverRun(off.rt, { result: sampleResult(), artifacts: ARTIFACTS, evidenceRequired: true })).toMatchObject({
      status: 'off',
      line: 'Evidence not sent: telemetry is off, or this repository is not Harness-managed',
      exitCode: EVIDENCE_REQUIRED_EXIT_CODE,
    });
  });

  it('reads the harness section of the project config when none is passed, and serves the outbox from anywhere on request', async () => {
    await writeFile(join(repo, '.review-council.yml'), 'harness:\n  telemetry: off\n', 'utf8');
    const configured = await runtime(acceptEverything);
    expect(configured.rt.level).toBe('off');

    await writeFile(join(repo, '.review-council.yml'), 'harness:\n  telemetry: findings\n  parseFailures: true\n', 'utf8');
    const findings = await runtime(acceptEverything);
    expect(findings.rt.level).toBe('findings');
    expect(findings.rt.parseFailures).toBe(true);

    const plain = await mkdtemp(join(tmpdir(), 'rcl-deliver-anywhere-'));
    try {
      const anywhere = await runtime(acceptEverything, { cwd: plain, requireRepo: false });
      expect(anywhere.rt.sink).toBeDefined();
      expect(anywhere.rt.credential?.source).toBe('login');
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('spools the remaining artifacts as soon as one upload finds the server gone', async () => {
    let puts = 0;
    const flaky = await runtime((request) => {
      if (request.url.includes('/artifacts/')) {
        puts += 1;
        return new TypeError('fetch failed');
      }
      return acceptEverything(request);
    });
    const outcome = await deliverRun(flaky.rt, { result: sampleResult(), artifacts: ARTIFACTS });
    expect(outcome.status).toBe('recorded');
    expect(outcome.spooled).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.line).toContain('artifacts spooled; run rcl telemetry flush');
    expect(puts).toBe(1);
    expect((await flaky.rt.outbox.list())[0]).toMatchObject({ artifacts: ['report_json', 'report_md'], meta: { envelope_delivered: true } });
  });

  it('treats a recorded run with an artifact still outstanding as incomplete evidence under --evidence-required', async () => {
    const refuseMarkdown = (request: RecordedRequest) =>
      request.url.endsWith('/artifacts/report_md') ? { status: 422, body: { error: 'validation_error', message: 'digest mismatch' } } : acceptEverything(request);
    const refusing = await runtime(refuseMarkdown);
    const refused = await deliverRun(refusing.rt, { result: sampleResult(), artifacts: ARTIFACTS, evidenceRequired: true });
    expect(refused).toMatchObject({ status: 'recorded', spooled: false, exitCode: EVIDENCE_REQUIRED_EXIT_CODE });
    expect(refused.line).toContain('report_md refused');
    // A refusal is final: nothing is spooled for it.
    expect(await refusing.rt.outbox.list()).toEqual([]);

    // Without the flag the run counts as recorded either way.
    const relaxed = await runtime(refuseMarkdown);
    expect((await deliverRun(relaxed.rt, { result: sampleResult(), artifacts: ARTIFACTS })).exitCode).toBe(0);

    const flaky = await runtime((request) => (request.url.includes('/artifacts/') ? new TypeError('fetch failed') : acceptEverything(request)));
    const spooled = await deliverRun(flaky.rt, { result: sampleResult(), artifacts: ARTIFACTS, evidenceRequired: true });
    expect(spooled).toMatchObject({ status: 'recorded', spooled: true, exitCode: EVIDENCE_REQUIRED_EXIT_CODE });
    expect((await flaky.rt.outbox.list()).map((e) => e.id)).toEqual([spooled.runId]);
  });

  it('emits converge events, spooling them when unreachable and skipping undeliverable ones', async () => {
    const up = await runtime(acceptEverything);
    const events = [
      buildEvent({ kind: 'attempt_claimed', convergeTarget: 't', attempt: 1, payload: { cap: 20 } }),
      buildEvent({ kind: 'verdicts_recorded', convergeTarget: 't', round: 1, payload: { verdicts: [] } }), // no run id: not deliverable
    ];
    expect(await emitConvergeEvents(up.rt, events)).toBe('sent');
    expect((JSON.parse(up.requests[0]!.body!) as { events: unknown[] }).events).toHaveLength(1);
    // The consent notice precedes the first transmission of any kind.
    expect(lines.join('\n')).toContain('records evidence of this review on harness.example.test');

    const down = await runtime(() => new TypeError('fetch failed'));
    expect(await emitConvergeEvents(down.rt, [events[0]!])).toBe('spooled');
    expect((await down.rt.outbox.list())[0]!.events).toBe(1);
  });
});
