import { z } from 'zod';

export const uuidSchema = z.string().uuid().refine(value => value === value.toLowerCase(), 'UUID must already use canonical lowercase form');
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** Backend timestamps retain microseconds, unlike Date's millisecond comparison. */
export function instant(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid_receipt_timestamp');
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) throw new Error('invalid_receipt_timestamp');
  // Date.parse normalizes impossible dates such as February 30. Such input
  // must not compare equal to a different, valid persisted timestamp.
  const calendar = new Date(match[1]! + 'Z');
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 19) !== match[1]) throw new Error('invalid_receipt_timestamp');
  const seconds = Date.parse(match[1]! + match[3]!);
  if (!Number.isFinite(seconds)) throw new Error('invalid_receipt_timestamp');
  return (BigInt(seconds) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'))).toString();
}
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|[a-z0-9.-]+\.localhost)$/i;

/**
 * The token travels only over TLS, except to loopback hosts (a local
 * development server). A base URL carries no user-info, query or fragment;
 * the result is the canonical origin plus path, without a trailing slash.
 */
export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
    const plain = url.protocol === 'http:' && LOOPBACK.test(url.hostname);
    if (url.protocol !== 'https:' && !plain) return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}
