import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Cited dismissals (RCL-201). Dismissals of gating findings often cited
 * nothing (73% of verified or consensus dismissals in the prod ledger), and a
 * cited one on allocator-one#14875 rested on code that did not say what the
 * reason claimed. A gating dismissal must therefore quote the code it relies
 * on: `path:line` or `path:start-end`, then a backtick-quoted excerpt. Each
 * quote must appear on the cited lines of the reviewed commit, whitespace
 * collapsed. This proves the quote is real, not that the argument is right.
 */

export interface DismissalCitation {
  path: string;
  startLine: number;
  endLine: number;
  quote: string;
}

/** Reads a repository-relative file at the reviewed commit; undefined when it does not exist there. */
export type RevisionReader = (path: string) => Promise<string | undefined>;

const CITATION = /([^\s`:]+):(\d+)(?:-(\d+))?\s*`([^`\n]+)`/g;
const MAX_CITED_LINES = 200;

export function parseDismissalCitations(reason: string): DismissalCitation[] {
  return [...reason.matchAll(CITATION)].map(([, path, start, end, quote]) => ({
    path: path!, startLine: Number(start), endLine: Number(end ?? start), quote: quote!,
  }));
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The first reason this dismissal reason fails the citation rule, or undefined when it passes. */
export async function checkDismissalCitations(reason: string, read: RevisionReader): Promise<string | undefined> {
  const citations = parseDismissalCitations(reason);
  if (citations.length === 0) {
    return 'cite at least one line the dismissal relies on, as path:line or path:start-end followed by the quoted code in backticks';
  }
  for (const { path, startLine, endLine, quote } of citations) {
    const location = startLine === endLine ? `${path}:${startLine}` : `${path}:${startLine}-${endLine}`;
    if (path.startsWith('/') || path.split('/').includes('..')) return `${path} must be a repository-relative path`;
    if (startLine < 1 || endLine < startLine || endLine - startLine >= MAX_CITED_LINES) {
      return `${location} must name between 1 and ${MAX_CITED_LINES} lines`;
    }
    const content = await read(path);
    if (content === undefined) return `${path} does not exist at the reviewed commit`;
    const lines = content.split(/\r?\n/);
    if (endLine > lines.length) return `${location} is past the end of ${path} at the reviewed commit`;
    if (!collapse(lines.slice(startLine - 1, endLine).join('\n')).includes(collapse(quote))) {
      return `${location} does not contain the quoted text at the reviewed commit; re-read the line and quote it exactly`;
    }
  }
  return undefined;
}

/** Reads files from `revision` in the repository at `cwd`, never from the working tree. */
export function gitRevisionReader(cwd: string, revision: string): RevisionReader {
  const git = promisify(execFile);
  let verified: Promise<void> | undefined;
  return async path => {
    verified ??= git('git', ['cat-file', '-e', `${revision}^{commit}`], { cwd }).then(() => undefined, () => {
      throw new Error(`The reviewed commit ${revision} is not in this repository; fetch it, then record the dismissal again.`);
    });
    await verified;
    try {
      const { stdout } = await git('git', ['show', `${revision}:${path}`], { cwd, maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    } catch {
      return undefined;
    }
  };
}

interface RoundAnnotations {
  lastAnnotations?: { round: number; identities: Array<{ identity: string; gating: string }> };
}

/**
 * Whether a dismissal of `identity` in `round` must cite its evidence: it
 * gated in that round. Without that round's annotations, assume it did.
 */
export function dismissalRequiresCitation(state: RoundAnnotations, round: number, identity: string): boolean {
  const annotations = state.lastAnnotations;
  if (annotations?.round !== round) return true;
  return annotations.identities.some(row => row.identity === identity && row.gating !== 'none');
}

/** The commit `round` reviewed, from its launch record when that record belongs to the round. */
export function reviewedRevision(launch: { round: number; headSha: string } | undefined, round: number): string {
  return launch?.round === round ? launch.headSha : 'HEAD';
}
