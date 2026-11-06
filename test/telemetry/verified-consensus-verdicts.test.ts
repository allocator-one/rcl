import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTelemetryRuntime, deliverRun } from '../../src/telemetry/deliver.js';
import { applyGating, type GatingVerification } from '../../src/consensus/gating.js';
import type { ConsensusFinding, ReviewResult } from '../../src/consensus/types.js';
import type { ModelAnswer } from '../../src/dispatch/adapter.js';
import { fakeFetch, sampleFinding, sampleResult, type RecordedRequest } from './fixtures.js';

type Verdict = Exclude<GatingVerification['verdict'], 'unrefuted'>;
type Earned = 'consensus' | 'critical';

const VERIFIER = 'openai/gpt-6-astra';

function answer(text: string): ModelAnswer {
  return { model: VERIFIER, provider: 'openai', text, durationMs: 5, status: 'success' };
}

const answers: Record<Verdict, ModelAnswer> = {
  confirmed: answer(JSON.stringify([{ id: 'F1', verdict: 'confirmed', reason: 'The constant is wrong.',
    failureMechanism: 'The incorrect constant propagates to callers.', evidence: [{ file: 'src/a.ts', quote: 'const x = 1;' }] }])),
  insufficient_evidence: answer(JSON.stringify([{ id: 'F1', verdict: 'insufficient_evidence', reason: 'The caller is not shown.' }])),
  refuted: answer(JSON.stringify([{ id: 'F1', verdict: 'refuted', reason: 'The guard exists.' }])),
  unavailable: { ...answer(''), status: 'error', error: 'verifier unreachable' },
};

const tiers: Record<Earned, ConsensusFinding> = {
  consensus: sampleFinding({ severity: 'important', file: 'src/a.ts',
    consensus: { ...sampleFinding().consensus!, models: ['m1', 'm2'], crossModel: true } }),
  critical: sampleFinding({ severity: 'critical', file: 'src/a.ts',
    consensus: { ...sampleFinding().consensus!, models: ['m1'], crossModel: false } }),
};

function acceptEverything(request: RecordedRequest): { status: number; body?: unknown } {
  if (request.url.endsWith('/api/v1/reviews/runs')) {
    const { run } = JSON.parse(request.body!) as { run: { id: string } };
    return { status: 201, body: { data: { id: run.id, url: `https://harness.example.test/api/v1/reviews/runs/${run.id}`,
      artifacts_expected: ['report_json', 'report_md'] }, meta: { status: 'created' } } };
  }
  const kind = request.url.slice(request.url.lastIndexOf('/') + 1);
  return { status: 201, body: { data: { kind, sha256: createHash('sha256').update(request.body ?? '', 'utf8').digest('hex') } } };
}

/**
 * RCL-228: since RCL-198 the verifier also judges critical and consensus
 * findings. Only a refutation removes the tier they earned; any other verdict
 * keeps it. The report validator must accept exactly what the gate builds, so
 * the reports below come out of the real gate.
 */
describe('verification verdicts on critical and consensus findings', () => {
  let dataDir: string;
  beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'rcl-verdicts-')); });
  afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

  async function deliver(findings: ConsensusFinding[], verification?: ReviewResult['stats']['verification']) {
    const { fetch } = fakeFetch(acceptEverything);
    const rt = await createTelemetryRuntime({
      rclVersion: '4.5.23', env: {}, config: {} as never, dataDir,
      credential: { url: 'https://harness.example.test', token: 'aone_SECRET_DO_NOT_RETAIN', source: 'login' },
      fetchImpl: fetch, stderr: () => {},
    });
    const result = sampleResult();
    result.findings = findings;
    result.belowThresholdFindings = [];
    result.stats = { ...result.stats, totalDeduped: 1, belowThreshold: 0, ...(verification ? { verification } : {}) };
    const artifacts = { report_json: JSON.stringify(result, null, 2) + '\n', report_md: '# Report\n' };
    return deliverRun(rt, { result, artifacts, evidenceRequired: true });
  }

  /** Build the report with the production gate, then deliver it to the report validator. */
  async function gateAndDeliver(tier: Earned, verifier: boolean, verdict?: Verdict) {
    const gated = await applyGating([structuredClone(tiers[tier])], {
      minModels: 2, verificationTimeoutMs: 60_000,
      verificationModel: verifier ? VERIFIER : undefined,
      ask: async () => answers[verdict!],
      diffFiles: [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+const x = 1;', language: 'ts' }],
    });
    return { gating: gated.findings[0]!.gating, outcome: await deliver(gated.findings, gated.verification) };
  }

  const keptTier = (['consensus', 'critical'] as const).flatMap(tier =>
    (['confirmed', 'insufficient_evidence', 'unavailable'] as const).map(verdict => [tier, verdict] as const));

  it.each(keptTier)('keeps a %s finding gating and delivers its report when verification is %s', async (tier, verdict) => {
    const { gating, outcome } = await gateAndDeliver(tier, true, verdict);
    expect(gating).toMatchObject({ reason: tier, verification: { verdict } });
    expect(outcome).toMatchObject({ status: 'recorded', exitCode: 0 });
  });

  it.each(['consensus', 'critical'] as const)('delivers the report of a %s finding that was never sent to a verifier', async tier => {
    const { gating, outcome } = await gateAndDeliver(tier, false);
    expect(gating).toMatchObject({ reason: tier });
    expect(outcome).toMatchObject({ status: 'recorded', exitCode: 0 });
  });

  it.each(['consensus', 'critical'] as const)('drops the %s tier on a refutation and delivers the report', async tier => {
    const { gating, outcome } = await gateAndDeliver(tier, true, 'refuted');
    expect(gating).toMatchObject({ reason: 'none', verification: { verdict: 'refuted' } });
    expect(outcome).toMatchObject({ status: 'recorded', exitCode: 0 });
  });

  it.each([['consensus', 'important'], ['critical', 'critical']] as const)(
    'refuses a %s finding whose refuted verification kept the tier, because the gate removes it', async (reason, severity) => {
      const outcome = await deliver([sampleFinding({ severity, gating: { reason,
        verification: { model: VERIFIER, verdict: 'refuted', note: 'Checked against the change.' } } })],
      { model: VERIFIER, candidates: 1, refuted: 1, unrefuted: 0, unavailable: 0, durationMs: 100 });
      expect(outcome).toMatchObject({ status: 'rejected', exitCode: 4 });
      expect(outcome.line).toContain(`contradicts the ${reason} gating reason`);
    });
});
