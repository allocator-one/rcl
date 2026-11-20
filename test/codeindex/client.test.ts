import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CodeIndexClient, CodeIndexError, parseEnvelope, resolveClientCredential } from '../../src/codeindex/client.js';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const VIEW = '7d3f0c1e-2b44-4f6a-9a51-0c2d8e5b7a10';
const credential = { url: 'https://harness.example.test', token: 'aone_secret' };

interface Call { url: string; init: RequestInit }
function scripted(...replies: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = replies[Math.min(calls.length, replies.length) - 1]!;
    return next();
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const ok = (name: string) => () => new Response(fixture(name), { status: 200 });
const client = (fetchImpl: typeof fetch) =>
  new CodeIndexClient({ credential, fetchImpl, sleep: async () => {} });

describe('CodeIndexClient', () => {
  it('reads the outline, repeating path, and sends the token only to the credential host', async () => {
    const { calls, fetchImpl } = scripted(ok('outline.json'));
    const response = await client(fetchImpl).outline(VIEW, ['src/config/harness.ts', 'README.md']);
    expect(calls[0]!.url).toBe(`${credential.url}/api/v1/code/views/${VIEW}/outline?path=src%2Fconfig%2Fharness.ts&path=README.md`);
    expect(new URL(calls[0]!.url).origin).toBe(credential.url);
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer aone_secret');
    expect(calls[0]!.init.redirect).toBe('error');
    expect(response.contract).toBe('1.4');
    expect(response.data.missing).toEqual(['src/gone.ts']);
    expect(response.data.files[0]!.symbols[0]!.qualified_name).toBe('sameHost');
    expect(response.view.active?.version).toBe(7);
  });

  it('never treats a capped list as complete', async () => {
    const { fetchImpl } = scripted(ok('outline.json'));
    const response = await client(fetchImpl).outline(VIEW, ['a']);
    expect(response.truncation.truncated).toBe(true);
    expect(response.complete).toBe(false);
  });

  it('calls an answer complete only when the server said it was not cut', async () => {
    const { fetchImpl } = scripted(ok('search-empty.json'));
    expect((await client(fetchImpl).search(VIEW, { limit: 1 })).complete).toBe(true);
  });

  it('reads a missing truncation block as truncated', () => {
    const body = JSON.parse(fixture('search-empty.json'));
    delete body.meta.truncation;
    const parsed = parseEnvelope(body);
    expect(parsed.complete).toBe(false);
    expect(parsed.truncation.truncated).toBe(true);
  });

  it('reads not_tracked from an explain answer', async () => {
    const { calls, fetchImpl } = scripted(ok('explain.json'));
    const response = await client(fetchImpl).explain(VIEW, 'sym/01', { budgetTokens: 500 });
    expect(calls[0]!.url).toContain('/symbols/sym%2F01?budget_tokens=500');
    expect(response.notTracked).toEqual(['dynamic_dispatch']);
    expect(response.complete).toBe(false);
  });

  it('posts affected seeds as JSON', async () => {
    const { calls, fetchImpl } = scripted(ok('explain.json'));
    await client(fetchImpl).affected(VIEW, { symbolIds: ['s1'], paths: ['a.ts'], depth: 2 });
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ symbol_ids: ['s1'], paths: ['a.ts'], depth: 2 });
  });

  it('refuses more than 50 outline paths before any request', () => {
    const { calls, fetchImpl } = scripted(ok('outline.json'));
    expect(() => client(fetchImpl).outline(VIEW, Array.from({ length: 51 }, (_, i) => `f${i}`))).toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('retries once after a 503, then succeeds', async () => {
    const { calls, fetchImpl } = scripted(() => new Response('{}', { status: 503 }), ok('search-empty.json'));
    await client(fetchImpl).search(VIEW);
    expect(calls).toHaveLength(2);
  });

  it('gives up after one retry and names the status', async () => {
    const { calls, fetchImpl } = scripted(() => new Response('{}', { status: 502 }));
    await expect(client(fetchImpl).search(VIEW)).rejects.toMatchObject({ reason: 'http_502' });
    expect(calls).toHaveLength(2);
  });

  it('retries a timeout once and reports it', async () => {
    const timeout = () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
    const { calls, fetchImpl } = scripted(timeout);
    await expect(client(fetchImpl).search(VIEW)).rejects.toMatchObject({ reason: 'timeout' });
    expect(calls).toHaveLength(2);
  });

  it('reports a network error', async () => {
    const { fetchImpl } = scripted(() => { throw new TypeError('fetch failed'); });
    await expect(client(fetchImpl).search(VIEW)).rejects.toMatchObject({ reason: 'network_error' });
  });

  it.each([
    [403, { error: { code: 'code_index_disabled' } }, 'code_index_disabled'],
    [403, { error: { code: 'insufficient_scope' } }, 'forbidden'],
    [401, {}, 'unauthorized'],
    [404, {}, 'view_not_found'],
    [400, {}, 'not_indexed'],
  ])('maps %s to a reason without retrying', async (status, body, reason) => {
    const { calls, fetchImpl } = scripted(() => new Response(JSON.stringify(body), { status }));
    await expect(client(fetchImpl).search(VIEW)).rejects.toMatchObject({ reason });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['not json', () => new Response('<html>', { status: 200 })],
    ['no view', () => new Response(JSON.stringify({ data: [], meta: { contract: '1.3' } }), { status: 200 })],
    ['old contract', () => new Response(fixture('search-empty.json').replace('"1.3"', '"1.2"'), { status: 200 })],
  ])('rejects a response that is %s', async (_name, reply) => {
    const { fetchImpl } = scripted(reply);
    await expect(client(fetchImpl).search(VIEW)).rejects.toMatchObject({ reason: 'unrecognized_response' });
  });
});

describe('resolveClientCredential', () => {
  it('prefers the run-bound credential', async () => {
    expect(await resolveClientCredential({ cwd: '/', env: {}, credential })).toBe(credential);
  });

  it('reports no_login without any stored login', async () => {
    const error = await resolveClientCredential({ cwd: '/', env: {}, credentialsPath: '/nonexistent/credentials.json' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodeIndexError);
    expect((error as CodeIndexError).reason).toBe('no_login');
  });
});
