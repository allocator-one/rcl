import { createHash } from 'node:crypto';
import { decodeOriginalReport, type DecodeOriginalReportOptions } from '../../original-run/decode.js';

type Decoded = ReturnType<typeof decodeOriginalReport>;
const entries = new Map<string, { value: Decoded; bytes: number }>();
const MAX_ENTRIES = 16;
const MAX_BYTES = 32 * 1024 * 1024;
let retainedBytes = 0;

/** Bounded pure interpretation cache for repeated immutable recovery proofs.
 * Keys include all source code units and the interpretation version/options.
 * This does not cache physical reads, digests, scope or authenticated authority.
 * Each caller receives a clone; unsuccessful decodes are never retained. */
export function decodeRecoveryOriginal(text: string, options: DecodeOriginalReportOptions = {}): Decoded {
  if (options.originalProse !== undefined && options.originalProse !== 'control-code-units-v1') {
    throw new Error('unsupported_original_prose_mode');
  }
  if (options.exactNumbers !== undefined && typeof options.exactNumbers !== 'boolean') {
    throw new Error('invalid_original_number_mode');
  }
  // Small receipts do not evict the bounded original-report working set.
  if (text.length < 1024 || text.length * 2 > MAX_BYTES) return decodeOriginalReport(text, options);
  const digest = createHash('sha256').update(text, 'utf16le').digest('hex');
  const key = `1:${options.originalProse ?? 'default'}:${options.exactNumbers === true}:${digest}`;
  const cached = entries.get(key);
  if (cached) {
    entries.delete(key);
    entries.set(key, cached);
    return structuredClone(cached.value);
  }
  const value = decodeOriginalReport(text, options);
  const bytes = text.length * 2 + JSON.stringify(value).length * 2;
  if (bytes <= MAX_BYTES) {
    while (entries.size >= MAX_ENTRIES || retainedBytes + bytes > MAX_BYTES) {
      const oldest = entries.keys().next().value!;
      retainedBytes -= entries.get(oldest)!.bytes;
      entries.delete(oldest);
    }
    entries.set(key, { value: structuredClone(value), bytes });
    retainedBytes += bytes;
  }
  return value;
}
