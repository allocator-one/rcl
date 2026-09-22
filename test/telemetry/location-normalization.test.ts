import { describe, expect, it } from 'vitest';
import { parseReviewOutput } from '../../src/consensus/parser.js';
import { deduplicateFindings } from '../../src/consensus/deduper.js';
import { computeConsensus, applyReportThresholds } from '../../src/consensus/voter.js';
import { reviewFromParse } from '../../src/dispatch/utils.js';
import { buildRunEnvelope, sanitizeForDelivery } from '../../src/telemetry/envelope.js';
import { getRoleByName } from '../../src/roles/builtin.js';
import type { ReviewResult } from '../../src/consensus/types.js';
import { sampleRunHeader } from './fixtures.js';

const rawFinding = {
  id: 'reversed', file: 'lib/uploads.ex', startLine: 353, endLine: 345,
  severity: 'minor', category: 'correctness', title: 'Upload policy can drift',
  description: 'The stored policy can diverge from the current upload configuration.',
};
const sibling = {
  ...rawFinding, id: 'sibling', file: 'lib/access.ex', startLine: 4, endLine: 6,
  severity: 'critical', title: 'Missing access check', description: 'The request has no access check.',
};

function report(startLine: number, endLine: number, severity: string): ReviewResult {
  const run = sampleRunHeader();
  const parsed = parseReviewOutput(JSON.stringify({
    findings: [{ ...rawFinding, startLine, endLine, severity }, sibling],
  }), 'anthropic/claude', 'general');
  const review = reviewFromParse({
    model: 'anthropic/claude', role: 'general', provider: 'anthropic', startedAt: Date.now(), parsed,
  });
  const reviews = [review];
  const findings = computeConsensus(run.id, deduplicateFindings(reviews), reviews,
    new Map([['general', getRoleByName('general')!]]));
  const { kept, dropped } = applyReportThresholds(findings, { minConfidence: 1 });
  return sanitizeForDelivery({
    run, reviews, findings: kept, belowThresholdFindings: dropped,
    stats: {
      totalReviews: 1, successfulReviews: review.status === 'success' ? 1 : 0,
      totalRawFindings: review.findings.length, totalDeduped: findings.length,
      belowThreshold: dropped.length, durationMs: 0,
    },
  });
}

describe('finding location normalization before report identity and delivery', () => {
  it('retains normalization evidence on a nonrepresentative reviewer finding', () => {
    const run = sampleRunHeader();
    const reviews = [
      { model: 'anthropic/first', finding: { ...rawFinding, id: 'ordered', startLine: 345, endLine: 353, severity: 'important' } },
      { model: 'openai/second', finding: rawFinding },
    ].map(({ model, finding }) => reviewFromParse({
      model, role: 'general', provider: model.split('/')[0]!, startedAt: Date.now(),
      parsed: parseReviewOutput(JSON.stringify({ findings: [finding] }), model, 'general'),
    }));
    const findings = computeConsensus(run.id, deduplicateFindings(reviews), reviews,
      new Map([['general', getRoleByName('general')!]]));
    const result = sanitizeForDelivery({ ...report(345, 353, 'important'), run, reviews, findings, belowThresholdFindings: [] });
    expect(findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ id: 'ordered', startLine: 345, endLine: 353, severity: 'important' });
    expect(result.findings[0]!.locationProvenance).toBeUndefined();
    expect(result.findings[0]!.consensus.models).toEqual(expect.arrayContaining(['anthropic/first', 'openai/second']));
    expect(result.reviews[1]!.findings[0]).toMatchObject({
      startLine: 345, endLine: 353, severity: 'minor',
      locationProvenance: { originalStartLine: 353, originalEndLine: 345, reason: 'reversed_range' },
    });
  });

  it('derives parser provenance itself instead of trusting model-supplied provenance', () => {
    const supplied = { version: 1, source: 'parser', reason: 'reversed_range', originalStartLine: 999, originalEndLine: 1 };
    const parsed = parseReviewOutput(JSON.stringify({ findings: [
      { ...rawFinding, locationProvenance: supplied },
      { ...sibling, locationProvenance: supplied },
    ] }), 'anthropic/claude', 'general');
    expect(parsed.findings[0]!.locationProvenance).toMatchObject({ originalStartLine: 353, originalEndLine: 345 });
    expect(parsed.findings[1]!.locationProvenance).toBeUndefined();
  });

  it.each([
    ['appendix', 'minor', true],
    ['kept', 'important', false],
  ] as const)('retains a reversed %s finding and its independent sibling', (_label, severity, below) => {
    const result = report(353, 345, severity);
    const artifacts = { report_json: JSON.stringify(result), report_md: '# Synthetic review\n' };
    const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' } });
    const finding = envelope.findings.find((f) => f.file === rawFinding.file)!;

    expect(finding).toMatchObject({
      start_line: 345, end_line: 353, severity, below_threshold: below, gating_reason: 'none',
      location_provenance: {
        version: 1, source: 'parser', reason: 'reversed_range',
        original_start_line: 353, original_end_line: 345,
      },
    });
    expect(envelope.findings).toHaveLength(2);
    expect(envelope.findings.find((f) => f.file === sibling.file)).toMatchObject({
      start_line: 4, end_line: 6, severity: 'critical', below_threshold: false,
    });
    expect(envelope.calls[0]).toMatchObject({ status: 'success', dropped_findings: 0 });
    expect(envelope.stats).toMatchObject({ totalRawFindings: 2, totalDeduped: 2, belowThreshold: below ? 1 : 0 });

    const ordered = report(345, 353, severity);
    const orderedFinding = [...ordered.findings, ...ordered.belowThresholdFindings!]
      .find((f) => f.file === rawFinding.file)!;
    expect(finding.identity_key).toBe(orderedFinding.identity);
    expect(result.reviews[0]!.findings.find((f) => f.id === 'reversed')).toMatchObject({
      startLine: 345, endLine: 353,
      locationProvenance: { originalStartLine: 353, originalEndLine: 345, reason: 'reversed_range' },
    });
  });
});
