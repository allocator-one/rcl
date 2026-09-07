import { describe, expect, it } from 'vitest';
import { chunkDiff, formatChunkForPrompt } from '../../src/prepare/chunker.js';
import type { FileChange } from '../../src/resolver/types.js';

function makeFile(filename: string, lineCount: number): FileChange {
  const lines = Array.from({ length: lineCount }, (_, index) => `+line ${index}`);
  return {
    filename,
    status: 'modified',
    additions: lineCount,
    deletions: 0,
    patch: lines.join('\n'),
    language: 'typescript',
  };
}

function makeAddedFile(
  filename: string,
  additions: number,
  options: { trailingNewline?: boolean; suffix?: string } = {}
): FileChange {
  const patch = [
    `@@ -0,0 +1,${additions} @@${options.suffix ?? ' generated'}`,
    ...Array.from({ length: additions }, (_, index) => `+line ${index}`),
  ].join('\n');
  return {
    filename,
    status: 'added',
    additions,
    deletions: 0,
    patch: patch + (options.trailingNewline ? '\n' : ''),
    language: 'typescript',
  };
}

describe('chunkDiff', () => {
  it('returns no chunks for an empty diff', () => {
    expect(chunkDiff([])).toEqual([]);
  });

  it('splits at the file-count budget', () => {
    const files = Array.from({ length: 25 }, (_, index) => makeFile(`f${index}.ts`, 10));
    const chunks = chunkDiff(files);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.files).toHaveLength(20);
    expect(chunks[1]!.files).toHaveLength(5);
  });

  it('splits at the line budget', () => {
    const files = [makeFile('a.ts', 1500), makeFile('b.ts', 1500)];
    expect(chunkDiff(files)).toHaveLength(2);
  });

  it('splits an oversized single-file patch without losing any patch content', () => {
    const original = makeAddedFile('generated.ts', 5000);
    const chunks = chunkDiff([original]);
    const fragments = chunks.flatMap((chunk) => chunk.files);

    expect(chunks).toHaveLength(3);
    expect(fragments.map((fragment) => fragment.patch).join('')).toBe(original.patch);
    expect(fragments.reduce((sum, fragment) => sum + fragment.additions, 0)).toBe(5000);
    expect(fragments.reduce((sum, fragment) => sum + fragment.deletions, 0)).toBe(0);
    expect(chunks.map((chunk) => chunk.total)).toEqual([3, 3, 3]);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
    expect(chunks.every((chunk) => chunk.totalLines <= 2000)).toBe(true);
    expect(chunks.map(formatChunkForPrompt).join('\n')).not.toMatch(
      /patch truncated|no diff available/
    );
  });

  it('reheaders the first fragment to the exact partial hunk range', () => {
    const chunks = chunkDiff([makeAddedFile('generated.ts', 5000)]);
    const firstPrompt = formatChunkForPrompt(chunks[0]!);

    expect(firstPrompt).toContain('@@ -0,0 +1,1999 @@ generated');
    expect(firstPrompt).not.toContain('@@ -0,0 +1,5000 @@ generated');
  });

  it('preserves mixed normal, oversized, and patchless files in source order', () => {
    const before = makeFile('before.ts', 10);
    const oversized = makeAddedFile('generated.ts', 2500);
    const binary = {
      ...makeFile('image.png', 1),
      additions: 0,
      patch: '',
      blobSha: 'binary-blob-sha',
    };
    const after = makeFile('after.ts', 10);

    const chunks = chunkDiff([before, oversized, binary, after]);

    expect(chunks).toHaveLength(3);
    expect(chunks.flatMap((chunk) => chunk.files.map((file) => file.filename))).toEqual([
      'before.ts',
      'generated.ts',
      'generated.ts',
      'image.png',
      'after.ts',
    ]);
    expect(
      chunks
        .flatMap((chunk) => chunk.files)
        .filter((file) => file.filename === 'generated.ts')
        .map((file) => file.patch)
        .join('')
    ).toBe(oversized.patch);
    expect(
      chunks
        .flatMap((chunk) => chunk.files)
        .filter((file) => file.filename === 'image.png')
    ).toEqual([binary]);
    expect(chunks.map((chunk) => chunk.total)).toEqual([3, 3, 3]);
  });

  it('does not mutate the caller-owned file for oversized patches', () => {
    const original = makeAddedFile('generated.ts', 5000);
    const snapshot = { ...original };
    chunkDiff([original]);
    expect(original).toEqual(snapshot);
  });

  it('keeps an exact-budget patch with a trailing newline in one chunk', () => {
    const original = makeAddedFile('exact.ts', 1999, { trailingNewline: true });
    const [chunk] = chunkDiff([original]);
    expect(chunkDiff([original])).toHaveLength(1);
    expect(chunk!.totalLines).toBe(2000);
    expect(chunk!.files[0]!.patch).toBe(original.patch);
  });

  it('fails closed for an oversized patch without unified-diff hunk context', () => {
    expect(() => chunkDiff([makeFile('malformed.ts', 2500)])).toThrow(
      /Cannot safely split oversized patch.*expected a unified-diff hunk header/
    );
  });

  it('fails loudly before chunk fanout exceeds the paid-work safety bound', () => {
    const files = Array.from({ length: 33 }, (_, index) => makeFile(`large-${index}.ts`, 2000));

    expect(() => chunkDiff(files)).toThrow(/requires 33 review chunks.*safety limit of 32/i);
  });

  it('uses unified-diff anchor coordinates for one-sided continuation ranges', () => {
    const context = Array.from({ length: 1999 }, (_, index) => ` context ${index}`);
    const additions = {
      ...makeFile('additions.ts', 1),
      patch: ['@@ -10,1999 +20,2001 @@ addTail', ...context, '+late one', '+late two'].join(
        '\n'
      ),
      additions: 2,
    };
    const deletions = {
      ...makeFile('deletions.ts', 1),
      patch: [
        '@@ -10,2001 +20,1999 @@ deleteTail',
        ...context,
        '-late one',
        '-late two',
      ].join('\n'),
      additions: 0,
      deletions: 2,
    };

    expect(formatChunkForPrompt(chunkDiff([additions])[1]!)).toContain(
      '@@ -2008,0 +2019,2 @@ addTail'
    );
    expect(formatChunkForPrompt(chunkDiff([deletions])[1]!)).toContain(
      '@@ -2009,2 +2018,0 @@ deleteTail'
    );
  });

  it('keeps multiple hunks intact when the next header reaches a fragment boundary', () => {
    const patch = [
      '@@ -1,1998 +1,1998 @@ firstHunk',
      ...Array.from({ length: 1998 }, (_, index) => ` context ${index}`),
      '@@ -3000 +3000 @@ secondHunk',
      '-old',
      '+new',
    ].join('\n');
    const file = { ...makeFile('multi.ts', 1), patch, additions: 1, deletions: 1 };
    const chunks = chunkDiff([file]);

    expect(chunks).toHaveLength(2);
    expect(chunks.flatMap((chunk) => chunk.files).map((fragment) => fragment.patch).join('')).toBe(
      patch
    );
    expect(chunks[1]!.files[0]!.patch.startsWith('@@ -3000 +3000 @@ secondHunk')).toBe(true);
  });

  it('keeps a no-newline marker attached to its body line', () => {
    const marker = '\\ No newline at end of file';
    const original = makeAddedFile('no-newline.ts', 1999);
    original.patch += `\n${marker}`;
    const chunks = chunkDiff([original]);
    const fragments = chunks.flatMap((chunk) => chunk.files);

    expect(chunks).toHaveLength(2);
    expect(fragments[1]!.patch).toBe(`+line 1998\n${marker}`);
    expect(fragments.map((fragment) => fragment.patch).join('')).toBe(original.patch);
    expect(formatChunkForPrompt(chunks[1]!)).toContain('@@ -0,0 +1999,1 @@ generated');
  });
});

describe('formatChunkForPrompt', () => {
  it('marks binary or missing patches', () => {
    const file = { ...makeFile('img.png', 1), patch: '' };
    const [chunk] = chunkDiff([file]);
    expect(formatChunkForPrompt(chunk!)).toMatch(/binary or too large/);
  });

  it('includes chunk position when multiple chunks exist', () => {
    const chunks = chunkDiff([makeAddedFile('large.ts', 5000)]);
    expect(formatChunkForPrompt(chunks[2]!)).toContain('[Chunk 3 of 3]');
  });

  it('labels fragments and preserves hunk suffixes in continuation headers', () => {
    const patch = [
      '@@ -1,2500 +1,2500 @@ function large',
      ...Array.from({ length: 2500 }, (_, index) => ` unchanged ${index + 1}`),
    ].join('\n');
    const file = { ...makeFile('large.ts', 1), patch, additions: 0 };
    const chunks = chunkDiff([file]);

    expect(chunks).toHaveLength(2);
    expect(formatChunkForPrompt(chunks[0]!)).toContain('patch fragment 1 of 2');
    expect(formatChunkForPrompt(chunks[1]!)).toContain('patch fragment 2 of 2');
    expect(formatChunkForPrompt(chunks[1]!)).toContain(
      '@@ -2000,501 +2000,501 @@ function large'
    );
    expect(chunks.every((chunk) => chunk.totalLines <= 2000)).toBe(true);
  });
});
