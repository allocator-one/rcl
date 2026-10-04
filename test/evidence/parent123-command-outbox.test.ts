import { expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publicLoopback } from './public-claim-loopback.js';
import { Outbox } from '../../src/telemetry/outbox.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { sampleResult } from '../telemetry/fixtures.js';

it.each(['preview', 'apply', 'resume'] as const)('public claim %s leaves unrelated pending evidence untouched', async mode => {
  const f = await publicLoopback();
  try {
    await mkdir(join(f.repo, '.harness-cli'));
    await writeFile(join(f.repo, '.harness-cli/config.json'), '{}');
    await writeFile(join(f.repo, '.review-council.json'), JSON.stringify({ harness: { telemetry: 'full' } }));
    if (mode !== 'preview') expect((await f.preview()).exit).toBe(0);
    if (mode === 'resume') expect((await f.execute()).exit).toBe(0);
    const outbox = new Outbox(join(f.root, 'data', 'outbox'));
    const envelope = buildRunEnvelope(sampleResult(), { report_json: '{}' }, { level: 'full', delivery: { mode: 'direct' } });
    await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: { report_json: '{}' } });
    const before = await outbox.list(), nativeBefore = await readFile(f.statePath);
    const priorCalls = f.calls.length;
    const result = mode === 'preview' ? await f.preview() : await f.execute(mode);
    expect(result.exit, result.stdout + result.stderr).toBe(0);
    expect(f.calls.slice(priorCalls).filter(call => call.method === 'POST' && call.path === '/api/v1/reviews/runs')).toEqual([]);
    expect(await outbox.list()).toEqual(before);
    if (mode !== 'apply') expect(await readFile(f.statePath)).toEqual(nativeBefore);
  } finally { await f.cleanup(); }
}, 30000);
