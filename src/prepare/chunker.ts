import type { FileChange } from '../resolver/types.js';
import {
  MAX_SECURED_DIFF_BYTES,
  securedDiffByteLength,
} from '../prompts/hardening.js';
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
const MAX_SOURCE_PATCH_BYTES = 4 * 1024 * 1024;

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
  let sourceBytes = 0;
  for (const file of files) {
    sourceLines += countDiffLines(file.patch);
    if (sourceLines > MAX_SOURCE_PATCH_LINES) {
      throw new Error(
        `Diff source exceeds the lossless safety capacity of ` +
          `${MAX_SOURCE_PATCH_LINES.toLocaleString('en-US')} patch lines before expansion. ` +
          `Split the diff into smaller review targets.`
      );
    }

    sourceBytes += Buffer.byteLength(file.patch, 'utf8');
    if (sourceBytes > MAX_SOURCE_PATCH_BYTES) {
      throw new Error(
        `Diff source exceeds the lossless safety capacity of ` +
          `${MAX_SOURCE_PATCH_BYTES.toLocaleString('en-US')} patch bytes before expansion. ` +
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

function promptDiffLines(file: ChunkFile): number {
  return countDiffLines(file.patchFragment?.promptPatch ?? file.patch);
}

function probeChunk(files: ChunkFile[]): Chunk {
  return {
    files,
    totalLines: files.reduce((sum, file) => sum + promptDiffLines(file), 0),
    // Reserve the widest legal chunk label while sizing. Accepted reviews can
    // never use an index or total above this bound.
    index: MAX_CHUNKS_PER_REVIEW - 1,
    total: MAX_CHUNKS_PER_REVIEW,
  };
}

function securedDiffBytes(files: ChunkFile[]): number {
  return securedDiffByteLength(formatChunkForPrompt(probeChunk(files)));
}

function probeFragment(
  file: FileChange,
  promptPatch: string,
  fragmentIndex: number,
  totalDigits: number
): ChunkFile {
  return {
    ...file,
    patchFragment: {
      index: fragmentIndex,
      // Only the decimal width affects the label size. The allocation loop
      // widens this placeholder if its result crosses 10 or 100 fragments.
      total: 10 ** totalDigits - 1,
      promptPatch,
    },
  };
}

function isLegalFragmentEnd(
  lines: readonly string[],
  positions: ReadonlyArray<UnifiedDiffLine | undefined>,
  end: number
): boolean {
  if (end === lines.length) return true;
  // Keep Git's no-newline marker attached to the content line it describes.
  if (lines[end] === NO_NEWLINE_MARKER) return false;
  // Do not strand a non-empty hunk header. After a successful full parse, two
  // adjacent headers imply that the first has a complete zero-length body.
  return positions[end - 1] !== undefined || positions[end] === undefined;
}

interface FragmentCandidate {
  end: number;
  promptPatch: string;
  securedBytes: number;
}

function fragmentCandidate(
  file: FileChange,
  lines: string[],
  positions: Array<UnifiedDiffLine | undefined>,
  start: number,
  end: number,
  fragmentIndex: number,
  totalDigits: number
): FragmentCandidate {
  const promptPatch = formatFragmentPatch(lines, positions, start, end);
  return {
    end,
    promptPatch,
    securedBytes: securedDiffBytes([
      probeFragment(file, promptPatch, fragmentIndex, totalDigits),
    ]),
  };
}

function largestFittingFragment(
  file: FileChange,
  lines: string[],
  positions: Array<UnifiedDiffLine | undefined>,
  start: number,
  legalEnds: number[],
  fragmentIndex: number,
  totalDigits: number
): FragmentCandidate | undefined {
  let low = 0;
  let high = legalEnds.length - 1;
  let best: FragmentCandidate | undefined;

  // Adding a legal range can only append body lines or complete hunks; the
  // synthetic header counts and secured byte length are therefore monotonic.
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = fragmentCandidate(
      file,
      lines,
      positions,
      start,
      legalEnds[middle]!,
      fragmentIndex,
      totalDigits
    );
    if (candidate.securedBytes <= MAX_SECURED_DIFF_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best;
}

interface PatchRange {
  start: number;
  end: number;
  promptPatch: string;
}

function allocatePatchRanges(
  file: FileChange,
  lines: string[],
  positions: Array<UnifiedDiffLine | undefined>,
  totalDigits: number
): PatchRange[] {
  const ranges: Array<{ start: number; end: number; promptPatch: string }> = [];
  let start = 0;

  while (start < lines.length) {
    const hasContinuationHeader = positions[start] !== undefined;
    const lineBudget = MAX_CHUNK_LINES - (hasContinuationHeader ? 1 : 0);
    const maximumEnd = Math.min(start + lineBudget, lines.length);
    const legalEnds: number[] = [];
    for (let end = start + 1; end <= maximumEnd; end += 1) {
      if (isLegalFragmentEnd(lines, positions, end)) legalEnds.push(end);
    }

    if (legalEnds.length === 0) {
      invalidOversizedPatch(
        file,
        start + 1,
        `the smallest valid fragment exceeds the ${MAX_CHUNK_LINES.toLocaleString('en-US')} ` +
          `patch-line limit`
      );
    }

    const selected = largestFittingFragment(
      file,
      lines,
      positions,
      start,
      legalEnds,
      ranges.length,
      totalDigits
    );
    if (!selected) {
      const smallest = fragmentCandidate(
        file,
        lines,
        positions,
        start,
        legalEnds[0]!,
        ranges.length,
        totalDigits
      );
      invalidOversizedPatch(
        file,
        start + 1,
        `the smallest valid fragment exceeds the ` +
          `${MAX_SECURED_DIFF_BYTES.toLocaleString('en-US')} secured diff bytes limit ` +
          `(requires ${smallest.securedBytes.toLocaleString('en-US')} bytes)`
      );
    }

    const { end, promptPatch } = selected;
    ranges.push({
      start,
      end,
      promptPatch,
    });
    if (ranges.length > MAX_SOURCE_FILES) {
      throw new Error(
        `Diff requires more than ${MAX_SOURCE_FILES} file fragments, exceeding the paid-work ` +
          `safety capacity. Split the diff into smaller review targets.`
      );
    }
    start = end;
  }

  return ranges;
}

function splitPatch(file: FileChange): ChunkFile[] {
  const parsed = parseUnifiedDiff(file.patch);
  if (!parsed.ok) invalidOversizedPatch(file, parsed.line, parsed.reason);
  const { lines, trailingNewline, positions } = parsed.diff;

  let totalDigits = 1;
  let ranges: PatchRange[];
  while (true) {
    ranges = allocatePatchRanges(
      file,
      lines,
      positions,
      totalDigits
    );
    const requiredDigits = ranges.length.toString().length;
    if (requiredDigits <= totalDigits) break;
    totalDigits = requiredDigits;
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

export function chunkDiff(files: FileChange[]): Chunk[] {
  if (files.length === 0) return [];
  // More source lines/files than every allowed chunk can hold cannot possibly
  // pass the final exact packing check. Reject that lower bound before the
  // strict parser and fragment renderer amplify it into per-line objects and
  // duplicate strings.
  assertSourceFitsExpansionBounds(files);

  const sourceLines = files.reduce((sum, file) => sum + countDiffLines(file.patch), 0);
  if (files.length <= MAX_CHUNK_FILES && sourceLines <= MAX_CHUNK_LINES) {
    const singleChunk: Chunk = {
      files,
      totalLines: sourceLines,
      index: 0,
      total: 1,
    };
    if (securedDiffByteLength(formatChunkForPrompt(singleChunk)) <= MAX_SECURED_DIFF_BYTES) {
      return [singleChunk];
    }
  }

  const expandedFiles: ChunkFile[] = [];
  for (const file of files) {
    const fileLines = countDiffLines(file.patch);
    if (fileLines <= MAX_CHUNK_LINES && securedDiffBytes([file]) <= MAX_SECURED_DIFF_BYTES) {
      expandedFiles.push(file);
    } else if (file.patch.length === 0) {
      throw new Error(
        `Cannot safely review ${file.filename}: its rendered file metadata exceeds the ` +
          `${MAX_SECURED_DIFF_BYTES.toLocaleString('en-US')} secured diff bytes limit.`
      );
    } else {
      expandedFiles.push(...splitPatch(file));
    }

    if (expandedFiles.length > MAX_SOURCE_FILES) {
      throw new Error(
        `Diff expands to more than ${MAX_SOURCE_FILES} file entries, exceeding the paid-work ` +
          `safety capacity. Split the diff into smaller review targets.`
      );
    }
  }
  const chunks: ChunkFile[][] = [];
  let currentChunk: ChunkFile[] = [];
  let currentLines = 0;

  for (const file of expandedFiles) {
    const fileLines = promptDiffLines(file);
    const singleFileBytes = securedDiffBytes([file]);
    if (fileLines > MAX_CHUNK_LINES || singleFileBytes > MAX_SECURED_DIFF_BYTES) {
      throw new Error(
        `Cannot safely review ${file.filename}: one file entry requires ` +
          `${singleFileBytes.toLocaleString('en-US')} secured diff bytes.`
      );
    }

    if (
      currentChunk.length >= MAX_CHUNK_FILES ||
      (currentLines + fileLines > MAX_CHUNK_LINES && currentChunk.length > 0) ||
      (currentChunk.length > 0 &&
        securedDiffBytes([...currentChunk, file]) > MAX_SECURED_DIFF_BYTES)
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

  const result = chunks.map((chunkFiles, index) => ({
    files: chunkFiles,
    totalLines: chunkFiles.reduce((sum, file) => sum + promptDiffLines(file), 0),
    index,
    total: chunks.length,
  }));

  for (const chunk of result) {
    const bytes = securedDiffByteLength(formatChunkForPrompt(chunk));
    if (bytes > MAX_SECURED_DIFF_BYTES) {
      throw new Error(
        `Internal chunking error: chunk ${chunk.index + 1} requires ` +
          `${bytes.toLocaleString('en-US')} secured diff bytes, exceeding the ` +
          `${MAX_SECURED_DIFF_BYTES.toLocaleString('en-US')} byte limit.`
      );
    }
  }

  return result;
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
