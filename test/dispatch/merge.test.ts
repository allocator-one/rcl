import { describe, it, expect } from 'vitest';
import { mergeChunkReviews } from '../../src/dispatch/merge.js';
import type { ModelReview } from '../../src/consensus/types.js';

function review(over: Partial<ModelReview>): ModelReview {
  return {
    model: 'm1',
    role: 'general',
    provider: 'test',
    findings: [],
    durationMs: 10,
    status: 'success',
    ...over,
  };
}

function finding(id: string) {
  return {
    id,
    file: 'src/a.ts',
    startLine: 1,
    endLine: 1,
    severity: 'minor' as const,
    category: 'security' as const,
    title: id,
    description: id,
  };
}

describe('mergeChunkReviews', () => {
  it('merges findings from the same reviewer across chunks into one review', () => {
    const merged = mergeChunkReviews([
      review({ findings: [finding('a')] }),
      review({ findings: [finding('b')] }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.findings.map((f) => f.id)).toEqual(['a', 'b']);
    expect(merged[0]!.durationMs).toBe(20);
  });

  it('keeps distinct reviewers separate', () => {
    const merged = mergeChunkReviews([
      review({ model: 'm1', role: 'general', findings: [finding('a')] }),
      review({ model: 'm2', role: 'security-auditor', findings: [finding('b')] }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('does not let a reviewer vote when any expected chunk failed', () => {
    const merged = mergeChunkReviews([
      review({ findings: [finding('a')], status: 'success' }),
      review({ findings: [], status: 'timeout', error: 'timed out' }),
    ]);
    expect(merged[0]!.status).toBe('timeout');
    expect(merged[0]!.findings).toEqual([]);
    expect(merged[0]!.error).toMatch(/incomplete chunk coverage.*1\/2.*timed out/i);
  });

  it('does not report success when an expected chunk was canceled', () => {
    const [merged] = mergeChunkReviews([
      review({ findings: [finding('a')] }),
      review({ status: 'canceled', error: 'Canceled at quorum round closure' }),
    ]);

    expect(merged!.status).toBe('canceled');
    expect(merged!.findings).toEqual([]);
    expect(merged!.error).toMatch(/incomplete chunk coverage/i);
  });

  it('keeps async-only arrivals best-effort when one returned part failed', () => {
    const [merged] = mergeChunkReviews([
      review({ async: true, findings: [finding('async-a')] }),
      review({ async: true, status: 'timeout', error: 'late async part' }),
    ]);

    expect(merged!.status).toBe('success');
    expect(merged!.findings.map((item) => item.id)).toEqual(['async-a']);
    expect(merged!.async).toBe(true);
  });

  it('does not let an async success rescue incomplete blocking coverage', () => {
    const [merged] = mergeChunkReviews([
      review({ status: 'timeout', error: 'blocking timeout' }),
      review({ async: true, findings: [finding('async-a')] }),
    ]);

    expect(merged!.status).toBe('timeout');
    expect(merged!.findings).toEqual([]);
    expect(merged!.async).toBeUndefined();
  });

  it('does not let an async failure poison complete blocking coverage', () => {
    const [merged] = mergeChunkReviews([
      review({
        findings: [finding('blocking-a')],
        durationMs: 10,
        droppedFindings: 1,
        warnings: ['blocking warning'],
      }),
      review({
        async: true,
        status: 'error',
        error: 'async failed',
        durationMs: 20,
        droppedFindings: 2,
        warnings: ['async warning'],
      }),
    ]);

    expect(merged!.status).toBe('success');
    expect(merged!.findings.map((item) => item.id)).toEqual(['blocking-a']);
    expect(merged!.async).toBeUndefined();
    expect(merged!.durationMs).toBe(30);
    expect(merged!.droppedFindings).toBe(3);
    expect(merged!.warnings).toEqual(['blocking warning', 'async warning']);
  });

  it('preserves the failure when no chunk succeeded', () => {
    const merged = mergeChunkReviews([
      review({ findings: [], status: 'error', error: 'boom' }),
      review({ findings: [], status: 'timeout', error: 'slow' }),
    ]);
    expect(merged[0]!.status).toBe('error');
    expect(merged[0]!.error).toBe('boom');
  });

  it('is a no-op for a single chunk', () => {
    const one = [review({ findings: [finding('a')] })];
    expect(mergeChunkReviews(one)).toEqual(one);
  });
});

// RCL-14: chunked reviews are merged before consensus, so the merge is the
// last place that can still say "this reviewer's coverage was degraded".
describe('mergeChunkReviews — degraded coverage', () => {
  it('preserves degraded metadata while excluding findings from partial coverage', () => {
    const [merged] = mergeChunkReviews([
      review({ findings: [finding('a')], droppedFindings: 1, warnings: ['w1'] }),
      review({ status: 'parse_failed', droppedFindings: 3, warnings: ['w2'], error: 'lost' }),
    ]);

    expect(merged!.status).toBe('parse_failed');
    expect(merged!.findings).toEqual([]);
    expect(merged!.droppedFindings).toBe(4);
    expect(merged!.warnings).toEqual(['w1', 'w2']);
  });

  it('keeps parse_failed when no chunk parsed', () => {
    const [merged] = mergeChunkReviews([
      review({ status: 'parse_failed', droppedFindings: 2, error: 'lost' }),
      review({ status: 'parse_failed', droppedFindings: 1, error: 'lost' }),
    ]);

    expect(merged!.status).toBe('parse_failed');
    expect(merged!.droppedFindings).toBe(3);
  });

  it('leaves a clean multi-chunk review unannotated', () => {
    const [merged] = mergeChunkReviews([
      review({ findings: [finding('a')] }),
      review({ findings: [finding('b')] }),
    ]);

    expect(merged!.status).toBe('success');
    expect(merged!.findings).toHaveLength(2);
    expect(merged!.droppedFindings).toBeUndefined();
    expect(merged!.warnings).toBeUndefined();
  });
});
