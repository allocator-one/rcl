import { readFileSync } from 'node:fs';
import http2 from 'node:http2';
import type { AddressInfo, Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/dispatch/anthropic.js';
import { installHttp1Transport } from '../../src/dispatch/http1-transport.js';
import { OpenAIAdapter } from '../../src/dispatch/openai.js';
import { OpenAICompatAdapter } from '../../src/dispatch/openai-compat.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
const key = fixture('http2-test-key.pem');
const cert = fixture('http2-test-cert.pem');
const CALLS = 6;
const REVIEW = { timeoutMs: 10_000, maxRetries: 0 };

/** A TLS server that offers HTTP/2, like the provider hosts, and records each connection's protocol. */
let server: http2.Http2SecureServer;
let baseUrl: string;
let protocols: Array<string | false> = [];
const sockets = new Set<Socket>();
const originalDispatcher = getGlobalDispatcher();

beforeAll(async () => {
  server = http2.createSecureServer({ key, cert, allowHTTP1: true });
  server.on('secureConnection', (socket) => {
    protocols.push(socket.alpnProtocol);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('request', (_req, res) => {
    // Hold every request open so all concurrent calls are in flight together.
    setTimeout(() => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rejected', type: 'invalid_request_error' } }));
    }, 150);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `https://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setGlobalDispatcher(originalDispatcher);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  protocols = [];
  vi.unstubAllEnvs();
  setGlobalDispatcher(originalDispatcher);
});

const connect = { ca: cert };

/** Node 26's default: undici 8 negotiates HTTP/2 unless told not to. */
function useHttp2Default(): void {
  protocols = [];
  setGlobalDispatcher(new Agent({ allowH2: true, connect }));
}

async function concurrently<T>(call: () => Promise<T>): Promise<void> {
  protocols = [];
  await Promise.allSettled(Array.from({ length: CALLS }, call));
}

const calls: Array<[string, () => Promise<unknown>]> = [
  ['OpenAI', () => new OpenAIAdapter('test-key', baseUrl).review('gpt-5', 'general', 'system', 'user', REVIEW)],
  ['OpenAI-compatible', () => new OpenAICompatAdapter({ apiKey: 'test-key', baseUrl }).review('model', 'general', 'system', 'user', REVIEW)],
  [
    'Anthropic',
    () => {
      vi.stubEnv('ANTHROPIC_BASE_URL', baseUrl);
      return new AnthropicAdapter('test-key').review('claude-opus-5-5', 'general', 'system', 'user', REVIEW);
    },
  ],
  [
    'Gemini',
    () =>
      new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl } }).models.generateContent({
        model: 'gemini-3-pro',
        contents: 'user',
      }),
  ],
];

describe('provider transport under concurrency (RCL-213)', () => {
  it.each(calls)('%s calls over Node 26 defaults share HTTP/2 connections the council can lose together', async (_name, call) => {
    useHttp2Default();
    await concurrently(call);
    expect(protocols.length).toBeGreaterThan(0);
    expect(new Set(protocols)).toEqual(new Set(['h2']));
  });

  it.each(calls)('%s calls each get their own HTTP/1.1 connection once the transport is installed', async (_name, call) => {
    useHttp2Default();
    installHttp1Transport({ connect });
    await concurrently(call);
    expect(protocols).toHaveLength(CALLS);
    expect(new Set(protocols)).toEqual(new Set(['http/1.1']));
  });
});

describe('CLI entry', () => {
  // The transport only helps if the process installs it before any provider call.
  it('installs the HTTP/1.1 transport before parsing the command line', () => {
    const entry = readFileSync(fileURLToPath(new URL('../../src/index.ts', import.meta.url)), 'utf8');
    expect(entry.indexOf('installHttp1Transport();')).toBeGreaterThan(-1);
    expect(entry.indexOf('installHttp1Transport();')).toBeLessThan(entry.indexOf('program.parse();'));
  });
});
