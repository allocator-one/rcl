import { getGlobalDispatcher } from 'undici';
import { installHttp1Transport } from '../../src/dispatch/http1-transport.js';

// Runs in a child process (RCL-233): reports what installHttp1Transport() did to whatever
// dispatcher Node, or a `--import` preload, left in place before user code ran.
const before = getGlobalDispatcher();
const installed = installHttp1Transport();
console.log(
  JSON.stringify({
    before: before.constructor.name,
    after: getGlobalDispatcher().constructor.name,
    replaced: installed !== before,
    globalIsInstalled: getGlobalDispatcher() === installed,
  }),
);
