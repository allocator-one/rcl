import { describe, it, expect, vi, afterEach } from 'vitest';
import { chunkDiff, formatChunkForPrompt } from '../../src/prepare/chunker.js';
import type { FileChange } from '../../src/resolver/types.js';

function makeFile(filename: string, patchLines: number): FileChange {
  const lines = Array.from({ length: patchLines }, (_, i) => `+line ${i}`);
  return {
    filename,
    status: 'modified',
    additions: patchLines,
    deletions: 0,
    patch: lines.join('\n'),
    language: 'typescript',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chunkDiff', () => {
  it('returns no chunks for an empty diff', () => {
    expect(chunkDiff([])).toEqual([]);
  });

  it('splits at the file-count budget', () => {
    const files = Array.from({ length: 25 }, (_, i) => makeFile(`f${i}.ts`, 10));
    const chunks = chunkDiff(files);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.files).toHaveLength(20);
    expect(chunks[1]!.files).toHaveLength(5);
  });

  it('splits at the line budget', () => {
    const files = [makeFile('a.ts', 1500), makeFile('b.ts', 1500)];
    const chunks = chunkDiff(files);
    expect(chunks).toHaveLength(2);
  });

  it('caps an oversized single-file patch with an explicit truncation marker', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = chunkDiff([makeFile('generated.ts', 5000)]);

    expect(chunks).toHaveLength(1);
    const patch = chunks[0]!.files[0]!.patch;
    const patchLines = patch.split('\n');
    expect(patchLines.length).toBeLessThanOrEqual(2001);
    expect(patch).toMatch(/truncated after 2000 lines/);
    expect(patch).toMatch(/3000 .*omitted/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('generated.ts'));
  });

  it('does not mutate the caller-owned file for oversized patches', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const original = makeFile('generated.ts', 5000);
    chunkDiff([original]);
    expect(original.patch.split('\n')).toHaveLength(5000);
  });
});

describe('formatChunkForPrompt', () => {
  it('marks binary or missing patches', () => {
    const file = { ...makeFile('img.png', 1), patch: '' };
    const [chunk] = chunkDiff([file]);
    expect(formatChunkForPrompt(chunk!)).toMatch(/binary or too large/);
  });

  it('includes chunk position when multiple chunks exist', () => {
    const files = Array.from({ length: 25 }, (_, i) => makeFile(`f${i}.ts`, 10));
    const chunks = chunkDiff(files);
    expect(formatChunkForPrompt(chunks[1]!)).toContain('[Chunk 2 of 2]');
  });
});
