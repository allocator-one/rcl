import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { sampleResult, sampleReview } from '../telemetry/fixtures.js';
import { buildRunEnvelope, sha256Hex } from '../../src/telemetry/envelope.js';
import { Outbox } from '../../src/telemetry/outbox.js';
import { projection } from './original-run-fixtures.js';
import type { RunEnvelope } from '../../src/telemetry/envelope.js';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = process.env['RCL_TEST_PACKAGED_CLI'] || join(root, 'dist/index.js');
async function snapshot(dir: string): Promise<unknown> {
  const rows: unknown[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const p = join(dir, name); const s = await stat(p);
    rows.push([name, s.isDirectory() ? await snapshot(p) : [(await readFile(p)).toString('base64'), s.mtimeMs, s.mode]]);
  }
  return rows;
}
it('built Mode A rejects bad pins without flushing, then previews only into its exclusive manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rcl-original-cli-'));
  const data = join(dir, 'data'); await mkdir(data); await mkdir(join(dir, 'config'));
  const report = sampleResult({ reviews: [sampleReview()], belowThresholdFindings: [] });
  report.findings[0]!.description = 'Selected control \0 prose';
  const json = JSON.stringify(report); const path = join(dir, 'original.json'); await writeFile(path, json);
  const envelope = buildRunEnvelope(report, { report_json: json }, { level: 'full', delivery: { mode: 'direct' } });
  await new Outbox(join(data, 'outbox')).spoolRun({ runId: envelope.run.id, envelope, artifacts: { report_json: json }, events: [] });
  const before = await snapshot(data); const requests: string[] = [];
  let recorded: RunEnvelope | undefined;
  let evidenceProtocol = 2;
  let proseRepresentation = false;
  const stored: Record<string, string> = {};
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    requests.push(`${req.method} ${req.url}`); res.setHeader('content-type', 'application/json');
    const currentMeta = { org_id: '919921a0-0000-4000-8000-000000000001', evidence_protocol_version: evidenceProtocol, original_report_recovery_version: 1, ...(proseRepresentation ? { original_prose_representation_version: 1 } : {}) };
    if (req.url === '/api/v1/reviews/runs?page_size=1') res.end(JSON.stringify({ data: [], meta: currentMeta }));
    else if (req.method === 'POST' && req.url === '/api/v1/reviews/runs') {
      recorded = JSON.parse(body); res.statusCode = 201; res.end(JSON.stringify({ data: { id:recorded!.run.id, url:'/run', artifacts_expected:['report_json'] } }));
    } else if (recorded && req.url === `/api/v1/reviews/runs/${recorded.run.id}`) {
      res.end(JSON.stringify({ data:projection(recorded,stored), meta: currentMeta }));
    } else if (recorded && req.url === `/api/v1/reviews/runs/${recorded.run.id}/artifacts/report_json` && req.method === 'PUT') {
      stored.report_json = body; res.statusCode = 201; res.end(JSON.stringify({ data:{ kind:'report_json',sha256:sha256Hex(body) } }));
    } else if (recorded && stored.report_json !== undefined && req.url === `/api/v1/reviews/runs/${recorded.run.id}/artifacts/report_json`) {
      res.setHeader('content-type','application/octet-stream'); res.setHeader('x-artifact-sha256',sha256Hex(stored.report_json));res.end(stored.report_json);
    } else { res.statusCode = 404; res.end(JSON.stringify({ error: 'not_found' })); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error();
    const env = { PATH: process.env.PATH, ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}), RCL_DATA_DIR: data, XDG_CONFIG_HOME: join(dir, 'config'), HARNESS_API_TOKEN: 'aone_SYNTHETIC_LOCAL_ONLY', HARNESS_API_URL: `http://127.0.0.1:${address.port}`, NO_COLOR: '1' };
    const manifest = join(dir, 'manifest.json');
    const args = ['evidence', 'recover-run', '--preview', '--manifest', manifest, '--run', report.run!.id, '--for-pr', 'allocator-one/rcl#42', '--head', 'a'.repeat(40), '--report-json', path, '--original-mode', 'asserted', '--original-prose', 'control-code-units-v1', '--json'];
    const bad = await exec(process.execPath, [cli, ...args, '--report-sha256', 'f'.repeat(64)], { cwd: dir, env }).catch(e => e);
    expect(bad.code).toBe(2); expect(requests).toEqual([]); expect(await snapshot(data)).toEqual(before);
    evidenceProtocol = 3;
    const future = await exec(process.execPath, [cli, ...args, '--report-sha256', sha256Hex(json)], { cwd: dir, env }).catch(e => e);
    expect(future.code).toBe(3);
    expect(JSON.parse(future.stdout)).toMatchObject({ status:'incomplete',error:'recovery_capability_or_destination_rejected' });
    expect(requests).toEqual(['GET /api/v1/reviews/runs?page_size=1']);
    await expect(readFile(manifest)).rejects.toMatchObject({ code:'ENOENT' });
    expect(await snapshot(data)).toEqual(before);
    evidenceProtocol = 2;
    const unavailable = await exec(process.execPath, [cli, ...args, '--report-sha256', sha256Hex(json)], { cwd: dir, env }).catch(e => e);
    expect(unavailable.code).toBe(3);
    expect(JSON.parse(unavailable.stdout)).toMatchObject({ status:'incomplete',error:'recovery_capability_or_destination_rejected' });
    expect(requests).toEqual(['GET /api/v1/reviews/runs?page_size=1','GET /api/v1/reviews/runs?page_size=1']);
    await expect(readFile(manifest)).rejects.toMatchObject({ code:'ENOENT' });
    proseRepresentation = true;
    await exec(process.execPath, [cli, ...args, '--report-sha256', sha256Hex(json)], { cwd: dir, env });
    const plan = JSON.parse(await readFile(manifest, 'utf8'));
    expect(plan.prepared.envelope.run).toEqual(report.run);
    expect(plan.prepared.envelope.artifacts_declared[0].sha256).toBe(sha256Hex(json));
    expect(plan.prepared.selection.originalProse).toBe('control-code-units-v1');
    expect(plan.prepared.transformations).toEqual(expect.arrayContaining([expect.objectContaining({ kind:'control_code_unit', original_unit:'0000' })]));
    expect(requests.every(r => r.startsWith('GET '))).toBe(true);
    expect(await snapshot(data)).toEqual(before); expect(await readFile(path, 'utf8')).toBe(json);
    const outboxBefore = await snapshot(join(data,'outbox'));
    const selected = ['evidence','recover-run','--manifest',manifest,'--manifest-sha256',sha256Hex(await readFile(manifest,'utf8')),'--json'];
    const applied = await exec(process.execPath, [cli,...selected,'--apply'],{cwd:dir,env});
    expect(JSON.parse(applied.stdout).status).toBe('complete');
    expect(recorded!.run.id).toBe(report.run!.id); expect(stored.report_json).toBe(json);
    const writes = requests.filter(r => !r.startsWith('GET '));
    const resumed = await exec(process.execPath, [cli,...selected,'--resume'],{cwd:dir,env});
    expect(JSON.parse(resumed.stdout).status).toBe('complete');expect(requests.filter(r => !r.startsWith('GET '))).toEqual(writes);
    expect(writes).toEqual(['POST /api/v1/reviews/runs',`PUT /api/v1/reviews/runs/${report.run!.id}/artifacts/report_json`]);
    expect(await snapshot(join(data,'outbox'))).toEqual(outboxBefore);
    await expect(exec(process.execPath, [cli, ...args, '--report-sha256', sha256Hex(json)], { cwd: dir, env })).rejects.toBeTruthy();
  } finally { await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); }
}, 30000);
