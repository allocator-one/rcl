import { afterEach, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { staleFixture } from './stale-report-fixtures.js';
import { retainStaleFile } from '../../src/converge/stale-report-storage.js';

const race = vi.hoisted(() => ({destination:'', conflicting:false}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {...actual, link:async (...args:Parameters<typeof actual.link>) => {
    if (String(args[1]) === race.destination) {
      // Another writer publishes between this caller's missing-file read and link.
      const bytes = race.conflicting ? Buffer.from('conflicting evidence') : await actual.readFile(args[0]);
      await actual.writeFile(args[1],bytes,{flag:'wx',mode:0o600});
    }
    return actual.link(...args);
  }};
});
afterEach(() => {race.destination=''; race.conflicting=false;});

it.each([false,true])('handles concurrent immutable publication without overwriting or leaving staging files (conflict=%s)', async conflicting => {
  const f = await staleFixture(), path = join(f.cwd,'shared-object');
  race.destination=path; race.conflicting=conflicting;
  const bytes = Buffer.from('original evidence');
  const result = retainStaleFile(path,bytes);
  if (conflicting) await expect(result).rejects.toThrow('stale_report_retained_conflict');
  else await expect(result).resolves.toBeUndefined();
  expect(await readFile(path)).toEqual(conflicting ? Buffer.from('conflicting evidence') : bytes);
  expect((await readdir(f.cwd)).filter(name => name.endsWith('.pending'))).toEqual([]);
});
