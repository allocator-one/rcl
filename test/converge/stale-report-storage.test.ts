import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { staleFixture } from './stale-report-fixtures.js';
import { StaleHistoryReader, retainStaleObject } from '../../src/converge/stale-report-storage.js';
import { applyStaleReport, previewStaleReport } from '../../src/converge/stale-report.js';
import { serializeRecoveryDocument } from '../../src/evidence/original-run/journal.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';

it('falls back to exact raw bytes when a later writer appends an optional native field', async () => {
  const f = await staleFixture(); await f.prepare(); await f.apply();
  const before = {...JSON.parse(await readFile(f.statePath,'utf8')), futureExtension:{text:'雪 🦊 \"quoted\"'}};
  await writeFile(f.statePath,serializeRecoveryDocument(before));
  const m = await previewStaleReport({...f.selection,inputSha256:'e'.repeat(64)},f.dir);
  const path = join(f.cwd,'extension.json'); await writeFile(path,JSON.stringify(m));
  await expect(applyStaleReport({manifest:path,manifestSha256:sha256(JSON.stringify(m)),mode:'apply'},f.dir)).resolves.toBe('applied');
  const descriptor = JSON.parse(await readFile(join(f.dir,'rcl-stale-report-audits',m.operationId,'native-before.json'),'utf8'));
  expect(descriptor.kind).toBe('raw');
  const reader = new StaleHistoryReader(f.dir); before.staleReportAudit.forEach((entry: Parameters<typeof reader.append>[0]) => reader.append(entry));
  expect((await reader.snapshot(join(f.dir,'rcl-stale-report-audits',m.operationId,'native-before.json'),m.stateSha256)).state).toEqual(before);
});

it('matches canonical serializer digests and reconstructs snapshots across varied audit prefixes', async () => {
  const f = await staleFixture(false,true), reader = new StaleHistoryReader(f.dir);
  for (let i=0;i<4;i++) {
    const before = JSON.parse(await readFile(f.statePath,'utf8'));
    f.selection.inputSha256 = i.toString(16).padStart(64,'0');
    f.selection.reason = 'Café 雪 🦊 \"quoted\"\n\t\\path '+i;
    const m = await f.prepare(); await f.apply();
    const after = JSON.parse(await readFile(f.statePath,'utf8'));
    const entry = after.staleReportAudit.at(-1);
    expect(reader.afterDigest(before,entry,m.createdAt)).toBe(sha256(serializeRecoveryDocument(after)));
    const snapshot = await reader.snapshot(join(f.dir,'rcl-stale-report-audits',m.operationId,'native-before.json'),m.stateSha256);
    expect(snapshot.state).toEqual(before);
    reader.append(entry);
  }
});

it('evicts old immutable objects as traversal advances to distinct evidence', async () => {
  const f = await staleFixture(), reader = new StaleHistoryReader(f.dir);
  const values = ['one','two','three','four'].map(value => Buffer.from(value));
  for (const value of values) { await retainStaleObject(f.dir,value); await reader.object(sha256(value)); }
  await writeFile(join(f.dir,'rcl-stale-report-audits','objects',sha256(values[0]!)),'damaged');
  await expect(reader.object(sha256(values[0]!))).rejects.toThrow('stale_report_digest_mismatch');
});

it('does not retain an oversized object in its bounded cache', async () => {
  const f = await staleFixture(), reader = new StaleHistoryReader(f.dir);
  const value = Buffer.alloc(3*1024*1024,'a'), digest = sha256(value);
  await retainStaleObject(f.dir,value); await reader.object(digest);
  await writeFile(join(f.dir,'rcl-stale-report-audits','objects',digest),'damaged');
  await expect(reader.object(digest).then(() => undefined)).rejects.toThrow('stale_report_digest_mismatch');
});

it('checks retained operation evidence before an idempotent resume can return', async () => {
  const f = await staleFixture(), m = await f.prepare(); await f.apply();
  await rm(join(f.dir,'rcl-stale-report-audits',m.operationId),{recursive:true});
  const before = await f.bytes();
  await expect(f.apply('resume')).rejects.toThrow('stale_report_audit_invalid');
  expect(await f.bytes()).toEqual(before);
});

it('resumes the crash window after directory creation but before the first retained artifact', async () => {
  const f = await staleFixture(), m = await f.prepare(), before = await f.bytes();
  const root = join(f.dir,'rcl-stale-report-audits');
  await mkdir(root,{mode:0o700}); await mkdir(join(root,m.operationId),{mode:0o700});
  await expect(f.apply('resume')).resolves.toBe('applied');
  expect((await f.bytes()).slice(1)).toEqual(before.slice(1));
});
