import type { FileChange, LeftOutPaths } from './types.js';

/** Paths listed in the evidence; `count` always carries the full number. */
const MAX_LISTED_PATHS = 100;

/** `.gitattributes` files are the policy itself and are never left out of review. */
const ATTRIBUTES_FILE = '.gitattributes';

const ATTRIBUTE = 'linguist-generated';

/**
 * Translate a gitattributes pattern into a regular expression over
 * repository-relative paths, or `null` for syntax this reader does not
 * implement. The caller must not read `null` as "matches nothing": a rule that
 * is not understood may unset an earlier one (see generatedPathMatcher).
 *
 * Rules follow gitattributes(5): a pattern without a slash matches the base
 * name at any depth; one with a slash is anchored at the repository root;
 * `*` and `?` never cross `/`; `**` crosses it only as a whole path
 * segment; a trailing slash never matches (attributes apply to files).
 */
function patternToRegExp(pattern: string): RegExp | null {
  if (pattern.startsWith('"') || pattern.startsWith('!') || pattern.endsWith('/')) return null;
  const anchored = pattern.includes('/');
  const source = anchored && pattern.startsWith('/') ? pattern.slice(1) : pattern;
  if (source.length === 0) return null;

  let body = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '*') {
      const doubled = source[index + 1] === '*';
      const atSegmentStart = index === 0 || source[index - 1] === '/';
      if (doubled && atSegmentStart && source[index + 2] === '/') {
        body += '(?:.*/)?';
        index += 2;
      } else if (doubled && atSegmentStart && index + 2 === source.length) {
        body += '.*';
        index += 1;
      } else {
        body += '[^/]*';
        if (doubled) index += 1;
      }
    } else if (char === '?') {
      body += '[^/]';
    } else if (char === '[') {
      const close = source.indexOf(']', index + 2);
      if (close === -1) {
        body += '\\[';
        continue;
      }
      let set = source.slice(index + 1, close);
      const negated = set.startsWith('!') || set.startsWith('^');
      if (negated) set = set.slice(1);
      // A bracket expression never matches a path separator, whatever its set or range holds.
      body += `(?!/)[${negated ? '^' : ''}${set.replace(/[\\\]^]/g, '\\$&')}]`;
      index = close;
    } else if (char === '\\') {
      index += 1;
      if (index >= source.length) return null;
      body += source[index]!.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
    } else {
      body += char.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
    }
  }
  try {
    return new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
  } catch {
    return null;
  }
}

type Verdict = boolean | undefined;

/** The value one attribute token sets for `linguist-generated`, or `'none'` when it names another attribute. */
function verdictOf(token: string): Verdict | 'none' {
  if (token === ATTRIBUTE || token === `${ATTRIBUTE}=true`) return true;
  if (token === `-${ATTRIBUTE}` || token === `${ATTRIBUTE}=false`) return false;
  if (token === `!${ATTRIBUTE}`) return undefined;
  // Any other value is neither the set nor the unset state Linguist reads.
  if (token.startsWith(`${ATTRIBUTE}=`)) return false;
  return 'none';
}

/** The attribute name a token sets, unsets or unspecifies (`-name`, `!name`, `name=value`). */
function attributeName(token: string): string {
  const bare = token.startsWith('-') || token.startsWith('!') ? token.slice(1) : token;
  const equals = bare.indexOf('=');
  return equals === -1 ? bare : bare.slice(0, equals);
}

/**
 * Whether a repository-root `.gitattributes` marks a path `linguist-generated`.
 * Later lines win, as in git. Only the root file is read here; the caller
 * keeps any file with a `.gitattributes` in one of its directories in review.
 *
 * Syntax this reader does not implement must fail toward review in both
 * directions. A rule it cannot translate (a quoted or negated pattern) that
 * names the attribute without setting it, or a line that uses a macro defined
 * in the file, could unset what an earlier rule set, so it counts as "not
 * generated" for every path it might match (an untranslatable pattern: all
 * paths). An untranslatable rule that only sets the attribute is skipped.
 * A later translatable rule still decides as usual.
 */
export function generatedPathMatcher(attributesText: string): (path: string) => boolean {
  const lines = attributesText.split(/\r?\n/).map((rawLine) => rawLine.trim()).filter((line) => line.length > 0 && !line.startsWith('#'));
  const macros = new Set(
    lines.filter((line) => line.startsWith('[attr]')).map((line) => line.slice('[attr]'.length).split(/\s+/)[0]!)
  );
  const rules: Array<{ matches: RegExp; verdict: Verdict }> = [];
  for (const line of lines) {
    if (line.startsWith('[attr]')) continue;
    const [pattern, ...tokens] = line.split(/\s+/);
    let verdict: Verdict | 'none' = 'none';
    for (const token of tokens) {
      const next = verdictOf(token);
      if (next !== 'none') verdict = next;
    }
    // A macro may expand to either state; assume the one that keeps the file in review.
    if (tokens.some((token) => macros.has(attributeName(token)))) verdict = false;
    if (verdict === 'none') continue;
    const matches = patternToRegExp(pattern!);
    if (matches) rules.push({ matches, verdict });
    // A rule that is not understood can only set more paths (skipping it keeps them in review),
    // or unset: then it may undo any earlier rule.
    else if (verdict !== true) rules.push({ matches: /^/, verdict: false });
  }
  return (path) => {
    let verdict: Verdict = undefined;
    for (const rule of rules) if (rule.matches.test(path)) verdict = rule.verdict;
    return verdict === true;
  };
}

function isAttributesFile(path: string): boolean {
  return path === ATTRIBUTES_FILE || path.endsWith(`/${ATTRIBUTES_FILE}`);
}

/**
 * Only a file that already existed at its path can be left out: an added,
 * renamed or copied file arrives from outside the generated set, so a PR could
 * otherwise place hand-written code under a generated pattern and hide it.
 */
const LEFT_OUT_STATUSES: ReadonlySet<string> = new Set(['modified', 'deleted', 'removed']);

/** The files `leaveOutGenerated` would blank, before any directory-level exception. */
export function leaveOutCandidates(files: readonly FileChange[], isGenerated: (path: string) => boolean): FileChange[] {
  return files.filter((file) =>
    file.patch.length > 0 &&
    file.blobSha !== undefined &&
    LEFT_OUT_STATUSES.has(file.status) &&
    !isAttributesFile(file.filename) &&
    isGenerated(file.filename)
  );
}

/** Every directory above a path, outermost first (`a/b/c.txt` gives `a`, `a/b`). */
export function ancestorDirectories(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

/**
 * Blank the patch of every file the matcher calls generated, keeping the
 * file in the diff. A kept entry still carries its name, status, line counts
 * and git blob id, so the diff digest changes whenever the generated content
 * does: the reviewed patch shrinks, the evidence stays bound to the full head.
 * A file without a blob id has nothing to bind it to and stays reviewed.
 */
export function leaveOutGenerated(
  files: readonly FileChange[],
  isGenerated: (path: string) => boolean,
  ref: string
): { files: FileChange[]; leftOut?: LeftOutPaths } {
  const candidates = new Set(leaveOutCandidates(files, isGenerated));
  const paths: string[] = [];
  const kept = files.map((file) => {
    if (!candidates.has(file)) return file;
    paths.push(file.filename);
    return { ...file, patch: '' };
  });
  if (paths.length === 0) return { files: kept };
  paths.sort();
  return {
    files: kept,
    leftOut: { reason: 'linguist-generated', ref, count: paths.length, paths: paths.slice(0, MAX_LISTED_PATHS) },
  };
}
