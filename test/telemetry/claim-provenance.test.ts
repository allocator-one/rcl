import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { computeConsensus } from '../../src/consensus/voter.js';
import { processRoundReport, loadConvergeRunState } from '../../src/converge/run-state.js';
import { buildRunEnvelope, sanitizeForDelivery } from '../../src/telemetry/envelope.js';
import { buildEvent, roundIdentities } from '../../src/telemetry/events.js';
import { sampleFinding, sampleResult, sampleReview, sampleRunHeader } from './fixtures.js';

it('materializes one bounded descriptor before exact serialization and preserves it through wire/native/event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claim-pipeline-'));
  try {
    const raw = sampleFinding({ title: 'Loader `load_cache()` fails\0 on invalid records',
      description: 'The cache returns stale entries. ' + '😀'.repeat(600) + '\u0001\uD800 and \uDC00 secret=sk-abcdefghijklmnop123456789',
      suggestedFix: 'Check the expiry timestamp before returning cached records.' });
    const run = sampleRunHeader({ converge: { target: 'pipeline', round: 1 } });
    const findings = computeConsensus(run.id, [{ representative: raw, members: [{ finding: raw, model: 'synthetic/fixture', role: 'general' }] }],
      [sampleReview({ model: 'synthetic/fixture', role: 'general', findings: [raw] })], new Map());
    const report = sanitizeForDelivery(sampleResult({ run, findings, belowThresholdFindings: [] }));
    const original = JSON.stringify(report);
    const descriptor = JSON.parse(original).findings[0].claimDescriptor;
    const envelope = buildRunEnvelope(report, { report_json: original }, { level: 'full', delivery: { mode: 'direct' } });
    const processed = await processRoundReport({ gitCommonDir: dir, target: 'pipeline', round: 1, runId: run.id, findings: report.findings, evidence: { reportJson: original } });
    const mapping = roundIdentities(processed.findings)[0]!;
    const event = buildEvent({ kind: 'round_processed', runId: run.id, convergeTarget: 'pipeline', round: 1, payload: { identities: [mapping] } });
    const state = (await loadConvergeRunState(dir, 'pipeline'))!;
    expect(envelope.findings[0]!.claim_descriptor).toEqual(descriptor);
    expect(state.sightings![0]!.claimDescriptor).toEqual(descriptor);
    expect(mapping.claim_descriptor).toEqual(descriptor);
    expect(event.payload.identities).toEqual([mapping]);
    expect(mapping.report_json_sha256).toBe(createHash('sha256').update(original).digest('hex'));
    expect(await readFile(state.rounds[0]!.reportBinding!.sourcePath, 'utf8')).toBe(original);
    expect(JSON.stringify(descriptor)).not.toContain('sk-abcdefghijklmnop123456789');
    for (const value of [descriptor.operation, descriptor.invariant, ...descriptor.evidence]) {
      expect([...value].length).toBeLessThanOrEqual(500);
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(2000);
      expect(value).not.toMatch(/[\uD800-\uDFFF]/u);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('normalizes newly generated human text before hashing without rewriting historical artifacts', async () => {
  const { normalizeGeneratedReport } = await import('../../src/telemetry/envelope.js');
  const raw = sampleFinding({ title: 'Cache\0 title\u0001', description: 'Keep\tindent\nand\rline breaks\u007f plus 😀\uD800', suggestedFix: 'Repair\0 records' });
  const run = sampleRunHeader({ converge: { target: 'producer-controls', round: 1 } });
  const reviews = [sampleReview({ model: 'synthetic/fixture', role: 'general', findings: [raw], error: 'Provider\0 error', warnings: ['Parser\u0001 warning'] })];
  const [finding] = computeConsensus(run.id, [{ representative: raw, members: [{ finding: raw, model: 'synthetic/fixture', role: 'general' }] }], reviews, new Map());
  finding!.consensus.disputeDetails = 'Disputed\0 evidence';
  finding!.consensus.positions = [{ model: 'synthetic/fixture', role: 'general', severity: 'important', title: 'Position\0 title', excerpt: 'Position\0 evidence' }];
  finding!.gating = { reason: 'verified', verification: { model: 'synthetic/fixture', verdict: 'confirmed', note: 'Checked\0 evidence' } };
  const input = sampleResult({ run, findings: [finding!], belowThresholdFindings: [{ ...finding!, identity: `report:${run.id}:appendix` }], reviews });
  const before = JSON.stringify(input);
  expect(sanitizeForDelivery(input).findings[0]!.title).toBe('Cache title');
  for (const report of [normalizeGeneratedReport(input), sanitizeForDelivery(input)]) {
    const original = JSON.stringify(report);
    const parsed = JSON.parse(original);
    expect(parsed.findings[0].title).toBe('Cache title');
    expect(parsed.findings[0].description).toBe('Keep\tindent\nand\rline breaks plus 😀�');
    expect(parsed.reviews[0].findings[0].title).toBe('Cache title');
    expect(parsed.belowThresholdFindings[0].title).toBe('Cache title');
    expect(parsed.reviews[0].error).toBe('Provider error');
    expect(parsed.findings[0].consensus.positions[0].excerpt).toBe('Position evidence');
    expect(parsed.findings[0].gating.verification.note).toBe('Checked evidence');
    expect(parsed.findings[0].claimDescriptor).toEqual(finding!.claimDescriptor);
    const envelope = buildRunEnvelope(report, { report_json: original }, { level: 'full', delivery: { mode: 'direct' } });
    expect(envelope.findings[0]!.title).toBe(parsed.findings[0].title);
    expect(envelope.findings[0]!.claim_descriptor).toEqual(parsed.findings[0].claimDescriptor);
    expect(envelope.calls[0]!.error).toBe('Provider error');
    expect(envelope.artifacts_declared[0]!.sha256).toBe(createHash('sha256').update(original).digest('hex'));
  }
  const unusualPath = { ...input, findings: [{ ...finding!, file: 'lib/cache\u0001.ex', id: 'raw\u0001id' }] };
  expect(normalizeGeneratedReport(unusualPath).findings[0]).toMatchObject({ file: 'lib/cache\u0001.ex', id: 'raw\u0001id', identity: finding!.identity });
  expect(JSON.stringify(input)).toBe(before);
  const legacy = sampleResult({ findings: [raw], belowThresholdFindings: [], reviews });
  delete legacy.findings[0]!.claimDescriptor;
  const legacyBytes = JSON.stringify(legacy);
  const historical = buildRunEnvelope(legacy, { report_json: legacyBytes }, { level: 'full', delivery: { mode: 'direct' } });
  expect(historical.artifacts_declared[0]!.sha256).toBe(createHash('sha256').update(legacyBytes).digest('hex'));
  expect(historical.findings[0]!.claim_descriptor).toBeUndefined();
  expect(JSON.stringify(legacy)).toBe(legacyBytes);
});
