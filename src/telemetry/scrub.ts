/**
 * Free text that leaves the process — reviewer errors and warnings, runner
 * claims, finding prose, consensus excerpts — is truncated and scrubbed for
 * anything shaped like a credential before it is sent (epic IO-12475,
 * section 5.5 "Never sent"). Hex digests survive (a commit id is evidence);
 * opaque mixed-class tokens do not.
 */

export const MAX_FREE_TEXT = 2_000;
export const REDACTED = '[redacted]';

/** Normalize newly produced human text before report hashing, never retained originals. */
export function normalizeGeneratedText(value: string): string {
  return value.replace(/[\uD800-\uDFFF]/gu, '\uFFFD')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

const DISPLAY_MARKS = /[\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const DISPLAY_LINE_SEPARATORS = /\r\n|[\r\u0085\u2028\u2029]/g;

/**
 * Normalize only strings rendered for people. Stored and wire values remain
 * untouched; ZWJ/ZWNJ are intentionally retained for language and emoji text.
 */
export function sanitizePresentation(value: string, { multiline }: { multiline: boolean }): string {
  const lineReplacement = multiline ? '\n' : ' ';
  return value.replace(DISPLAY_LINE_SEPARATORS, lineReplacement)
    .replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(DISPLAY_MARKS, '');
}

/** Normalize newly produced human text before report hashing, never retained originals. */
export function normalizeGeneratedText(value: string): string {
  return value.replace(/[\uD800-\uDFFF]/gu, '\uFFFD')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** Escape display controls in JSON source without changing parsed semantic values. */
export function escapeDisplayControls(value: string): string {
  return value.replace(/[\u0085\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const KEY_PATTERNS: RegExp[] = [
  // Authorization header values.
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // JSON Web Tokens: three base64url segments.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // AWS access key ids, long-lived (AKIA) and temporary STS (ASIA).
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // OpenAI, Anthropic (sk-ant-), OpenRouter (sk-or-), project keys (sk-proj-).
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens, classic and fine-grained.
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  // Harness API tokens and CLI logins.
  /\b(?:aone|hcli)_[A-Za-z0-9]{16,}/g,
  // Slack.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // Stripe secret and restricted keys.
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // GitLab personal access tokens, npm access tokens, Hugging Face tokens.
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
];

/**
 * `api_key=…`, `token: "…"` and the like: the value goes, the name stays. A
 * quoted value is consumed through its closing quote whatever it contains
 * (spaces, commas, a short passphrase); an unquoted one is a run of eight or
 * more non-delimiter characters — shorter unquoted runs are left alone so
 * that prose such as `token: string` keeps its type name.
 */
// The key may be a compound (`client_secret`, `GITHUB_TOKEN`, `private_key`)
// and may itself be quoted, as in JSON.
const SENSITIVE_KEY = String.raw`(?<![A-Za-z0-9_-])["']?[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|token|private[_-]?key)["']?`;
// Non-overlapping alternatives consume escaped characters once, including a
// terminal escape. Match through the closing quote or end of input, even when
// pre-cut removed the closing quote or the supplied value spans real newlines.
const ASSIGNMENT_QUOTED = new RegExp(String.raw`(${SENSITIVE_KEY}\s*[:=]\s*)(["'])(?:(?!\2)[^\\]|\\(?:[\s\S]|(?![\s\S])))*(?:\2|(?![\s\S]))`, 'gi');
const ASSIGNMENT = new RegExp(String.raw`(${SENSITIVE_KEY}\s*[:=]\s*)([^\s"',;]{8,})`, 'gi');

/**
 * Any long opaque token mixing upper, lower and digits — never a pure hex
 * digest (no upper-case letters) or a plain word. Matched with a simple
 * bounded pattern and judged procedurally, so no backtracking blow-up.
 */
const OPAQUE_TOKEN = /\b[A-Za-z0-9+/=_-]{32,}\b/g;

function opaqueToken(candidate: string): boolean {
  return /[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && /[0-9]/.test(candidate);
}

/** Replace every credential-shaped substring with `[redacted]`. */
export function scrubSecrets(text: string): string {
  let out = text.replace(ASSIGNMENT_QUOTED, redactQuoted);
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(ASSIGNMENT, (_match, prefix: string) => `${prefix}${REDACTED}`);
  out = out.replace(OPAQUE_TOKEN, (candidate) => (opaqueToken(candidate) ? REDACTED : candidate));
  return out;
}

/** `key="value"` → `key="[redacted]"`: the quotes stay so the text still reads as an assignment. */
function redactQuoted(match: string, prefix: string): string {
  const quote = match.charAt(prefix.length);
  return `${prefix}${quote}${REDACTED}${quote}`;
}

/**
 * Scrub, then cap at `max` Unicode code points with an ellipsis. Preliminary
 * truncation keeps only through a real whitespace boundary inside the bounded
 * UTF-16 prefix, so no split credential fragment can survive later redaction.
 */
export function scrubText(text: string, max: number = MAX_FREE_TEXT): string {
  const bounded = preCut(text, max * 4);
  return truncateCodepoints(scrubSecrets(bounded), max, bounded !== text);
}

function truncateCodepoints(text: string, max: number, cut = false): string {
  const points: string[] = [];
  let units = 0;
  for (const point of text) {
    if (points.length >= max) break;
    points.push(point);
    units += point.length;
  }
  if (!cut && units === text.length) return text;
  return `${points.slice(0, Math.max(0, max - 1)).join('')}…`;
}

function preCut(text: string, at: number): string {
  if (text.length <= at) return text;
  // A half-surrogate at the boundary cannot be a whitespace boundary.
  const prefix = text.slice(0, at);
  const back = prefix.search(/\s\S*$/);
  return back === -1 ? '' : prefix.slice(0, back);
}

/**
 * Identifiers that come from configuration rather than prose — model ids,
 * roles, providers: key-shaped substrings go, but a long mixed-case id such as
 * `anthropic/Claude-Sonnet-4-5-20250929` is not an opaque token and stays.
 */
export function scrubIdentifier(text: string, max: number = 200): string {
  let out = text.replace(ASSIGNMENT_QUOTED, redactQuoted);
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(ASSIGNMENT, (_match, prefix: string) => `${prefix}${REDACTED}`);
  return truncateCodepoints(out, max);
}

export function scrubOptional(text: string | undefined, max: number = MAX_FREE_TEXT): string | undefined {
  return text === undefined ? undefined : scrubText(text, max);
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Scrub every string nested inside a JSON-like value — keys included. The
 * structure survives: two keys that scrub to the same name stay distinct
 * (`[redacted]`, `[redacted]#2`, …), and the keys that would reach into the
 * object's prototype are dropped rather than assigned.
 */
export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (UNSAFE_KEYS.has(key)) continue;
      const base = scrubSecrets(key);
      let name = base;
      for (let n = 2; Object.prototype.hasOwnProperty.call(out, name); n += 1) name = `${base}#${n}`;
      out[name] = scrubDeep(item);
    }
    return out as T;
  }
  return value;
}

/**
 * Drop fenced code blocks — a malformed model answer can echo the prompt,
 * and the prompt contains the diff. A run of three or more backticks or
 * tildes opens a block wherever it stands (models often open one mid-line,
 * "here is the JSON: ```json"). It closes, as in CommonMark, only at a line
 * start: up to three spaces, a run of the same character at least as long,
 * then nothing but spaces to the end of the line. A same-length run inside
 * the block's own lines therefore never ends it early, and an unclosed
 * block runs to the end of the text.
 */
export function stripFencedCode(text: string): string {
  const fence = /(`{3,}|~{3,})/g;
  let out = '';
  let cursor = 0;
  let open: { char: string; length: number } | undefined;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    const run = match[1]!;
    if (!open) {
      out += `${text.slice(cursor, match.index)}[code omitted]`;
      open = { char: run[0]!, length: run.length };
      cursor = match.index + run.length;
    } else if (run[0] === open.char && run.length >= open.length && closesAtLineStart(text, match.index, run.length)) {
      open = undefined;
      // The closing line is the fence's own; resume at its line break.
      const lineEnd = text.indexOf('\n', match.index + run.length);
      cursor = lineEnd === -1 ? text.length : lineEnd;
    }
  }
  return open ? out : out + text.slice(cursor);
}

function closesAtLineStart(text: string, index: number, length: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  if (!/^ {0,3}$/.test(text.slice(lineStart, index))) return false;
  const lineEnd = text.indexOf('\n', index + length);
  return /^ *\r?$/.test(text.slice(index + length, lineEnd === -1 ? undefined : lineEnd));
}
