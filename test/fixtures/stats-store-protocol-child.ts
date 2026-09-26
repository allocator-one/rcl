import { appendCalls } from '../../src/models/stats-store.js';

const [dir, recordId] = process.argv.slice(2);
if (!dir || (!recordId && process.env.RCL_TEST_STATS_STORE_LEGACY !== '1')) {
  throw new Error('stats_store_protocol_child_arguments_required');
}

await appendCalls([{
  ...(process.env.RCL_TEST_STATS_STORE_LEGACY === '1' ? {} : { recordId }),
  ts: '2026-09-22T12:00:00.000Z',
  model: 'fixture',
  role: 'general',
  durationMs: 25,
  status: 'success',
  source: 'live',
}], dir);
process.send?.({ type: 'rcl-stats-store-protocol', event: 'acknowledged' });
