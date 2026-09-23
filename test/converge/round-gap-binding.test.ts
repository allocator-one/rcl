import { afterEach, expect, it } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { previewRoundGap, roundGapOperationPath } from '../../src/converge/round-gap.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';

import { fixture, cleanup } from './round-gap-fixtures.js';
afterEach(cleanup);

it('rejects a supplied report digest that does not describe the selected actual bytes', async () => {
  const f = await fixture();
  await expect(previewRoundGap({ ...f.input, reportSha256: 'f'.repeat(64) }, f.dir)).rejects.toThrow();
});
it('rejects a matching file digest whose original run target or round is wrong', async () => {
  const f = await fixture(); f.report.run!.converge!.target = 'other-target';
  await writeFile(f.input.reportPath, JSON.stringify(f.report));
  await expect(previewRoundGap({ ...f.input, reportSha256: sha256(await readFile(f.input.reportPath)) }, f.dir)).rejects.toThrow();
});
it('requires the actual gap attempt record, not a claimed total', async () => {
  const f = await fixture(); f.attempts.attempts = [];
  await writeFile(f.attemptPath, JSON.stringify(f.attempts));
  await expect(previewRoundGap(f.input, f.dir)).rejects.toThrow();
});
it('rechecks selected partial evidence before mutation', async () => {
  const f = await fixture(), manifest = await f.prepare(), before = await readFile(f.statePath);
  await writeFile(f.input.incompletePath, 'changed partial evidence');
  await expect(f.apply()).rejects.toThrow();
  expect(await readFile(f.statePath)).toEqual(before);
});
it('retains exact native and attempt snapshots before changing native audit', async () => {
  const f = await fixture();
  const native = await readFile(f.statePath);
  const attempts = await readFile(f.attemptPath);
  const report = await readFile(f.input.reportPath);
  const incomplete = await readFile(f.input.incompletePath);
  const manifest = await f.prepare();
  await f.apply();
  const operation = roundGapOperationPath(f.dir, manifest.operationId);
  expect(await readFile(join(operation, 'native-before.json'))).toEqual(native);
  expect(await readFile(join(operation, 'attempts-before.json'))).toEqual(attempts);
  expect(await readFile(join(operation, 'source-0.bin'))).toEqual(report);
  expect(await readFile(join(operation, 'source-1.bin'))).toEqual(incomplete);
  expect(await readFile(f.attemptPath)).toEqual(attempts);
  expect(await readFile(f.input.reportPath)).toEqual(report);
  expect(await readFile(f.input.incompletePath)).toEqual(incomplete);
});
it('refuses unknown audit manifest versions before native writes', async () => {
  const f = await fixture(), manifest = await f.prepare();
  await f.save({ ...manifest, version: 2 } as never);
  const native = await readFile(f.statePath);
  const attempts = await readFile(f.attemptPath);
  await expect(f.apply()).rejects.toThrow();
  expect(await readFile(f.statePath)).toEqual(native);
  expect(await readFile(f.attemptPath)).toEqual(attempts);
  await expect(readdir(join(f.dir, 'rcl-converge-gap-audits'))).rejects.toMatchObject({ code: 'ENOENT' });
});
