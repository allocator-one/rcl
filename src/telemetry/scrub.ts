/**
 * Free text that leaves the process — reviewer errors and warnings, runner
 * claims, finding prose, consensus excerpts — is truncated and scrubbed for
 * anything shaped like a credential before it is sent (epic IO-12475,
 * section 5.5 "Never sent"). Hex digests survive (a commit id is evidence);
 * opaque mixed-class tokens do not.
 */

export const MAX_FREE_TEXT = 2_000;
export const REDACTED = '[redacted]';

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
const SENSITIVE_KEY = String.raw`["']?[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|token|private[_-]?key)["']?`;
// A quoted value runs to its closing quote, escaped quotes included.
const ASSIGNMENT_QUOTED = new RegExp(String.raw`(${SENSITIVE_KEY}\s*[:=]\s*)(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')`, 'gi');
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
  let out = text;
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(ASSIGNMENT_QUOTED, redactQuoted);
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
 * Scrub, then cap at `max` characters (grapheme-safe, with an ellipsis).
 * The scrub passes run over at most about four times the cap: a huge input
 * is cut first — at the next whitespace, so no token is split and a secret
 * straddling the cut is still matched in full — before the exact cap applies.
 */
export function scrubText(text: string, max: number = MAX_FREE_TEXT): string {
  const bounded = preCut(text, max * 4);
  const scrubbed = scrubSecrets(bounded);
  if (scrubbed.length <= max && bounded === text) return scrubbed;
  return `${[...scrubbed].slice(0, Math.max(0, max - 1)).join('')}…`;
}

function preCut(text: string, at: number): string {
  if (text.length <= at) return text;
  // Cut at the last whitespace shortly before the mark, so a token that
  // straddles it is dropped whole rather than left as a half-secret; only a
  // whitespace-free stretch longer than the window is cut mid-token.
  const window = text.slice(Math.max(0, at - 512), at);
  const back = window.search(/\s\S*$/);
  return text.slice(0, back === -1 ? at : Math.max(0, at - 512) + back);
}

/**
 * Identifiers that come from configuration rather than prose — model ids,
 * roles, providers: key-shaped substrings go, but a long mixed-case id such as
 * `anthropic/Claude-Sonnet-4-5-20250929` is not an opaque token and stays.
 */
export function scrubIdentifier(text: string, max: number = 200): string {
  let out = text;
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(ASSIGNMENT_QUOTED, redactQuoted);
  out = out.replace(ASSIGNMENT, (_match, prefix: string) => `${prefix}${REDACTED}`);
  return out.length <= max ? out : `${[...out].slice(0, Math.max(0, max - 1)).join('')}…`;
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
  return /^ *$/.test(text.slice(index + length, lineEnd === -1 ? undefined : lineEnd));
}
