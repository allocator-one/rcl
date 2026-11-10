import { isDeepStrictEqual } from 'node:util';
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher, type buildConnector, type Dispatcher } from 'undici';

/**
 * Pin every `fetch` in this process, which carries all provider SDK traffic,
 * to HTTP/1.1 (RCL-213).
 *
 * Node 26's built-in `fetch` negotiates HTTP/2 and multiplexes every parallel
 * call to a provider host over one connection. When that connection resets, a
 * whole concurrent batch of reviewer calls fails together ("Connection
 * error.", "terminated", BAD_RECORD_MAC) and the council runs short. Under
 * HTTP/1.1 each call owns its socket, so a dropped socket costs one call.
 *
 * The dispatcher comes from the `undici` package, not Node's bundled copy.
 * Its `Agent` works with the built-in `fetch` on Node 22, 24 and 26.
 */
export function installHttp1Transport(options: { connect?: buildConnector.BuildOptions } = {}): Dispatcher {
  const current = getGlobalDispatcher();
  // A `--import` preload (or earlier code) may have set its own dispatcher, for example to lift
  // undici's 300 s headers timeout. Replacing it would silently undo that, so leave it alone.
  if (!isUntouchedDefault(current)) return current;
  const agent = envProxyEnabled()
    ? new EnvHttpProxyAgent({ allowH2: false, ...options, requestTls: options.connect })
    : new Agent({ allowH2: false, ...options });
  setGlobalDispatcher(agent);
  return agent;
}

/**
 * undici installs an option-less `Agent` when nothing set a global dispatcher, and Node installs an
 * option-less `EnvHttpProxyAgent` before user code runs when its environment proxy is on (RCL-233).
 * Anything else, a different class or an agent carrying options, was put there on purpose. The
 * options live under a private symbol, so a dispatcher whose options cannot be read counts as
 * customised: the transport then stays out of the way instead of overriding it.
 */
function isUntouchedDefault(dispatcher: Dispatcher): boolean {
  const name = dispatcher.constructor.name;
  if (name === 'Agent') return hasDefaultOptions(dispatcher);
  // An EnvHttpProxyAgent keeps its options private, but builds a plain `Agent` from everything
  // except the proxy settings, which is where a customised timeout or connect option lands. The
  // proxy settings land in the proxy agents it builds, so those are compared with the environment's.
  if (name === 'EnvHttpProxyAgent' && envProxyEnabled()) {
    return hasDefaultOptions(namedMember(dispatcher, 'no proxy agent')) && routesByEnvironment(dispatcher);
  }
  return false;
}

/**
 * Whether an `EnvHttpProxyAgent` sends the http and https traffic where the environment says, as a
 * default one does. A preload's explicit `httpProxy` or `httpsProxy` differs from it and must survive.
 * An explicit `noProxy` stays private inside the agent and cannot be seen. A route that cannot be
 * read counts as customised, like an option that cannot be read.
 */
function routesByEnvironment(dispatcher: object): boolean {
  let reference: EnvHttpProxyAgent;
  try {
    reference = new EnvHttpProxyAgent();
  } catch {
    return false;
  }
  reference.close().catch(() => undefined);
  const current = proxyRoutes(dispatcher);
  return !current.includes(undefined) && isDeepStrictEqual(current, proxyRoutes(reference));
}

/** The proxy URI each protocol goes through, `'direct'` when it uses the agent without a proxy. */
function proxyRoutes(dispatcher: object): unknown[] {
  const direct = namedMember(dispatcher, 'no proxy agent');
  return ['http proxy agent', 'https proxy agent'].map((name) => {
    const agent = namedMember(dispatcher, name);
    if (typeof agent !== 'object' || agent === null) return undefined;
    if (agent === direct) return 'direct';
    const proxy = namedMember(agent, 'proxy agent options');
    return typeof proxy === 'object' && proxy !== null ? (proxy as { uri?: unknown }).uri : undefined;
  });
}

function hasDefaultOptions(agent: unknown): boolean {
  const options = agentOptions(agent);
  return options !== undefined && isDeepStrictEqual(definedOnly(options), definedOnly(agentOptions(new Agent())));
}

/**
 * Node's bundled undici and this package's copy are different versions, so the same default `Agent`
 * can carry an option as `undefined` in one and omit it in the other.
 */
function definedOnly(options: unknown): unknown {
  if (typeof options !== 'object' || options === null) return options;
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}

function namedMember(owner: object, description: string): unknown {
  const key = Object.getOwnPropertySymbols(owner).find((symbol) => symbol.description === description);
  return key === undefined ? undefined : (owner as Record<symbol, unknown>)[key];
}

function agentOptions(agent: unknown): unknown {
  return typeof agent === 'object' && agent !== null ? namedMember(agent, 'options') : undefined;
}

/**
 * Node's `NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`) makes the built-in `fetch`
 * honour HTTP_PROXY, HTTPS_PROXY and NO_PROXY by installing its own global
 * dispatcher. Replacing it with a plain `Agent` would send provider calls direct,
 * so keep the proxy-aware dispatcher in that case and only turn HTTP/2 off.
 */
function envProxyEnabled(): boolean {
  // Options given through NODE_OPTIONS never appear in process.execArgv, so read both.
  const nodeOptions = (process.env.NODE_OPTIONS ?? '').split(/\s+/);
  return (
    process.env.NODE_USE_ENV_PROXY === '1' ||
    process.execArgv.includes('--use-env-proxy') ||
    nodeOptions.includes('--use-env-proxy')
  );
}
