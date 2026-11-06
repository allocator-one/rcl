import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTelemetryRuntime, deliverRun } from '../../src/telemetry/deliver.js';
import type { GatingReason, GatingVerification } from '../../src/consensus/gating.js';
import { fakeFetch, sampleFinding, sampleResult } from './fixtures.js';

type Verdict = GatingVerification['verdict'];

/**
 * RCL-228: since RCL-198 the verifier also judges critical and consensus
 * findings. Only a refutation removes the tier they earned; any other verdict
 * keeps it. The report validator must accept exactly what the gate builds.
 */
describe('verification verdicts on critical and consensus findings', () => {
  let dataDir: string;
  beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'rcl-verdicts-')); });
  afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

  async function deliver(reason: GatingReason, verdict: Verdict | undefined, severity: 'critical' | 'important' = 'important') {
    const { fetch } = fakeFetch(() => ({ status: 201, body: {} }));
    const rt = await createTelemetryRuntime({
      rclVersion: '4.5.23', env: {}, config: {} as never, dataDir,
      credential: { url: 'https://harness.example.test', token: 'aone_SECRET_DO_NOT_RETAIN', source: 'login' },
      fetchImpl: fetch, stderr: () => {},
    });
    const result = sampleResult();
    result.findings = [sampleFinding({ severity, gating: { reason,
      ...(verdict ? { verification: { model: 'openai/gpt-6-astra', verdict, note: 'Checked against the change.' } } : {}) } })];
    result.belowThresholdFindings = [];
    result.stats = { ...result.stats, totalDeduped: 1, belowThreshold: 0,
      ...(verdict ? { verification: { model: 'openai/gpt-6-astra', candidates: 1, refuted: verdict === 'refuted' ? 1 : 0,
        unrefuted: 0, unavailable: verdict === 'unavailable' ? 1 : 0, durationMs: 100 } } : {}) } as typeof result.stats;
    const artifacts = { report_json: JSON.stringify(result, null, 2) + '\n', report_md: '# Report\n' };
    return deliverRun(rt, { result, artifacts, evidenceRequired: true });
  }

  const earned: Array<[GatingReason, 'critical' | 'important']> = [['consensus', 'important'], ['critical', 'critical']];

  it.each(earned.flatMap(([reason, severity]) =>
    (['confirmed', 'insufficient_evidence', 'unavailable'] as const).map(verdict => [reason, severity, verdict] as const),
  ))('accepts a %s finding at severity %s whose verification is %s', async (reason, severity, verdict) => {
    const outcome = await deliver(reason, verdict, severity);
    expect(outcome.line).not.toContain('refused locally');
  });

  it.each(earned)('accepts a %s finding that was not verified', async (reason, severity) => {
    const outcome = await deliver(reason, undefined, severity);
    expect(outcome.line).not.toContain('refused locally');
  });

  it.each(earned)('refuses a %s finding whose verification refuted it, because a refutation removes the tier', async (reason, severity) => {
    const outcome = await deliver(reason, 'refuted', severity);
    expect(outcome).toMatchObject({ status: 'rejected', exitCode: 4 });
    expect(outcome.line).toContain('refused locally');
    expect(outcome.line).toContain(`contradicts the ${reason} gating reason`);
  });
});
