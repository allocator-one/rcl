import type { FileChange } from '../resolver/types.js';
import {
  formatSyntheticHunkHeader,
  NO_NEWLINE_MARKER,
  parseUnifiedDiff,
  type UnifiedDiffLine,
} from './unified-diff.js';

interface PatchFragment {
  index: number;
  total: number;
  promptPatch: string;
}

interface ChunkFile extends FileChange {
  patchFragment?: PatchFragment;
}

export interface Chunk {
  files: ChunkFile[];
  totalLines: number;
  index: number;
  total: number;
}

const MAX_CHUNK_LINES = 2000;
const MAX_CHUNK_FILES = 20;
// Every blocking reviewer receives every chunk. This leaves ample headroom
// above the 18-chunk lossless dogfood case without letting an adversarial
// 10MB patch create an unbounded paid-call fanout.
const MAX_CHUNKS_PER_REVIEW = 32;
const MAX_SOURCE_PATCH_LINES = MAX_CHUNK_LINES * MAX_CHUNKS_PER_REVIEW;
const MAX_SOURCE_FILES = MAX_CHUNK_FILES * MAX_CHUNKS_PER_REVIEW;

function countDiffLines(patch: string): number {
  if (patch.length === 0) return 0;

  let count = 1;
  for (let index = 0; index < patch.length; index += 1) {
    if (patch.charCodeAt(index) === 10) count += 1;
  }
  return patch.endsWith('\n') ? count - 1 : count;
}

function assertSourceFitsExpansionBounds(files: readonly FileChange[]): void {
  if (files.length > MAX_SOURCE_FILES) {
    throw new Error(
      `Diff source exceeds the lossless safety capacity of ${MAX_SOURCE_FILES} files before ` +
        `expansion. Split the diff into smaller review targets.`
    );
  }

  let sourceLines = 0;
  for (const file of files) {
    sourceLines += countDiffLines(file.patch);
    if (sourceLines > MAX_SOURCE_PATCH_LINES) {
      throw new Error(
        `Diff source exceeds the lossless safety capacity of ` +
          `${MAX_SOURCE_PATCH_LINES.toLocaleString('en-US')} patch lines before expansion. ` +
          `Split the diff into smaller review targets.`
      );
    }
  }
}

function invalidOversizedPatch(file: FileChange, line: number, reason: string): never {
  throw new Error(
    `Cannot safely split oversized patch for ${file.filename}: ${reason} at patch line ${line}`
  );
}

function formatFragmentPatch(
  lines: string[],
  positions: Array<UnifiedDiffLine | undefined>,
  start: number,
  end: number
): string {
  const formatted: string[] = [];
  let originalHeader: string | undefined;
  let body: UnifiedDiffLine[] = [];

  const flushHunk = (): void => {
    if (body.length > 0) {
      const header = formatSyntheticHunkHeader(body);
      if (!header) throw new Error('Cannot format a patch fragment that starts with a marker');
      formatted.push(header, ...body.map((line) => line.text));
    } else if (originalHeader) {
      formatted.push(originalHeader);
    }
    originalHeader = undefined;
    body = [];
  };

  for (let index = start; index < end; index += 1) {
    const line = positions[index];
    if (line) {
      body.push(line);
    } else {
      flushHunk();
      originalHeader = lines[index]!;
    }
  }
  flushHunk();
  return formatted.join('\n');
}

function slicePatch(
  lines: string[],
  start: number,
  end: number,
  trailingNewline: boolean
): string {
  const needsTrailingNewline = end < lines.length || trailingNewline;
  return lines.slice(start, end).join('\n') + (needsTrailingNewline ? '\n' : '');
}

function countChanges(
  positions: Array<UnifiedDiffLine | undefined>,
  start: number,
  end: number
): Pick<FileChange, 'additions' | 'deletions'> {
  let additions = 0;
  let deletions = 0;
  for (let index = start; index < end; index += 1) {
    const line = positions[index];
    if (!line) continue;
    additions += line.newCount === 1 && line.oldCount === 0 ? 1 : 0;
    deletions += line.oldCount === 1 && line.newCount === 0 ? 1 : 0;
  }
  return { additions, deletions };
}

function splitPatch(file: FileChange): ChunkFile[] {
  const parsed = parseUnifiedDiff(file.patch);
  if (!parsed.ok) invalidOversizedPatch(file, parsed.line, parsed.reason);
  const { lines, trailingNewline, positions } = parsed.diff;
  const ranges: Array<{ start: number; end: number; promptPatch: string }> = [];
  let start = 0;

  while (start < lines.length) {
    const hasContinuationHeader = positions[start] !== undefined;
    const lineBudget = MAX_CHUNK_LINES - (hasContinuationHeader ? 1 : 0);
    let end = Math.min(start + lineBudget, lines.length);

    if (end < lines.length) {
      // Keep Git's no-newline marker attached to the content line it describes.
      if (lines[end] === NO_NEWLINE_MARKER && end - start > 1) end -= 1;
      // Do not strand a hunk header as the final line of a fragment.
      if (positions[end - 1] === undefined && end - start > 1) end -= 1;
    }

    ranges.push({
      start,
      end,
      promptPatch: formatFragmentPatch(lines, positions, start, end),
    });
    start = end;
  }

  return ranges.map(({ start, end, promptPatch }, index) => ({
    ...file,
    ...countChanges(positions, start, end),
    patch: slicePatch(lines, start, end, trailingNewline),
    patchFragment: {
      index,
      total: ranges.length,
      promptPatch,
    },
  }));
}

function promptDiffLines(file: ChunkFile): number {
  return countDiffLines(file.patchFragment?.promptPatch ?? file.patch);
}

export function chunkDiff(files: FileChange[]): Chunk[] {
  if (files.length === 0) return [];
  // More source lines/files than every allowed chunk can hold cannot possibly
  // pass the final exact packing check. Reject that lower bound before the
  // strict parser and fragment renderer amplify it into per-line objects and
  // duplicate strings.
  assertSourceFitsExpansionBounds(files);

  const expandedFiles: ChunkFile[] = files.flatMap((file) =>
    countDiffLines(file.patch) > MAX_CHUNK_LINES ? splitPatch(file) : [file]
  );
  const chunks: ChunkFile[][] = [];
  let currentChunk: ChunkFile[] = [];
  let currentLines = 0;

  for (const file of expandedFiles) {
    const fileLines = promptDiffLines(file);

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

  if (currentChunk.length > 0) chunks.push(currentChunk);

  if (chunks.length > MAX_CHUNKS_PER_REVIEW) {
    throw new Error(
      `Diff requires ${chunks.length} review chunks, exceeding the paid-work safety limit of ` +
        `${MAX_CHUNKS_PER_REVIEW}. Split the diff into smaller review targets.`
    );
  }

  return chunks.map((chunkFiles, index) => ({
    files: chunkFiles,
    totalLines: chunkFiles.reduce((sum, file) => sum + promptDiffLines(file), 0),
    index,
    total: chunks.length,
  }));
}

export function formatChunkForPrompt(chunk: Chunk): string {
  const parts: string[] = [];

  if (chunk.total > 1) parts.push(`[Chunk ${chunk.index + 1} of ${chunk.total}]`);

  for (const file of chunk.files) {
    const fragment = file.patchFragment;
    const fragmentLabel = fragment
      ? `; patch fragment ${fragment.index + 1} of ${fragment.total}`
      : '';
    parts.push(`\n### File: ${file.filename} (${file.language}, ${file.status}${fragmentLabel})`);
    if (file.patch) {
      parts.push('```diff');
      const promptPatch = fragment?.promptPatch ?? file.patch;
      parts.push(promptPatch.endsWith('\n') ? promptPatch.slice(0, -1) : promptPatch);
      parts.push('```');
    } else {
      parts.push('*(no diff available — file may be binary or too large)*');
    }
  }

  return parts.join('\n');
}
