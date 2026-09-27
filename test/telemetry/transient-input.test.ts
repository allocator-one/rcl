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
});
