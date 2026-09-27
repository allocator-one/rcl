import { describe, expect, it, vi } from 'vitest';
import { readTransientInput } from '../../src/telemetry/transient-input.js';

describe('transient input bounds', () => {
  it('rejects an oversized chunk before copying it', async () => {
    const bytes = new Uint8Array(32);
    const stream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let yielded = false;
        return {
          async next() {
            if (yielded) return { done: true, value: undefined };
            yielded = true;
            return { done: false, value: bytes };
          },
          async return() { return { done: true, value: undefined }; },
        };
      },
    };
    const from = vi.spyOn(Buffer, 'from');

    await expect(readTransientInput(stream, 1)).rejects.toThrow('transient_input_unavailable');

    expect(from).not.toHaveBeenCalled();
    from.mockRestore();
  });

  it('enforces the monotonic deadline while an iterator eagerly yields empty chunks', async () => {
    let calls = 0;
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const stream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            calls++;
            if (calls > 100) throw new Error('iterator safety bound exceeded');
            return { done: false as const, value: new Uint8Array() };
          },
          return: returned,
        };
      },
    };
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now++);

    await expect(readTransientInput(stream, 1, 10)).rejects.toThrow('transient_input_unavailable');

    expect(calls).toBeLessThan(20);
    expect(returned).toHaveBeenCalledOnce();
    clock.mockRestore();
  });

  it('does not retain empty chunks while assembling bounded input', async () => {
    const values = [...Array.from({ length: 32 }, () => new Uint8Array()), Buffer.from('ok')];
    const stream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const value = values.shift();
            return value ? { done: false as const, value } : { done: true as const, value: undefined };
          },
        };
      },
    };
    const concat = vi.spyOn(Buffer, 'concat');

    await expect(readTransientInput(stream, 2)).resolves.toBe('ok');

    expect(concat).toHaveBeenCalledOnce();
    expect(concat.mock.calls[0]?.[0]).toHaveLength(1);
    concat.mockRestore();
  });
});
