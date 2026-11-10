import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskFn } from '../../src/consensus/gating.js';
import type { ModelReview, ReviewResult } from '../../src/consensus/types.js';
import { renderReportArtifacts } from '../../src/output/artifacts.js';
import type { Diff } from '../../src/resolver/types.js';
import type { Role } from '../../src/roles/types.js';
import { assembleCompletedReview } from '../../src/report/assembly.js';
import type { RunHeader } from '../../src/report/run-header.js';
import { createTelemetryRuntime, deliverRun, flushOutbox } from '../../src/telemetry/deliver.js';
import { Outbox } from '../../src/telemetry/outbox.js';
import type { TelemetryLevel } from '../../src/telemetry/envelope.js';
import { fakeFetch, type RecordedRequest } from '../telemetry/fixtures.js';

/**
 * RCL-160 / RCL-167: a verified-consensus council whose whole verification
 * pass reaches its deadline, shaped like the refused allocator-one runs
 * (single-model important and critical claims, one cross-model finding, a
 * minor one), assembled exactly as `rcl review` assembles it and delivered
 * through the real envelope builder and validators to a mocked Harness.
 */
const role: Role = { name: 'general', systemPrompt: '', description: '', focus: [], isSpecialized: false };
const diff: Diff = {
  source: 'local',
  files: ['src/single.ts', 'src/agreed.ts', 'src/critical.ts', 'src/minor.ts'].map((filename) => ({
    filename, status: 'modified', language: 'typescript', additions: 1, deletions: 1,
    patch: '@@ -1 +1 @@\n-guard();\n+execute();',
  })),
};

function finding(file: string, severity: 'critical' | 'important' | 'minor', title: string) {
  return { id: `${file}:${title}`, file, startLine: 1, endLine: 1, title, description: `${title} in ${file}.`, severity, category: 'correctness' };
}

function reviews(): ModelReview[] {
  const review = (model: string, findings: ReturnType<typeof finding>[]): ModelReview =>
    ({ model, role: role.name, provider: 'openai', durationMs: 20, status: 'success', findings });
  return [
    review('openai/reviewer-a', [
      finding('src/single.ts', 'important', 'Guard bypassed'),
      finding('src/agreed.ts', 'important', 'Unchecked result'),
      finding('src/critical.ts', 'critical', 'Credential logged'),
    ]),
    review('openai/reviewer-b', [finding('src/agreed.ts', 'important', 'Unchecked result')]),
    review('openai/reviewer-c', [finding('src/minor.ts', 'minor', 'Misleading name')]),
  ];
}

async function failedVerificationReport(): Promise<ReviewResult & { run: RunHeader }> {
  const chunkReviews = reviews();
  // The verifier never answers and ignores cancellation: only the whole-pass deadline ends it.
  const ask = vi.fn<AskFn>(() => new Promise(() => {}));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-21T13:00:00.000Z'));
  const startTime = Date.now();
  const assembly = assembleCompletedReview({
    chunkReviews, arrivedAsync: [], asyncLaunched: 0, startTime,
    roleMap: new Map([[role.name, role]]), diff,
    config: { thresholds: { minConfidence: 0, minConsensusScore: 0 } },
    gatingConfig: {
      mode: 'verified-consensus', minModels: 2, verificationModel: 'openai/synthetic-verifier',
      verificationTimeoutMs: 60_000, verificationPassTimeoutMs: 100,
    },
    run: {
      id: '019a15eb-0000-7000-8000-000000000160', rclVersion: '4.5.18', command: 'review',
      target: { kind: 'patch', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
      roster: chunkReviews.map((r) => ({ model: r.model, role: role.name, provider: 'openai', lane: 'blocking' as const })),
      runner: { kind: 'agent', agent: 'synthetic-regression' }, startedAt: new Date(startTime),
      converge: { target: 'synthetic-rcl-160', round: 1, attempt: 1 },
    },
  }, { ask, monotonicNow: () => Date.now() - startTime, onWarning: () => {} });
  await vi.advanceTimersByTimeAsync(100);
  const result = await assembly;
  vi.useRealTimers();
  expect(ask).toHaveBeenCalledTimes(1);
  return result;
}

describe('a verified-consensus review whose verification pass fails (RCL-160)', () => {
  let repo: string;
  let dataDir: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'rcl-strict-fallback-repo-'));
    dataDir = await mkdtemp(join(tmpdir(), 'rcl-strict-fallback-data-'));
    await mkdir(join(repo, '.harness-cli'), { recursive: true });
    await writeFile(join(repo, '.harness-cli', 'config.json'), JSON.stringify({ team: 'RCL' }));
    await writeFile(join(repo, 'credentials.json'), JSON.stringify({ url: 'https://harness.example.test', token: 'aone_login' }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(repo, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Harness lists every declared kind; an organization that takes no reports answers the PUT with 403. */
  function harness(artifacts: 'accepted' | 'disabled' = 'accepted') {
    return (request: RecordedRequest): { status: number; body?: unknown } => {
      if (request.url.endsWith('/api/v1/reviews/runs')) {
        const envelope = JSON.parse(request.body!) as { run: { id: string } };
        return { status: 201, body: { data: { id: envelope.run.id, url: `https://harness.example.test/runs/${envelope.run.id}`,
          artifacts_expected: ['report_json', 'report_md'] }, meta: { status: 'created' } } };
      }
      if (request.url.includes('/artifacts/') && artifacts === 'disabled') {
        return { status: 403, body: { error: 'artifacts_disabled', message: 'Full reports are off for this organization' } };
      }
      if (request.url.includes('/artifacts/')) {
        const kind = request.url.slice(request.url.lastIndexOf('/') + 1);
        return { status: 201, body: { data: { kind, sha256: createHash('sha256').update(request.body ?? '', 'utf8').digest('hex') } } };
      }
      return { status: 404, body: { error: 'not_found' } };
    };
  }

  async function runtime(handler: Parameters<typeof fakeFetch>[0], level?: TelemetryLevel) {
    const { fetch, requests } = fakeFetch(handler);
    const rt = await createTelemetryRuntime({
      rclVersion: '4.5.18', env: level ? { RCL_TELEMETRY: level } : {}, cwd: repo, dataDir,
      credentialsPath: join(repo, 'credentials.json'), fetchImpl: fetch, stderr: () => {},
    });
    return { rt, requests };
  }

  it('declares the strict fallback, labels every finding, and keeps the conservative CI verdict', async () => {
    const result = await failedVerificationReport();

    expect(result.run.gating).toMatchObject({ mode: 'verified-consensus', strict_fallback: { version: 1, cause: 'verification_pass_timeout' } });
    expect(result.run.ci_exit_code).toBe(1);
    expect(result.stats.verification).toBeUndefined();
    const labels = Object.fromEntries(result.findings.map((f) => [f.file, f.gating]));
    const blocker = { reason: 'strict_fallback', verification: { model: 'openai/synthetic-verifier', verdict: 'unavailable', note: expect.any(String) } };
    expect(labels).toEqual({
      'src/single.ts': blocker, 'src/agreed.ts': blocker, 'src/critical.ts': blocker, 'src/minor.ts': { reason: 'none' },
    });
    expect(renderReportArtifacts(result).report_md).toMatch(/3 finding\(s\) block convergence \(3 strict fallback/);
  });

  it('delivers that report as Harness accepts a strict fallback, with its report_json as the receipt', async () => {
    const result = await failedVerificationReport();
    const artifacts = renderReportArtifacts(result);
    const { rt, requests } = await runtime(harness());

    expect(await deliverRun(rt, { result, artifacts, evidenceRequired: true })).toMatchObject({ status: 'recorded', exitCode: 0 });

    const envelope = JSON.parse(requests.find((r) => r.url.endsWith('/api/v1/reviews/runs'))!.body!);
    expect(envelope.run.gating.strict_fallback).toEqual({ version: 1, cause: 'verification_pass_timeout' });
    expect(envelope.run.ci_exit_code).toBeGreaterThan(0);
    expect(envelope.stats).not.toHaveProperty('verification');
    for (const row of envelope.findings) {
      if (['critical', 'important'].includes(row.severity) && !row.below_threshold) {
        expect(row).toMatchObject({ gating_reason: 'strict_fallback', verification_verdict: 'unavailable' });
      } else {
        expect(row.gating_reason).toBe('none');
        expect(row).not.toHaveProperty('verification_verdict');
      }
    }
    expect(envelope.findings.filter((row: { gating_reason: string }) => row.gating_reason === 'strict_fallback')).toHaveLength(3);
    const upload = requests.find((r) => r.url.endsWith('/artifacts/report_json'));
    expect(upload?.body).toBe(artifacts.report_json);
  });

  it('does not report the run complete when the organization takes no report_json, which a fallback needs to count', async () => {
    const result = await failedVerificationReport();
    const { rt } = await runtime(harness('disabled'));

    const outcome = await deliverRun(rt, { result, artifacts: renderReportArtifacts(result), evidenceRequired: true });

    expect(outcome).toMatchObject({ status: 'recorded', exitCode: 4 });
    expect(outcome.line).toMatch(/strict fallback counts only with its report_json/);
  });

  it('does not flush a spooled fallback as delivered when the organization refuses its report_json', async () => {
    const result = await failedVerificationReport();
    const down = await runtime(() => new TypeError('fetch failed'));
    expect(await deliverRun(down.rt, { result, artifacts: renderReportArtifacts(result), evidenceRequired: true }))
      .toMatchObject({ status: 'spooled', exitCode: 4 });

    const { rt } = await runtime(harness('disabled'));
    const summary = await flushOutbox(rt);

    expect(summary.delivered).toEqual([]);
    expect(summary.failed).toEqual([{ id: result.run.id, reason: expect.stringMatching(/strict fallback counts only with its report_json/) }]);
  });

  it('does not flush a fallback whose report_json the outbox dropped over its cap', async () => {
    const result = await failedVerificationReport();
    const artifacts = renderReportArtifacts(result);
    const down = await runtime(() => new TypeError('fetch failed'));
    down.rt.outbox = new Outbox(join(dataDir, 'outbox'), { capBytes: Buffer.byteLength(artifacts.report_json) - 1 });
    const spooled = await deliverRun(down.rt, { result, artifacts, evidenceRequired: true });
    expect(spooled).toMatchObject({ status: 'spooled', exitCode: 4 });

    const { rt, requests } = await runtime(harness());
    const summary = await flushOutbox(rt);

    expect(summary.delivered).toEqual([]);
    expect(summary.failed).toEqual([{ id: result.run.id, reason: expect.stringMatching(/strict fallback counts only with its report_json/) }]);
    expect(requests.some((r) => r.url.endsWith('/api/v1/reviews/runs'))).toBe(false);
  });

  it.each<TelemetryLevel>(['envelope', 'findings'])('refuses it locally at telemetry level %s, which never sends the report', async (level) => {
    const result = await failedVerificationReport();
    const { rt, requests } = await runtime(harness(), level);

    const outcome = await deliverRun(rt, { result, artifacts: renderReportArtifacts(result), evidenceRequired: true });

    expect(outcome).toMatchObject({ status: 'rejected', exitCode: 4, failureDisposition: 'local-invalid' });
    expect(outcome.line).toMatch(/strict fallback .*telemetry level full/);
    expect(requests).toEqual([]);
  });

  it('still refuses unlabelled verified-consensus findings', async () => {
    const result = await failedVerificationReport();
    delete result.run.gating.strict_fallback;
    for (const f of result.findings) delete f.gating;
    const { rt, requests } = await runtime(harness());

    const outcome = await deliverRun(rt, { result, artifacts: renderReportArtifacts(result), evidenceRequired: true });

    expect(outcome).toMatchObject({ status: 'rejected', exitCode: 4 });
    expect(outcome.line).toMatch(/missing a valid gating label/);
    expect(requests).toEqual([]);
  });
});
