import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readTextFixture } from './text-fixture.js';

describe('lossless textual fixture', () => {
  it('reconstructs the exact original lineage bytes before parsing embedded evidence', () => {
    const bytes = readTextFixture(new URL('../fixtures/reviewer-artifact-lineage.json', import.meta.url));
    expect(Buffer.byteLength(bytes)).toBe(152867);
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('68bd36a120c49be85a9030785c1a9dd421442135e7fbb0b9112b470d55636828');
    expect(JSON.parse(bytes).rows).toHaveLength(3);
  });
});
