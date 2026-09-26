import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { staleFixture } from './stale-report-fixtures.js';
import { guardReviewLaunch, ReviewLaunchRefused } from '../../src/converge/launch-guard.js';
import { loadConvergeRunState } from '../../src/converge/run-state.js';
import { validateStaleReportAudit } from '../../src/converge/stale-report-schema.js';
import { applyStaleReport, previewStaleReport } from '../../src/converge/stale-report.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';

async function correction(f: Awaited<ReturnType<typeof staleFixture>>, inputSha256: string) {
  const selection = { ...f.selection, inputSha256 };
  const manifest = await previewStaleReport(selection, f.dir);
  const path = join(f.cwd, `${manifest.operationId}.json`);
  await writeFile(path, JSON.stringify(manifest));
  const apply = () => applyStaleReport({manifest:path, manifestSha256:sha256(JSON.stringify(manifest)), mode:'apply'}, f.dir);
  return {selection, manifest, apply};
}

it('can return to an earlier inspected replacement after a later input was mistaken', async () => {
  const f = await staleFixture(); await f.prepare(); await f.apply();
  await (await correction(f, 'e'.repeat(64))).apply();
  await expect(guardReviewLaunch({...f.options,...f.selection})).resolves.toMatchObject({attempt:2});
  expect(f.options.run).toHaveBeenCalledTimes(2);
});

it.each(['missing','tampered'] as const)('refuses %s earlier receipts in preview, apply and guarded launch', async kind => {
  const f = await staleFixture(), first = await f.prepare(); await f.apply();
  const second = await correction(f, 'e'.repeat(64)); await second.apply();
  const third = await correction(f, 'f'.repeat(64));
  const path = join(f.dir,'rcl-stale-report-audits',first.operationId,'complete.json');
  if (kind === 'missing') await rm(path); else await writeFile(path,'{}');
  const before = await f.bytes();
  await expect(correction(f,'9'.repeat(64))).rejects.toThrow('stale_report_audit_invalid');
  await expect(third.apply()).rejects.toThrow('stale_report_audit_invalid');
  await expect(guardReviewLaunch({...f.options,...second.selection})).rejects.toMatchObject({
    name:ReviewLaunchRefused.name, code:'stale_report_audit_invalid',
  });
  expect(await f.bytes()).toEqual(before);
  expect(f.options.run).toHaveBeenCalledTimes(1);
});

it('reports a missing resume operation without creating one', async () => {
  const f = await staleFixture(); await f.prepare(); const before = await f.bytes();
  await expect(f.apply('resume')).rejects.toThrow('stale_report_operation_missing');
  expect(await f.bytes()).toEqual(before);
});

it('refuses a duplicate plan but allows its already-audited input to launch', async () => {
  const f = await staleFixture(); await f.prepare(); await f.apply();
  await expect(f.prepare()).rejects.toThrow('stale_report_already_disposed');
  await expect(guardReviewLaunch({...f.options,...f.selection})).resolves.toMatchObject({attempt:2});
});

it('refuses head-only movement as a material input change', async () => {
  const f = await staleFixture(), before = await f.bytes();
  await expect(previewStaleReport({...f.selection,inputSha256:f.options.inputSha256},f.dir)).rejects.toThrow('inputs_unchanged');
  expect(await f.bytes()).toEqual(before);
});

it.each(['empty','digest','operation','replacement','target','unchanged','admitted','original','report','attempt','run'] as const)(
  'rejects corrupted %s audit state before claiming or reviewing', async kind => {
    const f = await staleFixture(); await f.prepare(); await f.apply();
    const state = (await loadConvergeRunState(f.dir,f.target))!;
    const entry = {...state.staleReportAudit![0]!};
    const manifest = JSON.parse(entry.manifestJson);
    if (kind === 'empty') state.staleReportAudit = [];
    else if (kind === 'digest') entry.manifestSha256 = '0'.repeat(64);
    else if (kind === 'operation') state.staleReportAudit!.push(entry);
    else if (kind === 'admitted') state.rounds.push({round:1,runId:manifest.runId,counts:{new:0,repeat:0,suppressed:0,regating:0}});
    else {
      if (kind === 'target') manifest.target = 'different-target';
      if (kind === 'unchanged') manifest.inputSha256 = manifest.previousInputSha256;
      if (['replacement','original','report','attempt','run'].includes(kind)) {
        manifest.operationId = randomUUID();
        if (kind !== 'replacement') manifest.inputSha256 = 'e'.repeat(64);
        if (kind === 'original') manifest.previousHeadSha = 'f'.repeat(40);
        if (kind === 'report') manifest.reportSha256 = 'f'.repeat(64);
        if (kind === 'attempt') manifest.attemptSha256 = 'f'.repeat(64);
        if (kind === 'run') manifest.attempt++;
        state.staleReportAudit!.push(entry);
      }
      entry.manifestJson = JSON.stringify(manifest); entry.manifestSha256 = sha256(entry.manifestJson);
    }
    if (state.staleReportAudit!.length === 1) state.staleReportAudit![0] = entry;
    state.staleReportAuditCount = state.staleReportAudit!.length;
    await writeFile(f.statePath,JSON.stringify(state)); const before = await f.bytes();
    await expect(loadConvergeRunState(f.dir,f.target)).rejects.toThrow('invalid_stale_report_audit');
    await expect(guardReviewLaunch({...f.options,...f.selection})).rejects.toMatchObject({code:'stale_report_audit_invalid'});
    expect(await f.bytes()).toEqual(before); expect(f.options.run).toHaveBeenCalledTimes(1);
  });

it('bounds the number of retained audit entries before validating their contents', async () => {
  const f = await staleFixture(); await f.prepare(); await f.apply();
  const state = (await loadConvergeRunState(f.dir,f.target))!;
  state.staleReportAudit = Array(10001).fill(state.staleReportAudit![0]);
  state.staleReportAuditCount = 10001;
  expect(() => validateStaleReportAudit(state)).toThrow('invalid_stale_report_audit');
});

it.each(['reordered','removed'] as const)('rejects %s history through its retained prefix proof', async kind => {
  const f = await staleFixture(); await f.prepare(); await f.apply();
  const second = await correction(f,'e'.repeat(64)); await second.apply();
  const state = (await loadConvergeRunState(f.dir,f.target))!;
  state.staleReportAudit = kind === 'reordered' ? state.staleReportAudit!.reverse() : state.staleReportAudit!.slice(1);
  state.staleReportAuditCount = state.staleReportAudit.length;
  await writeFile(f.statePath,JSON.stringify(state)); const before = await f.bytes();
  await expect(guardReviewLaunch({...f.options,...second.selection})).rejects.toMatchObject({code:'stale_report_audit_invalid'});
  expect(await f.bytes()).toEqual(before); expect(f.options.run).toHaveBeenCalledTimes(1);
});

it.each(['report','attempts','template','descriptor'] as const)('rejects damaged retained %s evidence before launch', async kind => {
  const f = await staleFixture(); const first = await f.prepare(); await f.apply();
  const second = await correction(f,'e'.repeat(64)); await second.apply();
  const root = join(f.dir,'rcl-stale-report-audits');
  const descriptor = join(root,second.manifest.operationId,'native-before.json');
  const digest = kind === 'report' ? f.reportSha256 : kind === 'attempts' ? first.attemptSha256 :
    JSON.parse(await readFile(descriptor,'utf8')).sha256;
  await writeFile(kind === 'descriptor' ? descriptor : join(root,'objects',digest),'{}');
  const before = await f.bytes();
  await expect(guardReviewLaunch({...f.options,...second.selection})).rejects.toMatchObject({code:'stale_report_audit_invalid'});
  expect(await f.bytes()).toEqual(before); expect(f.options.run).toHaveBeenCalledTimes(1);
});

async function bytesUnder(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const path = join(directory,entry.name);
    total += entry.isDirectory() ? await bytesUnder(path) : (await stat(path)).size;
  }
  return total;
}

it('retains large original evidence once while replacement corrections grow by small records', async () => {
  const f = await staleFixture(false,true);
  const state = (await loadConvergeRunState(f.dir,f.target))!;
  Object.values(state.findings)[0]!.title = 'history '.repeat(32768);
  const report = Buffer.concat([await readFile(f.reportPath),Buffer.from(' '.repeat(256*1024))]);
  await writeFile(f.reportPath,report);
  f.selection.reportSha256 = sha256(report); state.lastLaunch!.reportJsonSha256 = f.selection.reportSha256;
  await writeFile(f.statePath,JSON.stringify(state));
  await f.prepare(); await f.apply();
  await (await correction(f,'1'.repeat(64))).apply();
  const directory = join(f.dir,'rcl-stale-report-audits');
  const before = await bytesUnder(directory);
  for (const digit of ['2','3','4','5','6','7']) await (await correction(f,digit.repeat(64))).apply();
  expect(await bytesUnder(directory) - before).toBeLessThan(100*1024);
  expect(await readFile(f.reportPath)).toEqual(report);
},30000);

it('can inspect original inputs again without admitting their previously disposed report', async () => {
  const f = await staleFixture(); await f.prepare(); await f.apply();
  const manifest = await previewStaleReport({...f.selection,headSha:f.options.headSha,inputSha256:f.options.inputSha256},f.dir);
  const path = join(f.cwd,'original-again.json'); await writeFile(path,JSON.stringify(manifest));
  await applyStaleReport({manifest:path,manifestSha256:sha256(JSON.stringify(manifest)),mode:'apply'},f.dir);
  await expect(guardReviewLaunch(f.options)).resolves.toMatchObject({attempt:2});
  expect(f.options.run).toHaveBeenCalledTimes(2);
});

it('detects removal of the latest audit entry while retaining earlier evidence', async () => {
  const f = await staleFixture(); await f.prepare(); await f.apply();
  await (await correction(f,'e'.repeat(64))).apply();
  const state = (await loadConvergeRunState(f.dir,f.target))!;
  state.staleReportAudit!.pop(); await writeFile(f.statePath,JSON.stringify(state));
  const before = await f.bytes();
  await expect(guardReviewLaunch({...f.options,...f.selection})).rejects.toMatchObject({code:'stale_report_audit_invalid'});
  expect(await f.bytes()).toEqual(before); expect(f.options.run).toHaveBeenCalledTimes(1);
});

it('does not repeatedly serialize the growing historical audit on a guarded launch', async () => {
  const f = await staleFixture(); await f.prepare(); await f.apply();
  for (let i=1;i<32;i++) await (await correction(f,i.toString(16).padStart(64,'0'))).apply();
  const stringify = JSON.stringify;
  let serializedEntries = 0;
  const spy = vi.spyOn(JSON,'stringify').mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
    const value = args[0];
    if (value && typeof value === 'object' && Array.isArray(value.staleReportAudit)) serializedEntries += value.staleReportAudit.length;
    return stringify(...args);
  });
  try {
    await expect(guardReviewLaunch({...f.options,...f.selection})).resolves.toMatchObject({attempt:2});
    expect(serializedEntries).toBeLessThanOrEqual(4*32);
  } finally { spy.mockRestore(); }
},60000);
