import { readFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import net, { type AddressInfo, type Socket } from 'node:net';
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
  baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

/** What undici installs when nothing customised the global dispatcher: an option-less Agent. */
function useDefaultDispatcher(): void {
  setGlobalDispatcher(new Agent());
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
    useDefaultDispatcher();
    installHttp1Transport({ connect });
    await concurrently(call);
    expect(protocols).toHaveLength(CALLS);
    expect(new Set(protocols)).toEqual(new Set(['http/1.1']));
  });
});

describe('a dispatcher set before the transport (RCL-213)', () => {
  // A `--import` preload may lift undici's 300 s headers timeout (IO-21362) with its own global dispatcher.
  it('is left in place', () => {
    const preload = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    setGlobalDispatcher(preload);
    expect(installHttp1Transport({ connect })).toBe(preload);
    expect(getGlobalDispatcher()).toBe(preload);
  });

  it('is replaced when it is undici\'s untouched default', () => {
    useDefaultDispatcher();
    const installed = installHttp1Transport({ connect });
    expect(getGlobalDispatcher()).toBe(installed);
  });

  it('is left in place when installing twice', () => {
    useDefaultDispatcher();
    const first = installHttp1Transport({ connect });
    expect(installHttp1Transport({ connect })).toBe(first);
  });
});

describe('environment proxy (RCL-213)', () => {
  let proxy: http.Server;
  let proxyUrl: string;
  let connects: string[] = [];
  const tunnels = new Set<Socket>();

  beforeAll(async () => {
    proxy = http.createServer();
    proxy.on('connect', (req, clientSocket, head) => {
      connects.push(req.url ?? '');
      tunnels.add(clientSocket);
      const [host, port] = (req.url ?? '').split(':');
      const upstream = net.connect(Number(port), host, () => {
        tunnels.add(upstream);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    // closeAllConnections() leaves upgraded CONNECT tunnels open, which would hold close() back.
    for (const socket of tunnels) socket.destroy();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  afterEach(() => {
    connects = [];
  });

  // Node's NODE_USE_ENV_PROXY=1 makes the built-in fetch route through HTTPS_PROXY by installing its own
  // global dispatcher; replacing that dispatcher must not silently send provider calls direct.
  it('keeps routing through HTTPS_PROXY when Node was started with NODE_USE_ENV_PROXY=1', async () => {
    vi.stubEnv('NODE_USE_ENV_PROXY', '1');
    vi.stubEnv('HTTPS_PROXY', proxyUrl);
    vi.stubEnv('https_proxy', proxyUrl);
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    useDefaultDispatcher();
    installHttp1Transport({ connect });
    protocols = [];
    const response = await fetch(baseUrl, { method: 'POST', body: '{}' });
    expect(response.status).toBe(400);
    expect(connects).toEqual([new URL(baseUrl).host]);
    expect(protocols).toEqual(['http/1.1']);
  });

  it('keeps routing through HTTPS_PROXY when --use-env-proxy comes from NODE_OPTIONS', async () => {
    vi.stubEnv('NODE_USE_ENV_PROXY', '');
    vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=4096 --use-env-proxy');
    vi.stubEnv('HTTPS_PROXY', proxyUrl);
    vi.stubEnv('https_proxy', proxyUrl);
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    useDefaultDispatcher();
    installHttp1Transport({ connect });
    await fetch(baseUrl, { method: 'POST', body: '{}' });
    expect(connects).toEqual([new URL(baseUrl).host]);
  });

  it('connects directly when the environment proxy is not enabled', async () => {
    vi.stubEnv('NODE_USE_ENV_PROXY', '');
    vi.stubEnv('HTTPS_PROXY', proxyUrl);
    vi.stubEnv('https_proxy', proxyUrl);
    useDefaultDispatcher();
    installHttp1Transport({ connect });
    await fetch(baseUrl, { method: 'POST', body: '{}' });
    expect(connects).toEqual([]);
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
