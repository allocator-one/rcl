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
  // Any long opaque token mixing upper, lower and digits (never a pure hex
  // digest, which has no upper-case letters).
  /\b(?=[A-Za-z0-9+/=_-]{32,}\b)(?=[A-Za-z0-9+/=_-]*[A-Z])(?=[A-Za-z0-9+/=_-]*[a-z])(?=[A-Za-z0-9+/=_-]*[0-9])[A-Za-z0-9+/=_-]{32,}\b/g,
];

/** Replace every credential-shaped substring with `[redacted]`. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** Scrub, then cap at `max` characters (grapheme-safe, with an ellipsis). */
export function scrubText(text: string, max: number = MAX_FREE_TEXT): string {
  const scrubbed = scrubSecrets(text);
  if (scrubbed.length <= max) return scrubbed;
  return `${[...scrubbed].slice(0, Math.max(0, max - 1)).join('')}…`;
}

export function scrubOptional(text: string | undefined, max: number = MAX_FREE_TEXT): string | undefined {
  return text === undefined ? undefined : scrubText(text, max);
}

/** Scrub every string nested inside a JSON-like value (structure untouched). */
export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubDeep(item);
    }
    return out as T;
  }
  return value;
}

/** Drop fenced code blocks — a malformed model answer can echo the prompt, and the prompt contains the diff. */
export function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, '[code omitted]');
}
