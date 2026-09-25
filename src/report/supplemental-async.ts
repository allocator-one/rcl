import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ModelReview } from '../consensus/types.js';
import { blockingCheckpointReviewSchema } from '../dispatch/checkpoint.js';
import { stableStringify } from './run-header.js';

const MAX_BYTES = 8 * 1024 * 1024;
const integer = z.number().int().nonnegative().safe();
const wireSchema = z.object({ version: z.literal(1), asyncLaunched: integer, reviewBytes: z.array(z.string()) }).strict();
const asyncReviewSchema = blockingCheckpointReviewSchema.extend({ async: z.literal(true) }).strict();
const validated = new WeakSet<object>();

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type SupplementalAsync = DeepReadonly<{
  version: 1;
  bytes: string;
  digest: string;
  asyncLaunched: number;
  reviews: ModelReview[];
  reviewBytes: string[];
}>;

function sha256(bytes: string): string { return createHash('sha256').update(bytes).digest('hex'); }
function bound(bytes: string): void {
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes, 'utf8') > MAX_BYTES) throw new Error('supplemental_async_too_large');
  if (Buffer.from(bytes, 'utf8').toString('utf8') !== bytes) throw new Error('supplemental_async_invalid_bytes');
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function snapshot(wire: z.infer<typeof wireSchema>, bytes: string): SupplementalAsync {
  const reviews: ModelReview[] = wire.reviewBytes.map((reviewBytes) => {
    bound(reviewBytes);
    let value: unknown;
    try { value = JSON.parse(reviewBytes); } catch { throw new Error('supplemental_async_invalid_review'); }
    const parsed = asyncReviewSchema.safeParse(value);
    if (!parsed.success) throw new Error('supplemental_async_invalid_review');
    return parsed.data as ModelReview;
  });
  const document: SupplementalAsync = deepFreeze({
    version: 1 as const,
    bytes,
    digest: sha256(bytes),
    asyncLaunched: wire.asyncLaunched,
    reviews,
    reviewBytes: [...wire.reviewBytes],
  });
  validated.add(document);
  return document;
}

/** Structural snapshot only; it does not establish worker, provider, or server authority. */
export function isSupplementalAsync(value: unknown): value is SupplementalAsync {
  return typeof value === 'object' && value !== null && validated.has(value);
}

/** Decode a canonical immutable async snapshot captured during original aggregation. */
export function decodeSupplementalAsync(bytes: string): SupplementalAsync {
  bound(bytes);
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new Error('supplemental_async_invalid_document'); }
  const parsed = wireSchema.safeParse(value);
  if (!parsed.success) throw new Error('supplemental_async_invalid_document');
  if (stableStringify(parsed.data) !== bytes) throw new Error('supplemental_async_noncanonical');
  return snapshot(parsed.data, bytes);
}

/** Capture exact opaque async review strings in their aggregation order. */
export function captureSupplementalAsync(reviewBytes: readonly string[], asyncLaunched: number): SupplementalAsync {
  const wire = { version: 1 as const, asyncLaunched, reviewBytes: [...reviewBytes] };
  const parsed = wireSchema.safeParse(wire);
  if (!parsed.success) {
    if (!Number.isSafeInteger(asyncLaunched) || asyncLaunched < 0) throw new Error('supplemental_async_invalid_async_launched');
    throw new Error('supplemental_async_invalid_document');
  }
  const bytes = stableStringify(parsed.data);
  bound(bytes);
  return snapshot(parsed.data, bytes);
}
