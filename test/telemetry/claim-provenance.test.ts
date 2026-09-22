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
