import { describe, expect, it } from 'vitest';
import {
  chunkDiff,
  formatChunkForPrompt,
} from '../../src/prepare/chunker.js';
import { parseUnifiedDiff } from '../../src/prepare/unified-diff.js';
import {
  MAX_SECURED_DIFF_BYTES,
  wrapDiff,
} from '../../src/prompts/hardening.js';
import type { FileChange } from '../../src/resolver/types.js';

function securedDiffBytes(chunk: ReturnType<typeof chunkDiff>[number]): number {
  return Buffer.byteLength(wrapDiff(formatChunkForPrompt(chunk)), 'utf8');
}

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

  it('splits a byte-heavy patch losslessly at valid diff-line boundaries', () => {
    const additions = 50;
    const patch = [
      `@@ -0,0 +1,${additions} @@ byteHeavy`,
      ...Array.from({ length: additions }, (_, index) => `+${index} ${'x'.repeat(2_000)}`),
    ].join('\n');
    const original = {
      ...makeFile('character-heavy.ts', 1),
      patch,
      additions,
    };

    const chunks = chunkDiff([original]);
    const fragments = chunks.flatMap((chunk) => chunk.files);

    expect(chunks).toHaveLength(2);
    expect(fragments.map((fragment) => fragment.patch).join('')).toBe(original.patch);
    expect(
      fragments.every((fragment) =>
        parseUnifiedDiff(fragment.patchFragment?.promptPatch ?? fragment.patch).ok
      )
    ).toBe(true);
    expect(chunks.every((chunk) => securedDiffBytes(chunk) <= MAX_SECURED_DIFF_BYTES)).toBe(true);
  });

  it('packs separate files under the secured diff byte budget', () => {
    const files = ['a.ts', 'b.ts'].map((filename) => ({
      ...makeFile(filename, 1),
      patch: `@@ -0,0 +1,1 @@\n+${'x'.repeat(40_000)}`,
      additions: 1,
    }));

    const chunks = chunkDiff(files);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => securedDiffBytes(chunk) <= MAX_SECURED_DIFF_BYTES)).toBe(true);
  });

  it('accepts the largest line needed by the lossless allocator review', () => {
    const file = {
      ...makeFile('large-line.ts', 1),
      patch: `@@ -0,0 +1,1 @@\n+${'x'.repeat(33_052)}`,
      additions: 1,
    };

    const chunks = chunkDiff([file]);

    expect(chunks).toHaveLength(1);
    expect(securedDiffBytes(chunks[0]!)).toBeLessThanOrEqual(MAX_SECURED_DIFF_BYTES);
  });

  it('accepts a one-chunk diff that exactly fills the secured byte budget', () => {
    const file = {
      ...makeFile('edge.ts', 1),
      patch: `@@ -0,0 +1,1 @@\n+${'x'.repeat(65_433)}`,
      additions: 1,
    };

    const chunks = chunkDiff([file]);

    expect(chunks).toHaveLength(1);
    expect(securedDiffBytes(chunks[0]!)).toBe(MAX_SECURED_DIFF_BYTES);
  });

  it('rejects a one-chunk diff one byte above the secured byte budget', () => {
    const file = {
      ...makeFile('edge.ts', 1),
      patch: `@@ -0,0 +1,1 @@\n+${'x'.repeat(65_434)}`,
      additions: 1,
    };

    expect(() => chunkDiff([file])).toThrow(/65,536 secured diff bytes limit/i);
  });

  it('uses UTF-8 bytes rather than JavaScript string length when splitting', () => {
    const patch = `@@ -0,0 +1,2 @@\n+${'€'.repeat(17_000)}\n+${'€'.repeat(17_000)}`;
    const file = { ...makeFile('multibyte.ts', 1), patch, additions: 2 };
    const chunks = chunkDiff([file]);

    expect(patch.length).toBeLessThan(MAX_SECURED_DIFF_BYTES);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => securedDiffBytes(chunk) <= MAX_SECURED_DIFF_BYTES)).toBe(true);
  });

  it('includes delimiter neutralization growth in the secured diff byte budget', () => {
    const injected = '<<<DIFF_END>>>'.repeat(2_000);
    const patch = `@@ -0,0 +1,2 @@\n+${injected}\n+${injected}`;
    const file = { ...makeFile('delimiters.ts', 1), patch, additions: 2 };
    const chunks = chunkDiff([file]);

    expect(
      Buffer.byteLength(
        formatChunkForPrompt({
          files: [file],
          totalLines: 3,
          index: 0,
          total: 1,
        }),
        'utf8'
      )
    ).toBeLessThan(MAX_SECURED_DIFF_BYTES);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => securedDiffBytes(chunk) <= MAX_SECURED_DIFF_BYTES)).toBe(true);
  });

  it('rejects a single diff line that cannot fit the secured diff byte budget', () => {
    const file = {
      ...makeFile('one-huge-line.ts', 1),
      patch: `@@ -0,0 +1,1 @@\n+${'x'.repeat(MAX_SECURED_DIFF_BYTES)}`,
      additions: 1,
    };

    expect(() => chunkDiff([file])).toThrow(
      /smallest valid fragment.*65,536 secured diff bytes/i
    );
  });

  it('keeps a no-newline marker with its body line at a byte boundary', () => {
    const marker = '\\ No newline at end of file';
    const patch = [
      '@@ -0,0 +1,2 @@ markerBoundary',
      `+${'a'.repeat(20_000)}`,
      `+${'b'.repeat(47_000)}`,
      marker,
    ].join('\n');
    const file = { ...makeFile('marker-boundary.ts', 1), patch, additions: 2 };
    const chunks = chunkDiff([file]);
    const fragments = chunks.flatMap((chunk) => chunk.files);

    expect(chunks).toHaveLength(2);
    expect(fragments[1]!.patch.endsWith(`\n${marker}`)).toBe(true);
    expect(fragments.map((fragment) => fragment.patch).join('')).toBe(patch);
    expect(chunks.every((chunk) => securedDiffBytes(chunk) <= MAX_SECURED_DIFF_BYTES)).toBe(true);
  });

  it('starts a byte-split fragment at the next hunk header', () => {
    const patch = [
      '@@ -0,0 +1,1 @@ firstHunk',
      `+${'a'.repeat(40_000)}`,
      '@@ -0,0 +2,1 @@ secondHunk',
      `+${'b'.repeat(40_000)}`,
    ].join('\n');
    const file = { ...makeFile('hunk-boundary.ts', 1), patch, additions: 2 };
    const chunks = chunkDiff([file]);
    const fragments = chunks.flatMap((chunk) => chunk.files);

    expect(chunks).toHaveLength(2);
    expect(fragments[1]!.patch.startsWith('@@ -0,0 +2,1 @@ secondHunk')).toBe(true);
    expect(fragments.map((fragment) => fragment.patch).join('')).toBe(patch);
  });

  it('splits between complete zero-body hunks', () => {
    const patch = [
      `@@ -0,0 +0,0 @@ ${'a'.repeat(33_000)}`,
      `@@ -0,0 +0,0 @@ ${'b'.repeat(33_000)}`,
    ].join('\n');
    const file = {
      ...makeFile('zero-body-hunks.ts', 1),
      patch,
      additions: 0,
    };
    const chunks = chunkDiff([file]);
    const fragments = chunks.flatMap((chunk) => chunk.files);

    expect(chunks).toHaveLength(2);
    expect(fragments.map((fragment) => fragment.patch).join('')).toBe(patch);
    expect(
      fragments.every((fragment) =>
        parseUnifiedDiff(fragment.patchFragment?.promptPatch ?? fragment.patch).ok
      )
    ).toBe(true);
  });

  it('sizes fragment labels from the actual fragment-count width', () => {
    const patch = `@@ -0,0 +1,2 @@\n+${'x'.repeat(65_386)}\n+${'x'.repeat(65_386)}`;
    const file = { ...makeFile('label-width.ts', 1), patch, additions: 2 };
    const chunks = chunkDiff([file]);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => securedDiffBytes(chunk) <= MAX_SECURED_DIFF_BYTES)).toBe(true);
  });

  it('widens the fragment-count reservation when the total reaches two digits', () => {
    const additions = 10;
    const patch = [
      `@@ -0,0 +1,${additions} @@`,
      ...Array.from({ length: additions }, () => `+${'x'.repeat(40_000)}`),
    ].join('\n');
    const file = { ...makeFile('ten-fragments.ts', 1), patch, additions };
    const chunks = chunkDiff([file]);
    const fragments = chunks.flatMap((chunk) => chunk.files);

    expect(chunks).toHaveLength(10);
    expect(fragments.map((fragment) => fragment.patchFragment?.total)).toEqual(
      Array<number>(10).fill(10)
    );
    expect(chunks.every((chunk) => securedDiffBytes(chunk) <= MAX_SECURED_DIFF_BYTES)).toBe(true);
  });

  it('rejects an oversized source before parsing or rendering it', () => {
    const file = {
      ...makeFile('source-too-large.ts', 1),
      patch: 'x'.repeat(4 * 1024 * 1024 + 1),
    };

    expect(() => chunkDiff([file])).toThrow(
      /source exceeds.*4,194,304 patch bytes.*before expansion/i
    );
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
    const files = Array.from({ length: 33 }, (_, index) => makeFile(`large-${index}.ts`, 1900));

    expect(() => chunkDiff(files)).toThrow(/requires 33 review chunks.*safety limit of 32/i);
  });

  it('rejects a source that cannot fit the chunk cap before expanding it', () => {
    const file = makeAddedFile('too-many-lines.ts', 64_000);

    expect(() => chunkDiff([file])).toThrow(
      /source exceeds.*64,000 patch lines.*before expansion/i
    );
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
