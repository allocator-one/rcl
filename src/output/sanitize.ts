/**
 * Model-generated finding text is derived from an untrusted diff. Before it
 * is posted to GitHub (or written to a shareable markdown report) it must be
 * neutralized so a successful prompt injection can't turn the review comment
 * into @-mention spam, issue-linking spam, or HTML injection under the
 * token's identity.
 */

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;
const MAX_FIX = 4000;

/** Neutralize @mentions and #refs so they render literally, not as pings. */
function neutralizeMentions(text: string): string {
  return text
    .replace(/@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9._-]+)?)/g, '`@$1`')
    .replace(/(^|[\s(])#(\d+)\b/g, '$1`#$2`');
}

/** Strip HTML tags and comments; models should emit markdown, not HTML. */
function stripHtml(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, '');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…[truncated]';
}

/** Sanitize a short single-line field (title). */
export function sanitizeInline(text: string, max = MAX_TITLE): string {
  return truncate(neutralizeMentions(stripHtml(text)).replace(/\s+/g, ' ').trim(), max);
}

/** Sanitize a multi-line prose field (description). */
export function sanitizeBlock(text: string, max = MAX_DESCRIPTION): string {
  return truncate(neutralizeMentions(stripHtml(text)), max);
}

/**
 * Wrap arbitrary content in a fenced code block whose fence is longer than
 * any backtick run inside it, so a suggestedFix containing ``` can't break
 * out of the fence (CommonMark: a fence is closed only by a run of at least
 * as many backticks).
 */
export function fencedCodeBlock(content: string, lang = ''): string {
  const clipped = truncate(content, MAX_FIX);
  const longestRun = (clipped.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${lang}\n${clipped}\n${fence}`;
}
