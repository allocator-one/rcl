import { Agent, EnvHttpProxyAgent, setGlobalDispatcher, type buildConnector, type Dispatcher } from 'undici';

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
  const agent = envProxyEnabled()
    ? new EnvHttpProxyAgent({ allowH2: false, ...options, requestTls: options.connect })
    : new Agent({ allowH2: false, ...options });
  setGlobalDispatcher(agent);
  return agent;
}

/**
 * Node's `NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`) makes the built-in `fetch`
 * honour HTTP_PROXY, HTTPS_PROXY and NO_PROXY by installing its own global
 * dispatcher. Replacing it with a plain `Agent` would send provider calls direct,
 * so keep the proxy-aware dispatcher in that case and only turn HTTP/2 off.
 */
function envProxyEnabled(): boolean {
  return process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy');
}
