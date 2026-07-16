import type { FileChange } from '../resolver/types.js';

export interface Chunk {
  files: FileChange[];
  totalLines: number;
  index: number;
  total: number;
}

const MAX_CHUNK_LINES = 2000;
const MAX_CHUNK_FILES = 20;

function countDiffLines(patch: string): number {
  return patch.split('\n').length;
}

export function chunkDiff(files: FileChange[]): Chunk[] {
  if (files.length === 0) return [];

  const chunks: FileChange[][] = [];
  let currentChunk: FileChange[] = [];
  let currentLines = 0;

  for (const file of files) {
    const fileLines = countDiffLines(file.patch);

    // If a single file is huge, it gets its own chunk — capped, so a
    // generated 100k-line patch can't blow the model context window.
    if (fileLines > MAX_CHUNK_LINES) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentLines = 0;
      }
      const omitted = fileLines - MAX_CHUNK_LINES;
      console.warn(
        `Warning: ${file.filename} has a ${fileLines}-line patch; truncating to ${MAX_CHUNK_LINES} lines (${omitted} omitted)`
      );
      const truncatedPatch = [
        ...file.patch.split('\n').slice(0, MAX_CHUNK_LINES),
        `[rcl: patch truncated after ${MAX_CHUNK_LINES} lines — ${omitted} lines omitted]`,
      ].join('\n');
      chunks.push([{ ...file, patch: truncatedPatch }]);
      continue;
    }

    // Start a new chunk if limits exceeded
    if (
      currentChunk.length >= MAX_CHUNK_FILES ||
      (currentLines + fileLines > MAX_CHUNK_LINES && currentChunk.length > 0)
    ) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentLines = 0;
    }

    currentChunk.push(file);
    currentLines += fileLines;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks.map((files, index) => ({
    files,
    totalLines: files.reduce((sum, f) => sum + countDiffLines(f.patch), 0),
    index,
    total: chunks.length,
  }));
}

export function formatChunkForPrompt(chunk: Chunk): string {
  const parts: string[] = [];

  if (chunk.total > 1) {
    parts.push(`[Chunk ${chunk.index + 1} of ${chunk.total}]`);
  }

  for (const file of chunk.files) {
    parts.push(`\n### File: ${file.filename} (${file.language}, ${file.status})`);
    if (file.patch) {
      parts.push('```diff');
      parts.push(file.patch);
      parts.push('```');
    } else {
      parts.push('*(no diff available — file may be binary or too large)*');
    }
  }

  return parts.join('\n');
}
