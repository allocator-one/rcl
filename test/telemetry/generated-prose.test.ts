import { describe, expect, it } from 'vitest';
import { buildRunEnvelope, normalizeGeneratedReport, sanitizeForDelivery, sha256Hex } from '../../src/telemetry/envelope.js';
import { validateRunEnvelope } from '../../src/telemetry/envelope-validation.js';
import { renderReportArtifacts } from '../../src/output/artifacts.js';
import { sampleFinding, sampleResult, sampleReview } from './fixtures.js';

describe('fresh report prose', () => {
  it('normalizes every human field without changing attribution, findings, or its input', () => {
    const malformed = 'Keep\tindent\nand\rline breaks\u007f plus 😀\uD800\uDFFF\uD800';
    const expected = 'Keep\tindent\nand\rline breaks plus 😀𐏿�';
    const finding = sampleFinding({ title: 'Cache\0 title\u0001', description: malformed, suggestedFix: 'Fix\0 records' });
    finding.consensus.disputeDetails = 'Disputed\0 evidence';
    finding.consensus.positions = [{ model: 'synthetic/fixture', role: 'general', severity: 'important', title: 'Position\0 title', excerpt: malformed }];
    finding.gating = { reason: 'verified', verification: { model: 'synthetic/fixture', verdict: 'confirmed', note: 'Checked\0 evidence' } };
    const input = sampleResult({ findings: [finding], belowThresholdFindings: [{ ...finding, id: 'F2' }],
      reviews: [sampleReview({ findings: [finding], error: 'Provider\0 error', warnings: ['Parser\u0001 warning'] })] });
    const before = JSON.stringify(input);
    const normalized = normalizeGeneratedReport(input);
    for (const report of [normalized, sanitizeForDelivery(normalized)]) {
      expect(report.findings[0]).toMatchObject({
        title: 'Cache title', description: expected, suggestedFix: 'Fix records',
        file: finding.file, startLine: finding.startLine, endLine: finding.endLine,
        severity: finding.severity, identity: finding.identity,
        consensus: { models: finding.consensus.models, roles: finding.consensus.roles,
          disputeDetails: 'Disputed evidence', positions: [{ model: 'synthetic/fixture', role: 'general', severity: 'important', title: 'Position title', excerpt: expected }] },
        gating: { verification: { model: 'synthetic/fixture', verdict: 'confirmed', note: 'Checked evidence' } },
      });
      expect(report.belowThresholdFindings).toHaveLength(1);
      expect(report.belowThresholdFindings![0]!.description).toBe(expected);
      expect(report.reviews[0]).toMatchObject({ findings: [{ title: 'Cache title', description: expected }], error: 'Provider error', warnings: ['Parser warning'] });
      expect(report.run).toEqual(input.run);
      expect(report.stats).toEqual(input.stats);
      const artifacts = renderReportArtifacts(report);
      const envelope = buildRunEnvelope(report, artifacts, { level: 'full', delivery: { mode: 'direct' } });
      expect(validateRunEnvelope(envelope, artifacts)).toEqual([]);
      expect(envelope.artifacts_declared).toContainEqual({ kind: 'report_json', sha256: sha256Hex(artifacts.report_json), bytes: Buffer.byteLength(artifacts.report_json) });
      expect(envelope.artifacts_declared).toContainEqual({ kind: 'report_md', sha256: sha256Hex(artifacts.report_md!), bytes: Buffer.byteLength(artifacts.report_md!) });
      expect(JSON.parse(artifacts.report_json).findings[0].description).toBe(expected);
      expect(artifacts.report_md).toContain('Cache title');
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it('preserves valid scalar values and never silently repairs structural identifiers or retained artifacts', () => {
    const prose = 'é 中文 😀 👩‍💻 \t\r\n \\ud800';
    const finding = sampleFinding({ title: prose, description: prose, file: 'src/bad\uD800.ts', identity: 'identity\uDFFF' });
    const input = sampleResult({ findings: [finding] });
    const before = JSON.stringify(input);
    expect(normalizeGeneratedReport(input)).toEqual(input);
    const artifacts = { report_json: before };
    const retained = buildRunEnvelope(input, artifacts, { level: 'full', delivery: { mode: 'direct' } });
    expect(retained.findings[0]!.file).toBe(finding.file);
    expect(retained.artifacts_declared[0]!.sha256).toBe(sha256Hex(before));
    expect(JSON.stringify(input)).toBe(before);
  });
});
