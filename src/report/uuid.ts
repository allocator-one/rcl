import { randomBytes } from 'node:crypto';

/**
 * RFC 9562 UUID version 7: 48-bit Unix millisecond timestamp, then version
 * and variant bits over random data. Time-ordered so run ids sort by
 * creation on the server, random enough to be a safe idempotency key for
 * retried deliveries. Node's `randomUUID()` is v4 and carries no time.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  // The timestamp field is an unsigned 48-bit integer: clamp a pre-epoch or
  // fractional clock reading rather than letting BigInt two's-complement
  // bits scramble the sort order (or throw on a non-integer).
  const millis = Number.isFinite(now) ? Math.max(0, Math.floor(now)) : 0;
  const ts = BigInt(millis) & 0xffffffffffffn;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
