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
const SENSITIVE_KEY = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|token)`;
const ASSIGNMENT_QUOTED = new RegExp(String.raw`\b(${SENSITIVE_KEY}\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*')`, 'gi');
const ASSIGNMENT = new RegExp(String.raw`\b(${SENSITIVE_KEY}\s*[:=]\s*)([^\s"',;]{8,})`, 'gi');

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
 * The scrub passes run over at most four times the cap: a huge input is cut
 * first, generously enough that a secret straddling the final cut is still
 * matched in full before the exact cap is applied.
 */
export function scrubText(text: string, max: number = MAX_FREE_TEXT): string {
  const bounded = text.length > max * 4 ? text.slice(0, max * 4) : text;
  const scrubbed = scrubSecrets(bounded);
  if (scrubbed.length <= max && bounded === text) return scrubbed;
  return `${[...scrubbed].slice(0, Math.max(0, max - 1)).join('')}…`;
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

/** Scrub every string nested inside a JSON-like value — keys included (structure untouched). */
export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[scrubSecrets(key)] = scrubDeep(item);
    }
    return out as T;
  }
  return value;
}

/**
 * Drop fenced code blocks — a malformed model answer can echo the prompt,
 * and the prompt contains the diff. Fences follow CommonMark: a run of three
 * or more backticks or tildes opens a block, and it closes at the next run
 * of the same character at least as long; an unclosed block runs to the end.
 * Fences may sit mid-line (a model rarely starts a new line for them).
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
    } else if (run[0] === open.char && run.length >= open.length) {
      open = undefined;
      cursor = match.index + run.length;
    }
  }
  return open ? out : out + text.slice(cursor);
}
