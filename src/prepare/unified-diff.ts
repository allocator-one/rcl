export const NO_NEWLINE_MARKER = '\\ No newline at end of file';

export interface UnifiedDiffLine {
  index: number;
  text: string;
  oldLine: number;
  newLine: number;
  oldCount: number;
  newCount: number;
  suffix: string;
  marker: boolean;
}

export interface UnifiedDiffHunk {
  originalHeader: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  suffix: string;
  body: UnifiedDiffLine[];
}

export interface ParsedUnifiedDiff {
  lines: string[];
  trailingNewline: boolean;
  hunks: UnifiedDiffHunk[];
  positions: Array<UnifiedDiffLine | undefined>;
}

export type UnifiedDiffParseResult =
  | { ok: true; diff: ParsedUnifiedDiff }
  | { ok: false; line: number; reason: string };

interface HunkHeader {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  suffix: string;
}

export function splitPatchLines(
  patch: string
): { lines: string[]; trailingNewline: boolean } {
  if (patch.length === 0) return { lines: [], trailingNewline: false };

  const lines = patch.split('\n');
  const trailingNewline = patch.endsWith('\n');
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function parseHunkHeader(line: string): HunkHeader | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
  if (!match) return undefined;

  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)) return undefined;

  return { oldStart, oldCount, newStart, newCount, suffix: match[5] ?? '' };
}

export function parseUnifiedDiff(patch: string): UnifiedDiffParseResult {
  const { lines, trailingNewline } = splitPatchLines(patch);
  const positions: Array<UnifiedDiffLine | undefined> = new Array(lines.length);
  const hunks: UnifiedDiffHunk[] = [];
  let current: UnifiedDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let previousWasBodyLine = false;

  const failure = (line: number, reason: string): UnifiedDiffParseResult => ({
    ok: false,
    line,
    reason,
  });

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!;
    const header = parseHunkHeader(text);
    if (header) {
      if (current && (oldRemaining !== 0 || newRemaining !== 0)) {
        return failure(index + 1, 'hunk body does not match its declared ranges');
      }
      if (
        (header.oldCount > 0 && header.oldStart === 0) ||
        (header.newCount > 0 && header.newStart === 0)
      ) {
        return failure(index + 1, 'hunk range starts at line zero');
      }
      current = { originalHeader: text, ...header, body: [] };
      hunks.push(current);
      oldLine = header.oldStart + (header.oldCount === 0 ? 1 : 0);
      newLine = header.newStart + (header.newCount === 0 ? 1 : 0);
      oldRemaining = header.oldCount;
      newRemaining = header.newCount;
      previousWasBodyLine = false;
      continue;
    }

    if (!current) return failure(index + 1, 'expected a unified-diff hunk header');
    if (text === NO_NEWLINE_MARKER) {
      if (!previousWasBodyLine) {
        return failure(index + 1, 'no-newline marker is not attached to a body line');
      }
      const marker: UnifiedDiffLine = {
        index,
        text,
        oldLine,
        newLine,
        oldCount: 0,
        newCount: 0,
        suffix: current.suffix,
        marker: true,
      };
      current.body.push(marker);
      positions[index] = marker;
      previousWasBodyLine = false;
      continue;
    }

    let consumesOld = 0;
    let consumesNew = 0;
    if (text.startsWith(' ')) {
      consumesOld = 1;
      consumesNew = 1;
    } else if (text.startsWith('-')) {
      consumesOld = 1;
    } else if (text.startsWith('+')) {
      consumesNew = 1;
    } else {
      return failure(index + 1, 'expected a unified-diff body line');
    }

    if (oldRemaining < consumesOld) {
      return failure(
        index + 1,
        `${consumesNew === 1 ? 'context line' : 'deletion'} exceeds the declared old-file range`
      );
    }
    if (newRemaining < consumesNew) {
      return failure(
        index + 1,
        `${consumesOld === 1 ? 'context line' : 'addition'} exceeds the declared new-file range`
      );
    }

    const bodyLine: UnifiedDiffLine = {
      index,
      text,
      oldLine,
      newLine,
      oldCount: consumesOld,
      newCount: consumesNew,
      suffix: current.suffix,
      marker: false,
    };
    current.body.push(bodyLine);
    positions[index] = bodyLine;
    oldLine += consumesOld;
    newLine += consumesNew;
    oldRemaining -= consumesOld;
    newRemaining -= consumesNew;
    previousWasBodyLine = true;
  }

  if (!current) return failure(1, 'expected a unified-diff hunk header');
  if (oldRemaining !== 0 || newRemaining !== 0) {
    return failure(Math.max(1, lines.length), 'hunk body does not match its declared ranges');
  }

  return { ok: true, diff: { lines, trailingNewline, hunks, positions } };
}

export function formatSyntheticHunkHeader(body: readonly UnifiedDiffLine[]): string | undefined {
  const first = body[0];
  if (!first || first.marker) return undefined;

  const oldCount = body.reduce((sum, line) => sum + line.oldCount, 0);
  const newCount = body.reduce((sum, line) => sum + line.newCount, 0);
  const oldStart = oldCount === 0 ? first.oldLine - 1 : first.oldLine;
  const newStart = newCount === 0 ? first.newLine - 1 : first.newLine;
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${first.suffix}`;
}
