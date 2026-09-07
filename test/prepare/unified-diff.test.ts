import { describe, expect, it } from 'vitest';
import {
  formatSyntheticHunkHeader,
  parseUnifiedDiff,
  splitPatchLines,
} from '../../src/prepare/unified-diff.js';

describe('splitPatchLines', () => {
  it('preserves whether the source ended with a newline', () => {
    expect(splitPatchLines('one\ntwo\n')).toEqual({
      lines: ['one', 'two'],
      trailingNewline: true,
    });
    expect(splitPatchLines('one\ntwo')).toEqual({
      lines: ['one', 'two'],
      trailingNewline: false,
    });
  });
});

describe('parseUnifiedDiff', () => {
  it('tracks exact coordinates and suffixes across a mixed hunk', () => {
    const parsed = parseUnifiedDiff(
      ['@@ -10,2 +20,3 @@ function example', ' same', '-old', '+new', '+extra'].join('\n')
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.diff.hunks).toHaveLength(1);
    expect(parsed.diff.hunks[0]).toMatchObject({
      oldStart: 10,
      oldCount: 2,
      newStart: 20,
      newCount: 3,
      suffix: ' function example',
    });
    expect(parsed.diff.hunks[0]!.body.map((line) => [line.oldLine, line.newLine])).toEqual([
      [10, 20],
      [11, 21],
      [12, 21],
      [12, 22],
    ]);
  });

  it('tracks deletion anchors at their effective new-file coordinates', () => {
    const deletion = parseUnifiedDiff('@@ -3,1 +2,0 @@ removed\n-old');
    const replacement = parseUnifiedDiff('@@ -3,1 +3,1 @@ replaced\n-old\n+new');
    expect(deletion.ok).toBe(true);
    expect(replacement.ok).toBe(true);
    if (!deletion.ok || !replacement.ok) return;

    expect(deletion.diff.hunks[0]!.body.map((line) => line.newLine)).toEqual([3]);
    expect(replacement.diff.hunks[0]!.body.map((line) => line.newLine)).toEqual([3, 3]);
  });

  it.each([
    ['headerless content', 'plain text', 1, 'expected a unified-diff hunk header'],
    ['positive-count line zero', '@@ -0,1 +1,1 @@\n-old\n+new', 1, 'starts at line zero'],
    [
      'unattached no-newline marker',
      '@@ -1 +1 @@\n\\ No newline at end of file\n line',
      2,
      'not attached',
    ],
    ['body overrun', '@@ -1 +1 @@\n line\n+extra', 3, 'exceeds the declared new-file range'],
    ['body underrun', '@@ -1,2 +1,2 @@\n line', 2, 'does not match its declared ranges'],
    [
      'next hunk before the prior body is complete',
      '@@ -1,2 +1,2 @@\n line\n@@ -5 +5 @@\n next',
      3,
      'does not match its declared ranges',
    ],
  ])('rejects %s', (_label, patch, line, reason) => {
    const parsed = parseUnifiedDiff(patch);
    expect(parsed).toMatchObject({ ok: false, line });
    if (parsed.ok) return;
    expect(parsed.reason).toContain(reason);
  });
});

describe('formatSyntheticHunkHeader', () => {
  it('round-trips file-start insertion and deletion anchors', () => {
    const insertion = parseUnifiedDiff('@@ -0,0 +1,2 @@ added\n+one\n+two');
    const deletion = parseUnifiedDiff('@@ -1,2 +0,0 @@ removed\n-one\n-two');
    expect(insertion.ok).toBe(true);
    expect(deletion.ok).toBe(true);
    if (!insertion.ok || !deletion.ok) return;

    expect(formatSyntheticHunkHeader(insertion.diff.hunks[0]!.body)).toBe(
      '@@ -0,0 +1,2 @@ added'
    );
    expect(formatSyntheticHunkHeader(deletion.diff.hunks[0]!.body)).toBe(
      '@@ -1,2 +0,0 @@ removed'
    );
  });

  it('formats a mid-hunk insertion window with the correct zero-count anchor', () => {
    const parsed = parseUnifiedDiff(
      ['@@ -10,2 +20,3 @@ function example', ' same', '-old', '+new', '+extra'].join('\n')
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(formatSyntheticHunkHeader(parsed.diff.hunks[0]!.body.slice(2))).toBe(
      '@@ -11,0 +21,2 @@ function example'
    );
  });

  it('rejects empty and marker-first windows', () => {
    const parsed = parseUnifiedDiff('@@ -1 +1 @@\n line\n\\ No newline at end of file');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(formatSyntheticHunkHeader([])).toBeUndefined();
    expect(formatSyntheticHunkHeader(parsed.diff.hunks[0]!.body.slice(1))).toBeUndefined();
  });
});
