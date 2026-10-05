import { readFile } from 'fs/promises';
import { detectLanguage } from '../prepare/language.js';
import type { Diff, FileChange } from './types.js';

interface ParsedHunk {
  filename: string;
  status: FileChange['status'];
  previousFilename?: string;
  patch: string;
  additions: number;
  deletions: number;
}

function invalidPath(): never {
  throw new Error('Git patch filename identity cannot be proven from its path metadata.');
}

/** Decode Git's C-quoted paths without trimming significant filename spaces. */
function decodePath(value: string): string {
  let path = value;
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) return invalidPath();
    const encoded = value.slice(1, -1);
    const bytes = Buffer.alloc(Buffer.byteLength(encoded));
    const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
    const tokens = /[^\\"\x00-\x1f]+|\\(?:[0-7]{3}|[abtnvfr"\\])/gy;
    let offset = 0, length = 0;
    while (offset < encoded.length) {
      const match = tokens.exec(encoded);
      if (!match) return invalidPath();
      const token = match[0];
      if (token.startsWith('\\')) {
        const byte = token.length === 4 ? Number.parseInt(token.slice(1), 8) : escapes[token[1]!]!;
        if (byte > 255) return invalidPath();
        bytes[length++] = byte;
      } else {
        length += bytes.write(token, length, 'utf8');
      }
      offset = tokens.lastIndex;
    }
    try { path = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
    catch { return invalidPath(); }
  } else if (/[\x00-\x1f\x7f"\\]/.test(value)) {
    return invalidPath();
  }
  // A replacement character can mean the Git output was decoded lossily.
  if (!path || path.includes('\0') || path.includes('\uFFFD')) return invalidPath();
  return path;
}

function headerMatches(header: string, aPath: string, bPath: string): boolean {
  if (header.startsWith('"')) {
    const first = /^"(?:[^"\\]|\\.)*"/.exec(header)?.[0];
    return first !== undefined && decodePath(first) === `a/${aPath}` &&
      header[first.length] === ' ' && decodePath(header.slice(first.length + 1)) === `b/${bPath}`;
  }
  const prefix = `a/${aPath} `;
  return header.startsWith(prefix) && decodePath(header.slice(prefix.length)) === `b/${bPath}`;
}

function symmetricHeaderPath(header: string): string {
  if (header.startsWith('"')) {
    const first = /^"(?:[^"\\]|\\.)*"/.exec(header)?.[0];
    if (!first) return invalidPath();
    const decoded = decodePath(first);
    if (!decoded.startsWith('a/')) return invalidPath();
    const path = decoded.slice(2);
    return path && headerMatches(header, path, path) ? path : invalidPath();
  }
  // Equal unquoted paths have one provable midpoint, even when either path
  // itself contains " b/". Never choose a greedy or first separator match.
  const length = (header.length - 5) / 2;
  if (!Number.isInteger(length) || length < 1) return invalidPath();
  const path = decodePath(header.slice(2, 2 + length));
  return headerMatches(header, path, path) ? path : invalidPath();
}

function parseDiffText(diffText: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  const fileBlocks = diffText.split(/^diff --git /m).slice(1);

  for (const block of fileBlocks) {
    const lines = block.split('\n');
    const headerLine = lines[0] ?? '';

    let status: FileChange['status'] = 'modified';
    let previousFilename: string | undefined;
    const patchStart = block.indexOf('\n@@');
    const metadata = (patchStart >= 0 ? block.slice(0, patchStart) : block).split('\n').slice(1);
    const field = (prefix: string): string | undefined => {
      const matches = metadata.filter(line => line.startsWith(prefix));
      if (matches.length > 1) return invalidPath();
      return matches[0]?.slice(prefix.length);
    };
    const deletedMatch = field('deleted file mode ');
    const newFileMatch = field('new file mode ');
    const renameFrom = field('rename from ');
    const renameTo = field('rename to ');
    if ((renameFrom === undefined) !== (renameTo === undefined) || (deletedMatch && newFileMatch)) return invalidPath();
    let aPath: string | undefined, bPath: string | undefined;

    if (deletedMatch) {
      status = 'deleted';
    } else if (newFileMatch) {
      status = 'added';
    } else if (renameFrom !== undefined && renameTo !== undefined) {
      status = 'renamed';
      aPath = previousFilename = decodePath(renameFrom);
      bPath = decodePath(renameTo);
    }

    const before = field('--- '), after = field('+++ ');
    if ((before === undefined) !== (after === undefined)) return invalidPath();
    if (before !== undefined && after !== undefined) {
      // Git adds a tab after an unquoted marker containing spaces. It is a
      // separator, not part of the path (actual tabs are C-quoted).
      const marker = (value: string, prefix: string): string | undefined => {
        const path = decodePath(value.endsWith('\t') ? value.slice(0, -1) : value);
        if (path === '/dev/null') return undefined;
        return path.startsWith(prefix) && path.length > 2 ? path.slice(2) : invalidPath();
      };
      const oldPath = marker(before, 'a/'), newPath = marker(after, 'b/');
      if ((oldPath === undefined) !== (status === 'added') ||
        (newPath === undefined) !== (status === 'deleted')) return invalidPath();
      if (aPath !== undefined && (aPath !== oldPath || bPath !== newPath)) return invalidPath();
      aPath = oldPath ?? newPath;
      bPath = newPath ?? oldPath;
    }
    if (aPath === undefined || bPath === undefined) aPath = bPath = symmetricHeaderPath(headerLine);
    if ((status !== 'renamed' && aPath !== bPath) || !headerMatches(headerLine, aPath, bPath)) return invalidPath();
    const filename = status === 'deleted' ? aPath : bPath;

    // Extract the actual patch lines (@@...)
    const patch = patchStart >= 0 ? block.slice(patchStart + 1) : '';

    let additions = 0;
    let deletions = 0;
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }

    hunks.push({
      filename,
      status,
      previousFilename,
      patch,
      additions,
      deletions,
    });
  }

  return hunks;
}

export async function loadLocalDiff(filePath: string): Promise<Diff> {
  const content = await readFile(filePath, 'utf-8');
  return parseDiffFromString(content);
}

export function parseDiffFromString(diffText: string): Diff {
  const hunks = parseDiffText(diffText);

  const files: FileChange[] = hunks.map((h) => ({
    filename: h.filename,
    status: h.status,
    additions: h.additions,
    deletions: h.deletions,
    patch: h.patch,
    language: detectLanguage(h.filename),
    previousFilename: h.previousFilename,
  }));

  return {
    files,
    source: 'local',
    rawDiff: diffText,
  };
}
