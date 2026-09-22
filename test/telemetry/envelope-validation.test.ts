import { describe, expect, it } from 'vitest';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { validateRunEnvelope } from '../../src/telemetry/envelope-validation.js';
import { sampleResult } from './fixtures.js';

describe('validateRunEnvelope', () => {
  it('accepts an exact complete envelope and its declared artifacts', () => {
    const result = sampleResult();
    const artifacts = { report_json: JSON.stringify(result), report_md: '# Original report\n' };
    const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' } });

    expect(validateRunEnvelope(envelope, artifacts)).toEqual([]);
  });

  it('refuses provenance that does not bind the normalized coordinates', () => {
    const result = sampleResult();
    Object.assign(result.findings[0]!, {
      startLine: 345,
      endLine: 353,
      locationProvenance: {
        version: 1,
        source: 'parser',
        reason: 'reversed_range',
        originalStartLine: 354,
        originalEndLine: 345,
      },
    });
    const artifacts = { report_json: JSON.stringify(result) };
    const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' } });

    expect(validateRunEnvelope(envelope, artifacts)).toContainEqual(
      expect.objectContaining({ path: 'findings.0.location_provenance', message: 'Provenance does not bind the normalized interval' })
    );
  });

  it.each(['parser with digest', 'projection without digest', 'different report digest', 'missing report declaration'] as const)(
    'refuses invalid historical projection binding: %s', mutation => {
      const result = sampleResult();
      Object.assign(result.findings[0]!, {
        startLine: 10, endLine: 20,
        locationProvenance: { version: 1, source: 'parser', reason: 'reversed_range', originalStartLine: 20, originalEndLine: 10 },
      });
      const artifacts = { report_json: JSON.stringify(result) };
      const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' } });
      const provenance = envelope.findings[0]!.location_provenance!;
      provenance.source = 'report_projection';
      provenance.report_json_sha256 = envelope.artifacts_declared[0]!.sha256;
      expect(validateRunEnvelope(envelope, artifacts)).toEqual([]);

      if (mutation === 'parser with digest') provenance.source = 'parser';
      else if (mutation === 'projection without digest') delete provenance.report_json_sha256;
      else if (mutation === 'different report digest') provenance.report_json_sha256 = '0'.repeat(64);
      else envelope.artifacts_declared = [];

      const diagnostics = validateRunEnvelope(envelope, artifacts);
      expect(diagnostics).toContainEqual(expect.objectContaining({
        path: mutation === 'parser with digest' || mutation === 'projection without digest'
          ? 'findings.0.location_provenance' : 'findings',
      }));
    },
  );
});
