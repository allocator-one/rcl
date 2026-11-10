import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

// A `--import` preload that lifts undici's 300 s headers timeout (IO-21362) on top of the env proxy.
setGlobalDispatcher(new EnvHttpProxyAgent({ headersTimeout: 0, bodyTimeout: 0 }));
