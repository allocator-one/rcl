/** A transient pipe is bounded by bytes and elapsed time; no raw input reaches diagnostics. */
export async function readTransientInput(stream: AsyncIterable<Uint8Array | string>, maxBytes: number, timeoutMs = 5000): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
    throw new Error('transient_input_invalid_bound');
  }
  const iterator = stream[Symbol.asyncIterator]();
  const chunks: Buffer[] = []; let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const monotonicStart = performance.now();
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('transient_input_timeout')), timeoutMs); });
  try {
    while (true) {
      if (performance.now() - monotonicStart >= timeoutMs) throw new Error('transient_input_timeout');
      const part = await Promise.race([iterator.next(), timeout]);
      if (part.done) break;
      const incoming = typeof part.value === 'string' ? Buffer.byteLength(part.value) : part.value.byteLength;
      if (incoming > maxBytes - size) throw new Error('transient_input_too_large');
      if (incoming === 0) continue;
      const bytes = Buffer.from(part.value); size += incoming;
      chunks.push(bytes);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch { throw new Error('transient_input_unavailable'); }
  finally { clearTimeout(timer); void iterator.return?.().catch(() => {}); }
}
