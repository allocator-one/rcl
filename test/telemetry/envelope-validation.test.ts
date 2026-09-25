import { describe, expect, it } from 'vitest';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { MAX_ENVELOPE_BYTES, validateRunEnvelope } from '../../src/telemetry/envelope-validation.js';

const PROTOCOL_MAX_ENVELOPE_BYTES = MAX_ENVELOPE_BYTES;
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

  it('accepts an exact 4MB envelope without changing its rows and rejects one byte more', () => {
    const result = sampleResult();
    const artifacts = { report_json: JSON.stringify(result) };
    const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' } });
    const originalRows = envelope.findings.length;
    const seed = envelope.findings[0]!;
    for (let index = 0; index < 210; index++) envelope.findings.push({ ...structuredClone(seed), ref: `padded-${index}`, description: '' });
    let remaining = PROTOCOL_MAX_ENVELOPE_BYTES - Buffer.byteLength(JSON.stringify(envelope));
    for (const finding of envelope.findings.slice(originalRows)) {
      if (remaining <= 0) break;
      const chunk = Math.min(20_000, remaining);
      finding.description = 'x'.repeat(chunk);
      remaining -= chunk;
    }
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBe(PROTOCOL_MAX_ENVELOPE_BYTES);
    expect(validateRunEnvelope(envelope, artifacts)).toEqual([]);
    expect(envelope.findings).toHaveLength(originalRows + 210);
    expect(envelope.findings[0]!.ref).toBe('f001');
    envelope.findings[1]!.description = `${envelope.findings[1]!.description}x`;
    expect(validateRunEnvelope(envelope, artifacts)).toEqual([{ path: 'envelope', message: `Envelope exceeds ${PROTOCOL_MAX_ENVELOPE_BYTES} bytes or is not JSON` }]);
  });

  it.each([
    ['verification_model', (envelope: any) => envelope.findings[0]],
    ['verification_note', (envelope: any) => envelope.findings[0]],
    ['call.error', (envelope: any) => envelope.calls[0]],
  ] as const)('keeps the 2M character cap for %s while the total envelope allows 4MB', (_name, select) => {
    const result = sampleResult();
    const artifacts = { report_json: JSON.stringify(result) };
    const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' } });
    const target = select(envelope);
    target[_name === 'call.error' ? 'error' : _name] = 'x'.repeat(2_000_001);
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeGreaterThan(2_000_000);
    expect(validateRunEnvelope(envelope, artifacts)).toContainEqual(expect.objectContaining({ path: _name === 'call.error' ? 'calls.0.error' : `findings.0.${_name}` }));
  });

  it('measures the total protocol limit in UTF-8 bytes for multibyte content', () => {
    const result = sampleResult();
    const artifacts = { report_json: JSON.stringify(result) };
    const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' } });
    const seed = envelope.findings[0]!;
    const originalRows = envelope.findings.length;
    for (let index = 0; index < 210; index++) envelope.findings.push({ ...structuredClone(seed), ref: `utf8-${index}`, description: '' });
    let remainingBytes = PROTOCOL_MAX_ENVELOPE_BYTES - Buffer.byteLength(JSON.stringify(envelope));
    for (const finding of envelope.findings.slice(originalRows)) {
      const characters = Math.floor(Math.min(20_000, remainingBytes) / 2);
      if (characters === 0) break;
      finding.description = 'é'.repeat(characters);
      remainingBytes -= characters * 2;
    }
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    expect(bytes).toBeLessThanOrEqual(PROTOCOL_MAX_ENVELOPE_BYTES);
    expect(PROTOCOL_MAX_ENVELOPE_BYTES - bytes).toBeLessThan(2);
    expect(validateRunEnvelope(envelope, artifacts)).toEqual([]);
    envelope.findings[originalRows]!.description = `${envelope.findings[originalRows]!.description}é`;
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeGreaterThan(PROTOCOL_MAX_ENVELOPE_BYTES);
    expect(validateRunEnvelope(envelope, artifacts)).toContainEqual({ path: 'envelope', message: `Envelope exceeds ${PROTOCOL_MAX_ENVELOPE_BYTES} bytes or is not JSON` });
  });

});
