import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { commentableLines, postGitHubReview } from '../../src/output/github.js';
import type { ConsensusFinding, ReviewResult } from '../../src/consensus/types.js';
import type { FileChange, PRMetadata } from '../../src/resolver/types.js';

const PATCH = [
  '@@ -1,3 +1,4 @@',
  ' context line 1', // new line 1
  '-removed',
  '+added line 2', // new line 2
  '+added line 3', // new line 3
  ' context line 4', // new line 4
].join('\n');

describe('commentableLines', () => {
  it('maps added and context lines to their new-file line numbers', () => {
    expect([...commentableLines(PATCH)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('handles multiple hunks', () => {
    const patch = '@@ -1 +1 @@\n+one\n@@ -10,0 +10,2 @@\n+ten\n+eleven';
    expect([...commentableLines(patch)].sort((a, b) => a - b)).toEqual([1, 10, 11]);
  });

  it('ignores the "\\ No newline at end of file" marker', () => {
    const patch = [
      '@@ -1,3 +1,3 @@',
      ' function f() {',
      '-  return 1',
      '+  return 2',
      ' }',
      '\\ No newline at end of file',
    ].join('\n');
    // must be {1,2,3}, not {1,2,3,4} — line 4 does not exist in the new file
    expect([...commentableLines(patch)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

function finding(over: Partial<ConsensusFinding> = {}): ConsensusFinding {
  return {
    id: 'f',
    file: 'src/a.ts',
    startLine: 2,
    endLine: 2,
    severity: 'important',
    category: 'security',
    title: 'Issue',
    description: 'desc',
    consensus: {
      score: 1,
      total: 1,
      models: ['m'],
      roles: ['general'],
      crossRole: false,
      crossModel: false,
      elevated: false,
      elevation: 'none',
      confidence: 0.5,
      confidenceLabel: 'Medium',
    },
    ...over,
  };
}

function result(findings: ConsensusFinding[]): ReviewResult {
  return {
    reviews: [{ model: 'm', role: 'general', provider: 'test', findings: [], durationMs: 1, status: 'success' }],
    findings,
    stats: {
      totalReviews: 1,
      successfulReviews: 1,
      totalRawFindings: findings.length,
      totalDeduped: findings.length,
      belowThreshold: 0,
      durationMs: 1,
    },
  };
}

const META: PRMetadata = {
  owner: 'o', repo: 'r', number: 1, title: 't', body: '', author: 'a',
  base: 'main', head: 'feat', url: 'u', labels: [], draft: false,
};

const FILES: FileChange[] = [
  { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: PATCH, language: 'typescript' },
];

function fakeOctokit(createReview: ReturnType<typeof vi.fn>) {
  return {
    pulls: {
      get: vi.fn().mockResolvedValue({ data: { head: { sha: 'sha1' } } }),
      createReview,
    },
  } as unknown as Octokit;
}

describe('postGitHubReview — anchor validation', () => {
  it('posts a valid finding as an inline comment', async () => {
    const createReview = vi.fn().mockResolvedValue({});
    await postGitHubReview(result([finding({ startLine: 2 })]), META, 't', FILES, fakeOctokit(createReview));

    const call = createReview.mock.calls[0]![0];
    expect(call.comments).toHaveLength(1);
    expect(call.comments[0].line).toBe(2);
  });

  it('snaps a near-miss line to the nearest commentable line', async () => {
    const createReview = vi.fn().mockResolvedValue({});
    // line 6 is outside the diff; nearest commentable is 4 (distance 2 <= 3)
    await postGitHubReview(result([finding({ startLine: 6 })]), META, 't', FILES, fakeOctokit(createReview));

    const call = createReview.mock.calls[0]![0];
    expect(call.comments).toHaveLength(1);
    expect(call.comments[0].line).toBe(4);
  });

  it('demotes an unmappable finding to the summary instead of posting it inline', async () => {
    const createReview = vi.fn().mockResolvedValue({});
    await postGitHubReview(result([finding({ startLine: 500 })]), META, 't', FILES, fakeOctokit(createReview));

    const call = createReview.mock.calls[0]![0];
    expect(call.comments).toHaveLength(0);
    expect(call.body).toContain('not anchored to a diff line');
    expect(call.body).toContain('src/a.ts:500');
  });

  it('retries with summary-only when createReview 422s on a bad anchor', async () => {
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(new Error('422 line must be part of the diff'))
      .mockResolvedValueOnce({});
    await postGitHubReview(result([finding({ startLine: 2 })]), META, 't', FILES, fakeOctokit(createReview));

    expect(createReview).toHaveBeenCalledTimes(2);
    expect(createReview.mock.calls[1]![0].comments).toHaveLength(0);
    expect(createReview.mock.calls[1]![0].body).toContain('could not be posted');
  });
});
