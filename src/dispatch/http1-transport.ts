import { Agent, setGlobalDispatcher, type buildConnector } from 'undici';

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
export function installHttp1Transport(options: { connect?: buildConnector.BuildOptions } = {}): Agent {
  const agent = new Agent({ allowH2: false, ...options });
  setGlobalDispatcher(agent);
  return agent;
}
