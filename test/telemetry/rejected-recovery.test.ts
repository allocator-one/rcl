import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleFinding, sampleResult, sampleReview, sampleRunHeader } from './fixtures.js';
import { buildRunEnvelope, sha256Hex, type RunEnvelope } from '../../src/telemetry/envelope.js';
import { validateRunEnvelope } from '../../src/telemetry/envelope-validation.js';
import { Quarantine } from '../../src/telemetry/quarantine.js';
import {
  applyRejectedEvidenceRecovery,
  planRejectedEvidenceRecovery,
  type RejectedRecoveryManifest,
  type RejectedRecoverySink,
} from '../../src/telemetry/rejected-recovery.js';

const RUN_ID = '01a0ee2a-d7b2-7062-bf75-51780915dd8b';
const ORG_ID = '019921a0-0000-7000-8000-000000000099';

function original() {
  const important = sampleFinding({ id: 'F1', identity: 'a'.repeat(16), severity: 'important', gating: undefined });
  const critical = sampleFinding({ id: 'F2', identity: 'b'.repeat(16), severity: 'critical', gating: undefined });
  const minor = sampleFinding({ id: 'F3', identity: 'c'.repeat(16), severity: 'minor', gating: undefined });
  const below = sampleFinding({ id: 'F4', identity: 'd'.repeat(16), severity: 'important', gating: undefined });
  const reviews = [
    sampleReview({ model: 'model-a', role: 'general', provider: 'openai', status: 'success' }),
    sampleReview({ model: 'model-b', role: 'general', provider: 'anthropic', status: 'success' }),
  ];
  const result = sampleResult({
    run: sampleRunHeader({
      id: RUN_ID,
      rcl_version: '4.4.7',
      target: {
        kind: 'patch', repo: 'allocator-one/allocator-one', pr_number: 9356,
        url: 'https://github.com/allocator-one/allocator-one/pull/9356',
        head_sha: '7'.repeat(40), base_sha: '1'.repeat(40), diff_sha256: '8'.repeat(64),
        files: 160, additions: 30_439, deletions: 291,
      },
      roster: reviews.map((review) => ({ model: review.model, role: review.role, provider: review.provider, lane: 'blocking' as const })),
      converge: { target: 'allocator-one-9356', round: 5, attempt: 11 },
    }),
    reviews,
    findings: [important, critical, minor],
    belowThresholdFindings: [below],
    stats: {
      totalReviews: 2, successfulReviews: 2, totalRawFindings: 4, totalDeduped: 4,
      belowThreshold: 1, durationMs: 10,
      blockingHealth: {
        version: 1, fraction: 2 / 3, seats: 2, required: 2, successful: 2, conclusive: true,
        excludedSuccesses: { secondary: 0, async: 0, verification: 0 },
      },
    },
  });
  const artifacts = { report_json: JSON.stringify(result), report_md: '# Original report\n' };
  const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' } });
  return { result, artifacts, envelope };
}

async function retain(store: Quarantine, mutate?: (input: ReturnType<typeof original>) => void) {
  const input = original();
  mutate?.(input);
  const outcome = await store.retain({
    runId: RUN_ID,
    artifacts: input.artifacts,
    envelope: input.envelope,
    events: [],
    requestedMode: 'asserted',
    acknowledged: false,
    diagnostics: [{ path: 'findings.0.gating.reason', message: 'Verified-consensus finding is missing a valid gating label' }],
  });
  expect(outcome.status).toBe('complete');
  return input;
}

function capabilitySink(overrides: Partial<RejectedRecoverySink> = {}): RejectedRecoverySink {
  return {
    baseUrl: 'https://harness.example.test',
    checkSeverityFallbackRecovery: vi.fn(async () => ({ kind: 'ok', httpStatus: 200, value: { protocol: 1 as const, orgId: ORG_ID } })),
    getRun: vi.fn(async () => ({ kind: 'rejected', httpStatus: 404, error: 'not_found', message: 'not found' })),
    postRun: vi.fn(async (envelope: RunEnvelope) => ({
      kind: 'ok', httpStatus: 201,
      value: { id: envelope.run.id, url: `https://harness.example.test/runs/${envelope.run.id}`, artifacts_expected: ['report_json', 'report_md'], status: 'created' as const },
    })),
    putArtifact: vi.fn(async (_run, kind, bytes) => ({ kind: 'ok', httpStatus: 201, value: { kind, sha256: sha256Hex(bytes), status: 'created' as const } })),
    getArtifact: vi.fn(async (_run, _kind, _limit) => ({ kind: 'rejected', httpStatus: 404, error: 'not_found', message: 'not found' })),
    ...overrides,
  };
}

describe('rejected verified-consensus severity fallback recovery', () => {
  let root: string;
  let store: Quarantine;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rcl-rejected-recovery-'));
    store = new Quarantine(join(root, 'quarantine'));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('derives one deterministic source-bound envelope without changing original bytes or native identity', async () => {
    const source = await retain(store);
    const sink = capabilitySink();
    const manifest = await planRejectedEvidenceRecovery(store, RUN_ID, sink);

    expect(manifest).toMatchObject({
      kind: 'rcl-rejected-evidence-recovery', version: 1,
      destination: { base_url: sink.baseUrl, org_id: ORG_ID, protocol: 1 },
      source: {
        run_id: RUN_ID, rcl_version: '4.4.7', requested_mode: 'asserted',
        report_sha256: sha256Hex(source.artifacts.report_json),
        envelope_sha256: sha256Hex(JSON.stringify(source.envelope)),
        converge: { target: 'allocator-one-9356', round: 5, attempt: 11 },
        reviewer_calls: 2,
      },
      recovery: { reason: 'severity-fallback', algorithm_version: 1, actionable_findings: 2, total_findings: 4 },
    });
    expect(manifest.recovered_envelope.run.id).toBe(RUN_ID);
    expect(manifest.recovered_envelope.run.converge).toEqual(source.envelope.run.converge);
    expect(manifest.recovered_envelope.calls).toEqual(source.envelope.calls);
    expect(manifest.recovered_envelope.findings.map((finding) => finding.gating_reason)).toEqual([
      'severity-fallback', 'severity-fallback', 'none', 'none',
    ]);
    expect(manifest.recovered_envelope.run.gating).toMatchObject({
      mode: 'verified-consensus',
      severity_fallback_recovery: {
        version: 1, cause: 'verification_pass_failed', source_rcl_version: '4.4.7', source_mode: 'asserted',
        source_report_sha256: sha256Hex(source.artifacts.report_json),
        source_envelope_sha256: sha256Hex(JSON.stringify(source.envelope)),
      },
    });
    expect(await readFile(join(root, 'quarantine', RUN_ID, 'report.json'), 'utf8')).toBe(source.artifacts.report_json);
    expect(await readFile(join(root, 'quarantine', RUN_ID, 'envelope.json'), 'utf8')).toBe(JSON.stringify(source.envelope));
  });

  it('does not let ordinary envelopes use severity-fallback without the complete source binding', () => {
    const source = original();
    source.envelope.findings[0]!.gating_reason = 'severity-fallback';
    expect(validateRunEnvelope(source.envelope, source.artifacts)).toContainEqual(expect.objectContaining({
      path: 'run.gating.severity_fallback_recovery',
    }));
  });

  it.each([
    ['wrong producer', (input: ReturnType<typeof original>) => { input.result.run!.rcl_version = '4.4.8'; input.envelope.run.rcl_version = '4.4.8'; }],
    ['verification summary', (input: ReturnType<typeof original>) => {
      input.result.stats.verification = { model: 'verifier', candidates: 1, refuted: 0, unrefuted: 1, confirmed: 0, insufficientEvidence: 0, unavailable: 1, durationMs: 1 };
      input.envelope.stats = input.result.stats;
    }],
    ['inconclusive health', (input: ReturnType<typeof original>) => {
      (input.result.stats.blockingHealth as { conclusive: boolean }).conclusive = false;
      input.envelope.stats = input.result.stats;
    }],
    ['existing source label', (input: ReturnType<typeof original>) => {
      input.result.findings[0]!.gating = { reason: 'critical' };
      input.artifacts.report_json = JSON.stringify(input.result);
      input.envelope = buildRunEnvelope(input.result, input.artifacts, { level: 'full', delivery: { mode: 'direct' } });
    }],
  ])('refuses %s before any recovery write', async (_name, mutate) => {
    await retain(store, mutate);
    const sink = capabilitySink();
    await expect(planRejectedEvidenceRecovery(store, RUN_ID, sink)).rejects.toThrow();
    expect(sink.postRun).not.toHaveBeenCalled();
    expect(sink.putArtifact).not.toHaveBeenCalled();
  });

  it('revalidates a reviewed manifest, performs one bounded apply, and reads back exact originals', async () => {
    const source = await retain(store);
    const planning = capabilitySink();
    const manifest = await planRejectedEvidenceRecovery(store, RUN_ID, planning);
    let recorded: RejectedRecoveryManifest['recovered_envelope'] | undefined;
    const stored = new Map<string, string>();
    let reads = 0;
    const sink = capabilitySink({
      getRun: vi.fn(async () => {
        reads++;
        if (!recorded) return { kind: 'rejected', httpStatus: 404, error: 'not_found', message: 'not found' };
        return { kind: 'ok', httpStatus: 200, value: {
          ...recorded.run,
          id: RUN_ID, target: recorded.run.target, gating: recorded.run.gating, converge: recorded.run.converge,
          stats: recorded.stats, delivery: recorded.delivery, findings: recorded.findings, calls: recorded.calls,
          artifacts: recorded.artifacts_declared.map((artifact) => ({
            kind: artifact.kind, declared_sha256: artifact.sha256, declared_bytes: artifact.bytes,
            stored: stored.has(artifact.kind),
          })),
        } };
      }),
      postRun: vi.fn(async (envelope) => {
        recorded = structuredClone(envelope);
        return { kind: 'ok', httpStatus: 201, value: {
          id: RUN_ID, url: 'https://harness.example.test/run', artifacts_expected: ['report_json', 'report_md'], status: 'created' as const,
        } };
      }),
      putArtifact: vi.fn(async (_run, kind, bytes) => {
        const status = stored.has(kind) ? 'existing' as const : 'created' as const;
        stored.set(kind, bytes);
        return { kind: 'ok', httpStatus: status === 'created' ? 201 : 200, value: { kind, sha256: sha256Hex(bytes), status } };
      }),
      getArtifact: vi.fn(async (_run, kind) => {
        const bytes = stored.get(kind)!;
        return { kind: 'ok', httpStatus: 200, value: { bytes: Buffer.from(bytes), sha256: sha256Hex(bytes) } };
      }),
    });

    const outcome = await applyRejectedEvidenceRecovery(manifest, store, sink);

    expect(outcome).toMatchObject({
      kind: 'rcl-rejected-evidence-recovery-outcome', version: 1, run_id: RUN_ID,
      writes: { run: 'created', artifacts: { report_json: 'created', report_md: 'created' } },
      readback: {
        report_sha256: sha256Hex(source.artifacts.report_json),
        envelope_sha256: sha256Hex(JSON.stringify(source.envelope)),
        reviewer_calls: 2, converge: { target: 'allocator-one-9356', round: 5, attempt: 11 },
      },
      effects: { reviewer_calls: 0, attempt_changes: 0, round_changes: 0 },
    });
    expect(reads).toBe(2);
    expect(sink.postRun).toHaveBeenCalledTimes(1);
    expect(sink.putArtifact).toHaveBeenCalledTimes(2);
    expect(sink.getArtifact).toHaveBeenCalledTimes(2);
    expect(stored.get('report_json')).toBe(source.artifacts.report_json);
    expect(stored.get('report_md')).toBe(source.artifacts.report_md);

    const repeated = await applyRejectedEvidenceRecovery(manifest, store, sink);
    expect(repeated.writes).toEqual({ run: 'existing', artifacts: { report_json: 'existing', report_md: 'existing' } });
    expect(sink.postRun).toHaveBeenCalledTimes(1);
  });

  it('continues after a lost POST response only when one bounded read proves the exact run exists', async () => {
    await retain(store);
    const manifest = await planRejectedEvidenceRecovery(store, RUN_ID, capabilitySink());
    let recorded: RejectedRecoveryManifest['recovered_envelope'] | undefined;
    const stored = new Map<string, string>();
    let reads = 0;
    const sink = capabilitySink({
      getRun: vi.fn(async () => {
        reads++;
        if (!recorded) return { kind: 'rejected', httpStatus: 404, error: 'not_found', message: 'not found' };
        return { kind: 'ok', httpStatus: 200, value: {
          ...recorded.run,
          id: RUN_ID, target: recorded.run.target, gating: recorded.run.gating, converge: recorded.run.converge,
          stats: recorded.stats, delivery: recorded.delivery, findings: recorded.findings, calls: recorded.calls,
          artifacts: recorded.artifacts_declared.map((artifact) => ({
            kind: artifact.kind, declared_sha256: artifact.sha256, declared_bytes: artifact.bytes,
            stored: stored.has(artifact.kind),
          })),
        } };
      }),
      postRun: vi.fn(async (envelope) => {
        recorded = structuredClone(envelope);
        return { kind: 'unavailable', error: 'timeout', message: 'response was lost' };
      }),
      putArtifact: vi.fn(async (_run, kind, bytes) => {
        stored.set(kind, bytes);
        return { kind: 'ok', httpStatus: 201, value: { kind, sha256: sha256Hex(bytes), status: 'created' as const } };
      }),
      getArtifact: vi.fn(async (_run, kind) => {
        const bytes = stored.get(kind)!;
        return { kind: 'ok', httpStatus: 200, value: { bytes: Buffer.from(bytes), sha256: sha256Hex(bytes) } };
      }),
    });

    await expect(applyRejectedEvidenceRecovery(manifest, store, sink)).resolves.toMatchObject({
      writes: { run: 'existing', artifacts: { report_json: 'created', report_md: 'created' } },
    });
    expect(reads).toBe(3);
    expect(sink.postRun).toHaveBeenCalledTimes(1);
    expect(sink.putArtifact).toHaveBeenCalledTimes(2);
  });

  it('stops without artifact writes when an unavailable POST has no exact run receipt', async () => {
    await retain(store);
    const manifest = await planRejectedEvidenceRecovery(store, RUN_ID, capabilitySink());
    const sink = capabilitySink({
      postRun: vi.fn(async () => ({ kind: 'unavailable', error: 'network', message: 'connection failed' })),
    });

    await expect(applyRejectedEvidenceRecovery(manifest, store, sink))
      .rejects.toThrow('recovery_run_acknowledgment_unknown');
    expect(sink.getRun).toHaveBeenCalledTimes(2);
    expect(sink.postRun).toHaveBeenCalledTimes(1);
    expect(sink.putArtifact).not.toHaveBeenCalled();
  });

  it('fails closed when the reviewed manifest or current retained originals drift', async () => {
    await retain(store);
    const sink = capabilitySink();
    const manifest = await planRejectedEvidenceRecovery(store, RUN_ID, sink);
    const changed = structuredClone(manifest);
    changed.source.envelope_sha256 = '0'.repeat(64);

    await expect(applyRejectedEvidenceRecovery(changed, store, sink)).rejects.toThrow('recovery_manifest_mismatch');
    expect(sink.postRun).not.toHaveBeenCalled();
  });
});
