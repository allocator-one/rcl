import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildRunEnvelope, declareArtifacts } from '../../src/telemetry/envelope.js';
import { REDACTED } from '../../src/telemetry/scrub.js';
import { sampleResult } from './fixtures.js';

const ARTIFACTS = { report_json: '{"report": true}', report_md: '# Report\n' };

describe('declareArtifacts', () => {
  it('digests the exact bytes and counts them in UTF-8', () => {
    const declared = declareArtifacts({ report_json: 'é', report_md: 'x' });
    expect(declared).toEqual([
      { kind: 'report_json', sha256: createHash('sha256').update('é', 'utf8').digest('hex'), bytes: 2 },
      { kind: 'report_md', sha256: createHash('sha256').update('x', 'utf8').digest('hex'), bytes: 1 },
    ]);
  });

  it('declares report_json alone when no Markdown was rendered', () => {
    expect(declareArtifacts({ report_json: '{}' }).map((d) => d.kind)).toEqual(['report_json']);
  });
});

describe('buildRunEnvelope', () => {
  it('wraps the run header with wire-shaped findings, calls, stats, declarations and delivery', () => {
    const result = sampleResult();
    const envelope = buildRunEnvelope(result, ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });

    expect(envelope.run.id).toBe(result.run!.id);
    expect(envelope.delivery).toEqual({ mode: 'direct' });
    expect(envelope.stats).toEqual(result.stats);
    expect(envelope.artifacts_declared.map((d) => d.kind)).toEqual(['report_json', 'report_md']);

    expect(envelope.findings).toHaveLength(2);
    const [kept, below] = envelope.findings;
    expect(kept).toMatchObject({
      ref: 'f001',
      identity_key: 'abc123def4567890',
      file: 'lib/foo.ex',
      start_line: 10,
      end_line: 12,
      severity: 'important',
      category: 'correctness',
      title: 'Pagination misses tiebreak',
      suggested_fix: 'Add id as a tiebreak.',
      gating_reason: 'consensus',
      below_threshold: false,
    });
    expect(kept!.consensus.models).toEqual(['anthropic/claude', 'openai/gpt']);
    expect(below).toMatchObject({ ref: 'f002', identity_key: 'fedcba9876543210', gating_reason: 'none', below_threshold: true });

    expect(envelope.calls).toHaveLength(2);
    expect(envelope.calls[0]).toEqual({
      model: 'anthropic/claude',
      role: 'bug-hunter',
      provider: 'anthropic',
      lane: 'blocking',
      chunk_index: 0,
      status: 'success',
      duration_ms: 12_346,
      input_tokens: 27_514,
      output_tokens: 900,
      reasoning_tokens: 300,
      dropped_findings: 0,
      warnings: [],
      async: false,
    });
    expect(envelope.calls[1]).toMatchObject({ lane: 'secondary', status: 'parse_failed', dropped_findings: 1 });
  });

  it('sends only the parser message for a parse failure, and never a key', () => {
    const envelope = buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });
    expect(envelope.calls[1]!.error).toBe('JSON parse error at position 12');

    const verbose = buildRunEnvelope(sampleResult(), ARTIFACTS, {
      level: 'full',
      delivery: { mode: 'direct' },
      parseFailures: true,
    });
    expect(verbose.calls[1]!.error).toBe('JSON parse error at position 12\n[code omitted]');
    expect(JSON.stringify(verbose)).not.toContain('sk-ant-');
  });

  it('carries no findings or calls at the envelope level, all of them at findings level', () => {
    const envelope = buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'envelope', delivery: { mode: 'direct' } });
    expect(envelope.findings).toEqual([]);
    expect(envelope.calls).toEqual([]);
    expect(envelope.artifacts_declared).toHaveLength(2);

    const findings = buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'findings', delivery: { mode: 'direct' } });
    expect(findings.findings).toHaveLength(2);
    expect(findings.calls).toHaveLength(2);
  });

  it('derives an identity for a finding that carries none, and lanes an async reviewer', () => {
    const result = sampleResult();
    delete result.findings[0]!.identity;
    result.reviews.push({ ...result.reviews[0]!, model: 'google/gemini', role: 'bonus', async: true });
    const envelope = buildRunEnvelope(result, ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });
    expect(envelope.findings[0]!.identity_key).toMatch(/^[0-9a-f]{16}$/);
    expect(envelope.calls[2]).toMatchObject({ model: 'google/gemini', lane: 'async', async: true });
  });

  it('scrubs credentials out of every free-text field', () => {
    const result = sampleResult();
    result.findings[0]!.description = 'Leaks sk-ant-abcdefghijklmnopqrstuvwxyz in logs';
    result.findings[0]!.consensus.disputeDetails = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 was quoted';
    result.reviews[0]!.warnings = ['Bearer abcdefghijklmnopqrstuvwxyz0123456789 rejected'];
    result.run!.runner.host = 'host-aone_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const envelope = buildRunEnvelope(result, ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });
    const json = JSON.stringify(envelope);
    expect(json).not.toMatch(/sk-ant-|ghp_|Bearer abc|aone_/);
    expect(envelope.findings[0]!.description).toBe(`Leaks ${REDACTED} in logs`);
    expect(envelope.findings[0]!.consensus.disputeDetails).toBe(`${REDACTED} was quoted`);
  });

  it('never contains environment values (poisoned-env negative test)', () => {
    const poison = {
      ANTHROPIC_API_KEY: 'poison-anthropic-9f8e7d6c',
      OPENAI_API_KEY: 'poison-openai-1a2b3c4d',
      GITHUB_TOKEN: 'poison-github-5e6f7a8b',
      HARNESS_API_TOKEN: 'poison-harness-9c0d1e2f',
      HARNESS_API_URL: 'https://poison.example.test',
    };
    const before = { ...process.env };
    Object.assign(process.env, poison);
    try {
      const json = JSON.stringify(
        buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'retried', spooled_at: '2026-09-07T09:00:00Z' } })
      );
      for (const value of Object.values(poison)) expect(json).not.toContain(value);
    } finally {
      for (const key of Object.keys(poison)) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
    }
  });

  it('refuses a report without a run header', () => {
    const result = sampleResult();
    delete result.run;
    expect(() => buildRunEnvelope(result, ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } })).toThrow(/run header/);
  });
});
