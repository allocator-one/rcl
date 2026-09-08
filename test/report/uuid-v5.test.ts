import { describe, expect, it } from 'vitest';
import { uuidv5, UUID_NAMESPACE_RCL_BACKFILL } from '../../src/report/uuid.js';

describe('uuidv5', () => {
  it('is deterministic, RFC 4122 shaped, and sensitive to the name and the namespace', () => {
    const a = uuidv5('allocator-one/rcl|abc', UUID_NAMESPACE_RCL_BACKFILL);
    expect(a).toBe(uuidv5('allocator-one/rcl|abc', UUID_NAMESPACE_RCL_BACKFILL));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidv5('allocator-one/rcl|abd', UUID_NAMESPACE_RCL_BACKFILL)).not.toBe(a);
    expect(uuidv5('allocator-one/rcl|abc', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).not.toBe(a);
  });

  it('matches the RFC 4122 appendix vector for the DNS namespace', () => {
    // RFC 4122 §4.3 example (python: uuid.uuid5(uuid.NAMESPACE_DNS, 'www.example.com')).
    expect(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });
});
