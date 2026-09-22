import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeOriginalReport } from '../../src/evidence/original-run/decode.js';
import { prepareOriginalRun } from '../../src/evidence/original-run/source.js';
import { runOriginalRecovery, type OriginalRunOptions } from '../../src/evidence/recover-run.js';
import { matchesOriginalRun, instant } from '../../src/evidence/original-run/remote.js';
import { writeExclusive } from '../../src/evidence/original-run/journal.js';
import { readStable } from '../../src/telemetry/recovery/files.js';
import { sampleResult, sampleReview, sampleFinding } from '../telemetry/fixtures.js';
import { sha256Hex, type RunEnvelope } from '../../src/telemetry/envelope.js';
const dirs: string[] = [];
afterEach(async () => { for (const p of dirs.splice(0)) await rm(p, { recursive: true, force: true }); });
const org = '919921a0-0000-4000-8000-000000000001';
const meta = { org_id: org, evidence_protocol_version: 2, original_report_recovery_version: 1 };
import { projection } from './original-run-fixtures.js';
async function fixture(change?: (r: ReturnType<typeof sampleResult>) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'rcl-original-unit-')); dirs.push(dir);
  await mkdir(join(dir, 'data')); await mkdir(join(dir,'config'));
  const report = sampleResult({ reviews: [sampleReview()], findings: [sampleFinding({ description: 'Original \ud800 text; pair 😀 and literal \\uD800 stay.' })] }); change?.(report);
  const text = JSON.stringify(report, null, 2); const md = 'Synthetic original Markdown with unchanged bytes.\n';
  await writeFile(join(dir,'original.json'), text); await writeFile(join(dir,'original.md'), md);
  const selection = { run: report.run!.id, forPr: 'allocator-one/rcl#42', head: 'a'.repeat(40), reportJson: join(dir,'original.json'), reportSha256: sha256Hex(text), reportMd: join(dir,'original.md'), markdownSha256: sha256Hex(md), originalMode: 'asserted' as const };
  let recorded: RunEnvelope | undefined; const stored: Record<string, string> = {}; const requests: { method: string; path: string; body?: string }[] = [];
  const behavior = { losePost: false, losePut: false, rejectPost: false, capability: true, evidenceProtocol: 2, wrongOrg: false, failRead: false, corruptArtifact: false, mutateProjection: undefined as ((p: ReturnType<typeof projection>) => void) | undefined };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search; const method = init?.method ?? 'GET';
    requests.push({ method, path, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    const answer = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    const currentMeta = { ...meta, evidence_protocol_version: behavior.evidenceProtocol, org_id: behavior.wrongOrg ? '919921a0-0000-4000-8000-000000000002' : org, original_report_recovery_version: behavior.capability ? 1 : undefined };
    if (method === 'GET' && path.endsWith('?page_size=1')) return answer({ data: [], meta: currentMeta });
    if (method === 'POST') {
      const submitted = JSON.parse(String(init?.body));
      if (behavior.rejectPost) return answer({ error: 'invalid_original', message: 'source binding is invalid' }, 422);
      recorded = submitted; if (behavior.losePost) { behavior.losePost = false; throw new Error('synthetic response loss'); }
      return answer({ data: { id: recorded!.run.id, url: '/run', artifacts_expected: ['report_json','report_md'] } }, 201);
    }
    if (recorded && path.includes('/artifacts/')) {
      const kind = path.split('/').at(-1)!;
      if (method === 'PUT') {
        stored[kind] = String(init?.body); if (behavior.losePut) { behavior.losePut = false; throw new Error('synthetic response loss'); }
        return answer({ data: { kind, sha256: sha256Hex(stored[kind]) } }, 201);
      }
      if (stored[kind] !== undefined) return new Response(behavior.corruptArtifact ? stored[kind] + 'x' : stored[kind], { status: 200, headers: { 'x-artifact-sha256': sha256Hex(stored[kind]) } });
    }
    if (recorded && !path.includes('/artifacts/')) {
      if (behavior.failRead) return new Response('{broken', { status: 200 });
      const p = projection(recorded, stored); behavior.mutateProjection?.(p);
      return answer({ data: p, meta: currentMeta });
    }
    return answer({ error: 'not_found' }, 404);
  }) as typeof fetch;
  const stdout: string[] = []; const stderr: string[] = [];
  const deps = { rclVersion: '3.7.0', cwd: dir, env: { RCL_DATA_DIR: join(dir,'data'), XDG_CONFIG_HOME: join(dir,'config'), HARNESS_API_TOKEN: 'aone_SYNTHETIC_LOCAL_ONLY', HARNESS_API_URL: 'http://127.0.0.1:43210' }, fetchImpl, stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s) };
  const manifest = join(dir,'manifest.json');
  const preview = () => runOriginalRecovery({ preview: true, manifest, ...selection, json: true }, deps);
  const apply = async (resume = false, extra = {}) => runOriginalRecovery({ [resume ? 'resume' : 'apply']: true, manifest, manifestSha256: sha256Hex(await readFile(manifest, 'utf8')), json: true } as OriginalRunOptions, { ...deps, ...extra });
  return { dir, report, text, md, selection, behavior, stored, requests, stdout, stderr, deps, manifest, preview, apply, setRecorded: (e: RunEnvelope) => { recorded = e; }, recorded: () => recorded };
}

describe('original JSON interpretation', () => {
  it('records exact source offsets, preserves valid pairs and literal escapes, and isolates allowed prose', () => {
    const text = '{"findings":[{"description":"a\\uD800\\ud801\\uDC00\\udc01 \\\\uD800 😀"}]}';
    const decoded = decodeOriginalReport(text);
    expect(decoded.value).toEqual({ findings: [{ description: 'a\\uD800' + '\ud801\udc00' + '\\uDC01 \\uD800 😀' }] });
    expect(decoded.transformations.map(t => [t.original_unit,t.code_unit_offset,t.source_byte_offset,t.replacement])).toEqual([
      ['D800',1,text.indexOf('\\uD800'),'\\uD800'], ['DC01',4,text.indexOf('\\udc01'),'\\uDC01'],
    ]);
    for (const source of ['{"findings":[{"file":"\\ud800"}]}','{"run":{"title":"\\ud800"}}','{"\\ud800":1}', '{"findings":[{"claimDescriptor":{"invariant":"\\ud800"}}]}', '{"a":1,"\\u0061":2}', '{"x":"\\uD80"}', '{"x":1e999}', '{"x":null}junk']) expect(() => decodeOriginalReport(source)).toThrow();
  });
  it('preserves escaped quotes and odd/even backslash parity and rejects duplicate nested keys', () => {
    const text = JSON.stringify({ reviews: [{ findings: [{ title: '\\uD800 " \ud800', description: '\udc00' }] }] });
    const decoded = decodeOriginalReport(text);
    expect(decoded.transformations).toHaveLength(2);
    expect(() => decodeOriginalReport('{"x":[{"a":1,"a":2}]}')).toThrow('ambiguous');
  });
});

describe('source and receipt binding', () => {
  it('refuses a noncanonical original UUID before HTTP without rewriting source or creating recovery state', async () => {
    const f = await fixture(r => { r.run!.id = 'ABCDEFAB-1234-4123-8123-ABCDEF123456'; });
    expect(await f.preview()).toBe(2);
    expect(f.requests).toEqual([]);
    expect(await readFile(f.selection.reportJson, 'utf8')).toBe(f.text);
    await expect(readFile(f.manifest)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(f.dir, 'data'))).toEqual([]);
  });
  it('keeps bytes, ordered identities and descriptors; ranges use digest-bound historical projection', async () => {
    const f = await fixture(r => { r.findings[0]!.startLine = 20; r.findings[0]!.endLine = 10; });
    const { prepared, artifacts } = await prepareOriginalRun(f.selection);
    expect(artifacts.report_json).toBe(f.text); expect(artifacts.report_md).toBe(f.md);
    expect(prepared.envelope.run).toEqual(f.report.run);
    expect(prepared.envelope.findings.map(x => [x.ref,x.identity_key])).toEqual([['f001',f.report.findings[0]!.identity],['f002',f.report.belowThresholdFindings![0]!.identity]]);
    expect(prepared.envelope.findings[0]!.location_provenance).toEqual({ version:1,source:'report_projection',reason:'reversed_range',original_start_line:20,original_end_line:10,report_json_sha256:f.selection.reportSha256 });
    expect(prepared.envelope.findings[0]!.description).toContain('\\uD800');
    const projected = projection(prepared.envelope,{});
    expect(matchesOriginalRun(projected, prepared)).toBe(true);
    const changedInstant = structuredClone(projected);
    changedInstant.started_at = changedInstant.started_at.replace('.000000Z','.000001Z');
    expect(matchesOriginalRun(changedInstant, prepared)).toBe(false);
    projected.calls[0]!.duration_ms = 999; expect(matchesOriginalRun(projected, prepared)).toBe(false);
    expect(instant('2026-01-01T01:00:00.123456+01:00')).toBe(instant('2026-01-01T00:00:00.123456Z'));
    expect(instant('2026-01-01T00:00:00.123457Z')).not.toBe(instant('2026-01-01T00:00:00.123456Z'));
  });
  it('records reversed appendix ranges against their original source path', async () => {
    const f = await fixture(r => { r.belowThresholdFindings![0]!.startLine = 20; r.belowThresholdFindings![0]!.endLine = 10; });
    const { prepared } = await prepareOriginalRun(f.selection);
    expect(prepared.transport_derivations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/belowThresholdFindings/0/location', rule: 'existing_reversed_range_provenance' }),
    ]));
  });
  it('refuses unsafe/unknown modes, bad source pins, redaction and source symlinks before HTTP', async () => {
    for (const change of [(r: ReturnType<typeof sampleResult>) => { r.run!.runner.kind = 'ci'; }, (r: ReturnType<typeof sampleResult>) => { r.findings[0]!.description = 'sk-ant-abcdefghijklmnopqrstu'; }, (r: ReturnType<typeof sampleResult>) => { (r.run as unknown as Record<string,unknown>).attested = true; }]) {
      const f = await fixture(change); expect(await f.preview()).toBe(2); expect(f.requests).toEqual([]);
    }
    const f = await fixture(); const real = f.selection.reportJson; f.selection.reportJson = join(f.dir,'link.json'); await symlink(real, f.selection.reportJson);
    expect(await f.preview()).toBe(2); expect(f.requests).toEqual([]);
  });
  it('refuses unknown consensus-finding fields before they can be omitted from the recovery envelope', async () => {
    const f = await fixture(r => { Object.assign(r.findings[0]!, { unexpected_original_field: 'not transportable' }); });
    expect(await f.preview()).toBe(2);
    expect(f.requests).toEqual([]);
  });
});

describe('receipt-aware original delivery', () => {
  it('resolves lost POST and PUT acknowledgments by exact reads, and concurrent resumes never repost', async () => {
    const f = await fixture(); f.behavior.losePost = true; f.behavior.losePut = true;
    expect(await f.preview()).toBe(0); expect(f.requests.every(r => r.method === 'GET')).toBe(true);
    expect(await f.apply()).toBe(0);
    expect(f.recorded()!.run.id).toBe(f.report.run!.id); expect(f.stored).toEqual({ report_json:f.text, report_md:f.md });
    const writes = f.requests.filter(r => r.method !== 'GET');
    expect(writes.map(r => r.method)).toEqual(['POST','PUT','PUT']);
    expect(await Promise.all([f.apply(true),f.apply(true)])).toEqual([0,0]);
    expect(f.requests.filter(r => r.method !== 'GET')).toEqual(writes);
    expect(await readFile(f.selection.reportJson,'utf8')).toBe(f.text);
  });
  it('retains a post-commit checkpoint failure and resumes the same operation without duplicate writes', async () => {
    const f = await fixture(); expect(await f.preview()).toBe(0);
    expect(await f.apply(false,{ beforeCheckpoint: async (phase:string) => { if (phase === 'put_outcome') throw Object.assign(new Error('readonly'), { code:'EROFS' }); } })).toBe(5);
    expect(f.stored.report_json).toBe(f.text); expect(f.stored.report_md).toBeUndefined();
    expect(await f.apply(true)).toBe(0);
    expect(f.requests.filter(r => r.method === 'PUT' && r.path.endsWith('report_json'))).toHaveLength(1);
    expect((await readdir(f.manifest + '.journal')).length).toBeGreaterThan(5);
  });
  it('records a definitive POST refusal and does not advise an unchanged resume', async () => {
    const f = await fixture(); expect(await f.preview()).toBe(0); f.behavior.rejectPost = true;
    expect(await f.apply()).toBe(4);
    const result = JSON.parse(f.stdout.at(-1)!);
    expect(result).toMatchObject({ status: 'incomplete', error: 'run_delivery_rejected_invalid_original', stage: 'remote', exit_code: 4 });
    expect(result.instruction).toContain('do not resume');
    const records = await Promise.all((await readdir(f.manifest + '.journal')).sort().map(async name => JSON.parse(await readFile(join(f.manifest + '.journal', name), 'utf8'))));
    expect(records).toContainEqual(expect.objectContaining({ phase: 'post_outcome', data: { kind: 'rejected', http_status: 422, error: 'invalid_original' } }));
    expect(f.requests.filter(r => r.method === 'POST')).toHaveLength(1);
  });
  it('refuses complete header/finding/call conflicts, malformed receipts and corrupt raw artifacts', async () => {
    for (const mutate of [(p: ReturnType<typeof projection>) => { p.findings[0]!.description = 'different claim'; }, (p: ReturnType<typeof projection>) => { p.runner = { kind:'human' }; }, (p: ReturnType<typeof projection>) => { p.calls = []; }]) {
      const f = await fixture(); const source = await prepareOriginalRun(f.selection); f.setRecorded(source.prepared.envelope); f.behavior.mutateProjection = mutate;
      expect(await f.preview()).toBe(4); expect(f.requests.every(r => r.method === 'GET')).toBe(true);
    }
    const f = await fixture(); expect(await f.preview()).toBe(0); expect(await f.apply()).toBe(0);
    f.behavior.corruptArtifact = true; expect(await f.apply(true)).toBe(3);
    f.behavior.corruptArtifact = false; f.behavior.failRead = true; expect(await f.apply(true)).toBe(3);
  });
  it('refuses a future evidence protocol before creating a journal or posting a previewed missing run', async () => {
    const f = await fixture(); expect(await f.preview()).toBe(0);
    f.behavior.evidenceProtocol = 3;
    const firstApplyRequest = f.requests.length;
    expect(await f.apply()).toBe(3);
    expect(f.requests.slice(firstApplyRequest).map(r => [r.method,r.path])).toEqual([['GET','/api/v1/reviews/runs?page_size=1']]);
    expect(f.recorded()).toBeUndefined(); expect(f.stored).toEqual({});
    expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ status:'incomplete',error:'recovery_capability_or_destination_rejected' });
    await expect(readdir(f.manifest + '.journal')).rejects.toMatchObject({ code:'ENOENT' });
    expect(await readdir(join(f.dir,'data'))).toEqual([]);
  });
  it('old capability, changed organization, changed source and apply without a new manifest remain explicit', async () => {
    const f = await fixture(); f.behavior.capability = false; expect(await f.preview()).toBe(3); expect(f.requests.every(r => r.method === 'GET')).toBe(true);
    f.behavior.capability = true; expect(await f.preview()).toBe(0);
    f.behavior.wrongOrg = true; expect(await f.apply()).toBe(4); expect(f.requests.every(r => r.method === 'GET')).toBe(true);
    f.behavior.wrongOrg = false; await writeFile(f.selection.reportJson, f.text + ' ');
    const count = f.requests.length; expect(await f.apply()).toBe(2); expect(f.requests).toHaveLength(count);
  });
});

it('retains pre-existing prose redaction markers but refuses markers in bindings and descriptors', async () => {
  const f = await fixture(r => { r.findings[0]!.description = 'Original [redacted] prose [redacted].'; r.run!.target.kind = 'patch'; });
  const { prepared } = await prepareOriginalRun(f.selection);
  expect(prepared.envelope.run.target.kind).toBe('patch');
  expect(prepared.envelope.findings[0]!.description).toBe('Original [redacted] prose [redacted].');
  expect(prepared.retained_content_limitations.redacted_prose).toEqual([{path:'/findings/0/description',count:2}]);
  for (const change of [(r: ReturnType<typeof sampleResult>) => { r.findings[0]!.identity = '[redacted]'; }, (r: ReturnType<typeof sampleResult>) => { Object.assign(r.findings[0]!,{claimDescriptor:{version:1,operation:'op',invariant:'[redacted]',evidence:['anchor']}}); }]) {
    const bad = await fixture(change); expect(await bad.preview()).toBe(2); expect(bad.requests).toEqual([]);
  }
});

it('preserves valid descriptors exactly and refuses any descriptor normalization or duplicate described key', async () => {
  const descriptor = { version:1,operation:'Update widget',invariant:'Keep the independent claim',evidence:['widget.render','visible state'] };
  const f = await fixture(r => { Object.assign(r.findings[0]!,{claimDescriptor:descriptor}); });
  const {prepared} = await prepareOriginalRun(f.selection);
  expect((prepared.envelope.findings[0] as unknown as Record<string,unknown>).claim_descriptor).toEqual(descriptor);
  const collision = await fixture(r => { Object.assign(r.findings[0]!,{claimDescriptor:descriptor});r.belowThresholdFindings![0]!.identity = r.findings[0]!.identity; });
  expect(await collision.preview()).toBe(2);expect(collision.requests).toEqual([]);
  const invalid = await fixture(r => { Object.assign(r.findings[0]!,{claimDescriptor:{...descriptor,invariant:'unpaired\ud800'}}); });
  expect(await invalid.preview()).toBe(2);expect(invalid.requests).toEqual([]);
});

it('detects symlinked source directories, synthetic markers, invalid UTF-8 and a changed manifest before HTTP', async () => {
  const f = await fixture();
  await writeFile(join(f.dir,'SYNTHETIC_TEST_ONLY'),'yes'); expect(await f.preview()).toBe(2); expect(f.requests).toEqual([]);
  await rm(join(f.dir,'SYNTHETIC_TEST_ONLY'));
  await writeFile(f.selection.reportJson,Buffer.from([0xff,0xfe])); f.selection.reportSha256 = sha256Hex('');
  expect(await f.preview()).toBe(2);expect(f.requests).toEqual([]);
  const clean = await fixture(); await mkdir(join(clean.dir,'real')); await symlink(join(clean.dir,'real'),join(clean.dir,'alias'));
  await writeFile(join(clean.dir,'real','report.json'),clean.text);clean.selection.reportJson=join(clean.dir,'alias','report.json');
  expect(await clean.preview()).toBe(2);expect(clean.requests).toEqual([]);
});

it('does not submit when durable intent fails; retains torn final checkpoint and resolves only by fresh reads', async () => {
  const f = await fixture();expect(await f.preview()).toBe(0);
  expect(await f.apply(false,{beforeCheckpoint:async(phase:string)=>{if(phase==='post_intent')throw Object.assign(new Error('readonly'),{code:'EROFS'});}})).toBe(5);
  expect(f.requests.every(r=>r.method==='GET')).toBe(true);
  // A crash during the next exclusive append leaves an incomplete final file.
  await writeFile(join(f.manifest+'.journal','00000002.json'),'{"operation_id":');
  expect(await f.apply(true)).toBe(0);expect(f.requests.filter(r=>r.method==='POST')).toHaveLength(1);
  expect(await readFile(join(f.manifest+'.journal','00000002.json'),'utf8')).toBe('{"operation_id":');
  const writes = f.requests.filter(r=>r.method!=='GET');
  expect(await f.apply(true)).toBe(0);expect(f.requests.filter(r=>r.method!=='GET')).toEqual(writes);
  const retained = JSON.parse(await readFile(join(f.manifest+'.journal','00000003.json'),'utf8'));
  expect(retained.phase).toBe('interrupted_checkpoints_retained');
  expect(retained.data.files).toEqual([{file:'00000002.json',sha256:sha256Hex('{"operation_id":')}]);
});

it('rejects attested credentials without probing another credential or creating a manifest', async () => {
  const f = await fixture(); f.deps.env.HARNESS_API_TOKEN = 'rbc_SYNTHETIC_LOCAL_ONLY';
  expect(await f.preview()).toBe(3);expect(f.requests).toEqual([]);
});

it('refuses an unrelated corrupt middle checkpoint and never reports success before lock release', async () => {
  const f = await fixture();expect(await f.preview()).toBe(0);expect(await f.apply()).toBe(0);
  await writeFile(join(f.manifest+'.journal','00000002.json'),'{broken');
  const count = f.requests.length;expect(await f.apply(true)).toBe(4);
  expect(JSON.parse(f.stdout.at(-1)!).error).toBe('recovery_journal_binding_conflict');
  expect(f.requests.slice(count).every(r=>r.method==='GET')).toBe(true);
  const other = await fixture();expect(await other.preview()).toBe(0);other.stdout.length=0;
  expect(await other.apply(false,{beforeCheckpoint:async(phase:string)=>{
    if(phase==='complete'){
      const directory=join(other.dir,'data','original-run-recovery-locks');
      for(const file of await readdir(directory))await rm(join(directory,file));
    }
  }})).toBe(5);
  expect(other.stdout.map(s=>JSON.parse(s).status)).toEqual(['incomplete']);
});

it('rechecks source pins after durable intent and before the first remote write', async()=>{
  const f=await fixture();expect(await f.preview()).toBe(0);
  expect(await f.apply(false,{beforeCheckpoint:async(phase:string)=>{if(phase==='post_intent')await writeFile(f.selection.reportJson,f.text+' ');}})).toBe(2);
  expect(f.requests.every(r=>r.method==='GET')).toBe(true);
  expect(f.recorded()).toBeUndefined();
});


it('refuses a small original whose detailed transformations exceed the manifest bound before HTTP', async () => {
  const f = await fixture(r => { r.findings[0]!.description = '\ud800'.repeat(60_000); });
  expect(Buffer.byteLength(f.text)).toBeLessThan(400_000);
  expect(await f.preview()).toBe(2);
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ status:'incomplete',error:'recovery_document_too_large' });
  expect(f.requests).toEqual([]); expect(f.recorded()).toBeUndefined(); expect(f.stored).toEqual({});
  await expect(readFile(f.manifest)).rejects.toMatchObject({ code:'ENOENT' });
  await expect(readdir(f.manifest + '.journal')).rejects.toMatchObject({ code:'ENOENT' });
  expect(await readdir(join(f.dir,'data'))).toEqual([]);
  expect(await readFile(f.selection.reportJson,'utf8')).toBe(f.text);
});

it('bounds exclusive manifests by formatted UTF-8 bytes including the final LF, matching the reader', async () => {
  const f = await fixture(); const limit = 8 * 1024 * 1024;
  const overhead = Buffer.byteLength(JSON.stringify({ value:'' },null,2) + '\n');
  const available = limit - overhead;
  const value = { value:'😀'.repeat(Math.floor(available / 4)) + 'x'.repeat(available % 4) };
  expect(Buffer.byteLength(JSON.stringify(value,null,2) + '\n')).toBe(limit);
  await writeExclusive(f.manifest,value,limit);
  expect((await readStable(f.manifest,limit)).raw.length).toBe(limit);
  const tooLarge = f.manifest + '.oversized';
  await expect(writeExclusive(tooLarge,{ value:value.value + 'x' },limit)).rejects.toThrow('recovery_document_too_large');
  await expect(readFile(tooLarge)).rejects.toMatchObject({ code:'ENOENT' });
});


it('checks the complete manifest again when observation metadata makes its formatted bytes too large', async () => {
  const f = await fixture();
  const { prepared } = await prepareOriginalRun(f.selection);
  const preparedBytes = Buffer.byteLength(JSON.stringify({ prepared },null,2) + '\n');
  // Injectable client metadata is intentionally large: the prepared evidence alone
  // fits, but the complete document must still honor the same reader limit.
  f.deps.rclVersion = '😀'.repeat(Math.floor((8 * 1024 * 1024 - preparedBytes) / 4));
  expect(await f.preview()).toBe(2);
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ status:'incomplete',error:'recovery_document_too_large' });
  expect(f.requests.length).toBeGreaterThan(0); expect(f.requests.every(r => r.method === 'GET')).toBe(true);
  expect(f.recorded()).toBeUndefined(); expect(f.stored).toEqual({});
  await expect(readFile(f.manifest)).rejects.toMatchObject({ code:'ENOENT' });
  await expect(readdir(f.manifest + '.journal')).rejects.toMatchObject({ code:'ENOENT' });
  expect(await readdir(join(f.dir,'data'))).toEqual([]);
});
