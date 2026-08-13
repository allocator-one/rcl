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

  it('counts a reviewer successful if any chunk succeeded, keeping its findings', () => {
    const merged = mergeChunkReviews([
      review({ findings: [finding('a')], status: 'success' }),
      review({ findings: [], status: 'timeout', error: 'timed out' }),
    ]);
    expect(merged[0]!.status).toBe('success');
    expect(merged[0]!.findings.map((f) => f.id)).toEqual(['a']);
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
  it('sums dropped counts across chunks, including ones that wholly failed', () => {
    const [merged] = mergeChunkReviews([
      review({ findings: [finding('a')], droppedFindings: 1, warnings: ['w1'] }),
      review({ status: 'parse_failed', droppedFindings: 3, warnings: ['w2'], error: 'lost' }),
    ]);

    // One chunk parsed, so the reviewer still contributed — but four findings
    // were lost and the report must be able to say so.
    expect(merged!.status).toBe('success');
    expect(merged!.findings).toHaveLength(1);
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
