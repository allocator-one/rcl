import { describe, expect, it } from 'vitest';
import { isRetryableConnectionError } from '../../src/dispatch/utils.js';
const coded = (code: string) => Object.assign(new Error('Transport error'), { code });
describe('bounded transport cause classification', () => {
  it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'])(
    'recognizes %s through an SDK/fetch cause chain', code => {
      expect(isRetryableConnectionError(new Error('SDK wrapper', { cause: new TypeError('fetch failed', { cause: coded(code) }) }))).toBe(true);
    });
  it.each(['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ENOTFOUND', 'ERR_INVALID_URL', 'ENOENT', 'UNKNOWN'])(
    'keeps %s terminal even inside a recognized outer connection error', code => {
      expect(isRetryableConnectionError(new Error('SDK connection error', { cause: coded(code) }), true)).toBe(false);
    });
  it('does not guess from error messages or a programming-error cause', () => {
    expect(isRetryableConnectionError(new TypeError('fetch failed'))).toBe(false);
    expect(isRetryableConnectionError(new Error('SDK connection error', { cause: new TypeError('invalid configuration') }), true)).toBe(false);
    expect(isRetryableConnectionError(new Error('recognized SDK connection error'), true)).toBe(true);
  });
  it('refuses canceled, cyclic or over-depth causes', () => {
    expect(isRetryableConnectionError(new DOMException('aborted', 'AbortError'), true)).toBe(false);
    const cycle = coded('ECONNRESET'); Object.assign(cycle, { cause: cycle });
    expect(isRetryableConnectionError(cycle, true)).toBe(false);
    let deep: Error = coded('ECONNRESET');
    for (let i = 0; i < 10; i++) deep = new Error('wrapper', { cause: deep });
    expect(isRetryableConnectionError(deep, true)).toBe(false);
  });
  it('lets a permanent inner cause veto a transient outer code', () => {
    expect(isRetryableConnectionError(Object.assign(coded('ECONNRESET'), { cause: coded('CERT_HAS_EXPIRED') }), true)).toBe(false);
  });

  it('recognizes transient errors in a bounded AggregateError', () => {
    const aggregate = new AggregateError([coded('ETIMEDOUT'), coded('UND_ERR_SOCKET')], 'connection failures');
    expect(isRetryableConnectionError(new Error('SDK wrapper', { cause: aggregate }), true)).toBe(true);
  });

  it('lets a permanent AggregateError member veto transient errors', () => {
    const aggregate = new AggregateError([coded('ETIMEDOUT'), coded('CERT_HAS_EXPIRED')], 'connection failures');
    expect(isRetryableConnectionError(new Error('SDK wrapper', { cause: aggregate }), true)).toBe(false);
  });

  it.each([
    [new Error('invalid configuration'), coded('ECONNRESET')],
    [coded('ECONNRESET'), new Error('invalid configuration')],
  ])('keeps uncoded AggregateError members terminal regardless of order', (...errors: Error[]) => {
    const aggregate = new AggregateError(errors, 'connection failures');
    expect(isRetryableConnectionError(new Error('SDK wrapper', { cause: aggregate }), true)).toBe(false);
  });
});
