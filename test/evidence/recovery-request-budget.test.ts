import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runPublicClaimRecovery, type PublicClaimRecoveryDeps } from '../../src/evidence/recover-claim.js';
import { publicLoopback } from './public-claim-loopback.js';
import { fixture } from './recovery-validation/occurrence-fixtures.js';
import { emptySource } from './recovery-validation/carrier-fixtures.js';
import { sha, uuid } from './recovery-validation/fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function clock(onSleep = () => {}) {
  let current = 0;
  const waits: number[] = [];
  return { now: () => current, wallTime: () => Date.now(), waits,
    sleep: async (ms: number) => { waits.push(ms); current += ms; onSleep(); } };
}

describe('public recovery request budget', { timeout: 45000 }, () => {
  it('persists a replaced original report digest before returning the helper', async () => {
    const f = await publicLoopback(); cleanups.push(f.cleanup);
    const report = { ...JSON.parse(f.source.reportJson), replacement: true };

    await f.replaceOriginal(report);

    expect(JSON.parse(await readFile(f.selectionPath, 'utf8')).source.reportSha256).toBe(sha(f.source.reportJson));
  });

  it('resumes an interrupted whole operation without reposting accepted stages or changing native accounting early', async () => {
    const input = fixture(); const f = await publicLoopback(input); cleanups.push(f.cleanup);
    f.addSource(emptySource(input.transfer, 2, true));
    const time = clock();
    const lines: string[] = [];
    const deps = (beforeCheckpoint?: PublicClaimRecoveryDeps['beforeCheckpoint']): PublicClaimRecoveryDeps => ({
      cwd: f.repo, env: f.env, rclVersion: 'test', requestClock: time, beforeCheckpoint,
      stdout: (line: string) => lines.push(line), stderr: () => {},
    });
    expect(await runPublicClaimRecovery({ preview: true, manifest: f.manifest, selection: f.selectionPath }, deps())).toBe(0);
    const manifestBytes = await readFile(f.manifest); const manifest = JSON.parse(manifestBytes.toString());
    const before = await readFile(f.statePath);
    let prepared = 0;
    expect(await runPublicClaimRecovery({ apply: true, manifest: f.manifest, manifestSha256: sha(manifestBytes.toString()) },
      deps(async phase => { if (phase === 'claim_event_prepared' && ++prepared === 2) throw new Error('synthetic operation interruption'); }))).toBe(4);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: 'refused', reason: 'claim_recovery_refused' });
    expect(await readFile(f.statePath)).toEqual(before);
    const firstPosts = f.calls.filter(call => call.method === 'POST');
    expect(firstPosts).toHaveLength(1);
    expect((firstPosts[0]!.body as any).events[0].id).toBe(manifest.stages[0].id);

    expect(await runPublicClaimRecovery({ resume: true, manifest: f.manifest, manifestSha256: sha(manifestBytes.toString()) }, deps())).toBe(0);
    const posts = f.calls.filter(call => call.method === 'POST').flatMap(call => (call.body as any).events);
    expect(posts.map(event => event.id).sort()).toEqual(manifest.stages.map((stage: any) => stage.id).sort());
    expect(new Set(posts.map(event => event.id)).size).toBe(manifest.stages.length);
    const after = await readFile(f.statePath); const native = JSON.parse(after.toString());
    expect(after).not.toEqual(before);
    expect(native.rounds).toEqual(JSON.parse(before.toString()).rounds);

    const postCount = posts.length;
    expect(await runPublicClaimRecovery({ resume: true, manifest: f.manifest, manifestSha256: sha(manifestBytes.toString()) }, deps())).toBe(0);
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(postCount);
    expect(await readFile(f.statePath)).toEqual(after);
  });

  it('explicitly adopts accepted UUIDs, replaces absent stages and keeps every old manifest pin immutable', async () => {
    const input = fixture(); const f = await publicLoopback(input); cleanups.push(f.cleanup);
    f.addSource(emptySource(input.transfer, 2, true));
    const time = clock();
    const lines: string[] = [];
    const deps = (beforeCheckpoint?: PublicClaimRecoveryDeps['beforeCheckpoint']): PublicClaimRecoveryDeps => ({
      cwd: f.repo, env: f.env, rclVersion: 'test', requestClock: time, beforeCheckpoint,
      stdout: (line: string) => lines.push(line), stderr: () => {},
    });
    expect(await runPublicClaimRecovery({ preview: true, manifest: f.manifest, selection: f.selectionPath }, deps())).toBe(0);
    const oldBytes = await readFile(f.manifest); const oldSha = sha(oldBytes.toString());
    const old = JSON.parse(oldBytes.toString());
    let prepared = 0;
    expect(await runPublicClaimRecovery({ apply: true, manifest: f.manifest, manifestSha256: oldSha },
      deps(async phase => { if (phase === 'claim_event_prepared' && ++prepared === 2) throw new Error('synthetic adoption boundary'); }))).toBe(4);
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    const pinnedPaths = [f.manifest, `${f.manifest}.material`,
      ...old.stages.flatMap((stage: any) => [`${f.manifest}.${stage.id}.input`, `${f.manifest}.${stage.id}.packet`])];
    const readPin = async (path: string): Promise<Buffer | null> => readFile(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    const pins = new Map(await Promise.all(pinnedPaths.map(async path => [path, await readPin(path)] as const)));

    const adoptedPath = `${f.manifest}.adopted`;
    expect(await runPublicClaimRecovery({ preview: true, manifest: adoptedPath,
      adoptManifest: f.manifest, adoptManifestSha256: oldSha }, deps())).toBe(0);
    const adoptedBytes = await readFile(adoptedPath); const adopted = JSON.parse(adoptedBytes.toString());
    expect(adopted.version).toBe(3);
    expect(adopted.stages[0].id).toBe(old.stages[0].id);
    expect(adopted.stages.slice(1).map((stage: any) => stage.id)).not.toEqual(old.stages.slice(1).map((stage: any) => stage.id));
    expect(adopted.preview.adoption).toMatchObject({ accepted_event_ids: [old.stages[0].id] });
    expect(adopted.preview.adoption.replacements.map((item: any) => item.oldId).sort())
      .toEqual(old.stages.slice(1).map((stage: any) => stage.id).sort());

    expect(await runPublicClaimRecovery({ apply: true, manifest: adoptedPath,
      manifestSha256: sha(adoptedBytes.toString()) }, deps())).toBe(0);
    const posts = f.calls.filter(call => call.method === 'POST').flatMap(call => (call.body as any).events);
    expect(posts.map(event => event.id).sort()).toEqual(adopted.stages.map((stage: any) => stage.id).sort());
    expect(posts.filter(event => event.id === old.stages[0].id)).toHaveLength(1);
    for (const [path, bytes] of pins) expect(await readPin(path)).toEqual(bytes);
    const after = await readFile(f.statePath); const postCount = posts.length;

    expect(await runPublicClaimRecovery({ resume: true, manifest: adoptedPath,
      manifestSha256: sha(adoptedBytes.toString()) }, deps())).toBe(0);
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(postCount);
    expect(await readFile(f.statePath)).toEqual(after);
    for (const [path, bytes] of pins) expect(await readPin(path)).toEqual(bytes);
  });

  it('preserves accepted stages and native bytes when the authenticated source changes during a quota wait', async () => {
    const input = fixture(); const f = await publicLoopback(input); cleanups.push(f.cleanup);
    f.addSource(emptySource(input.transfer, 2, true));
    let armed = false, postsWhenChanged = -1;
    const time = clock(() => {
      if (!armed) return;
      postsWhenChanged = f.calls.filter(call => call.method === 'POST').length;
      f.change(body => { if (body.meta?.actor_user_id) body.meta.actor_user_id = uuid(9999); return body; });
    });
    const lines: string[] = [];
    const deps = { cwd: f.repo, env: f.env, rclVersion: 'test', requestClock: time,
      stdout: (line: string) => lines.push(line), stderr: () => {} };
    expect(await runPublicClaimRecovery({ preview: true, manifest: f.manifest, selection: f.selectionPath }, deps)).toBe(0);
    const before = await readFile(f.statePath); const manifest = await readFile(f.manifest);
    armed = true;
    expect(await runPublicClaimRecovery({ apply: true, manifest: f.manifest, manifestSha256: sha(manifest.toString()) }, deps)).toBe(4);
    expect(postsWhenChanged).toBeGreaterThan(0);
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(postsWhenChanged);
    expect(await readFile(f.statePath)).toEqual(before);
    expect(await readFile(f.manifest)).toEqual(manifest);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: 'refused', reason: 'claim_history_unanswered' });
  });

  it.each([2, 3])('completes four durable stages across the unchanged quota with %i same-target sources', async sources => {
    const input = fixture();
    const f = await publicLoopback(input);
    cleanups.push(f.cleanup);
    f.addSource(emptySource(input.transfer, 2, true));
    if (sources === 3) f.addSource(emptySource(input.transfer, 3));
    // A larger complete index must be paged and fetched, never skipped to save quota.
    if (sources === 3) for (let i = 0; i < 55; i++) f.addReceipt({
      ...input.originalVerdict, id: uuid(3000 + i),
      payload: { verdicts: [{ identity_key: '9999999999999999', verdict: 'dismissed', severity: 'minor', reason: 'Unrelated retained observation.' }] },
    });
    const time = clock();
    let starts: number[] = [], rejected = 0;
    const requested: Array<{ method: string; at: number }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const at = time.now();
      starts = starts.filter(start => at - start < 60_000);
      requested.push({ method: init?.method ?? 'GET', at });
      if (starts.length >= 300) {
        rejected++;
        return Response.json({ error: 'rate_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '60' } });
      }
      starts.push(at);
      return fetch(url, init);
    };
    const execute = async (mode: 'preview' | 'apply' | 'resume') => {
      const lines: string[] = [];
      const deps = { cwd: f.repo, env: f.env, rclVersion: 'test', fetchImpl, requestClock: time,
        stdout: (line: string) => lines.push(line), stderr: () => {} } as PublicClaimRecoveryDeps;
      const exit = await runPublicClaimRecovery({ [mode]: true, manifest: f.manifest,
        ...(mode === 'preview' ? { selection: f.selectionPath } : { manifestSha256: sha(await readFile(f.manifest, 'utf8')) }) }, deps);
      return { exit, output: JSON.parse(lines.at(-1)!) };
    };
    expect(await execute('preview')).toMatchObject({ exit: 0, output: { status: 'prepared' } });
    // Simulate a genuinely quiet API bucket before the isolated full apply.
    await time.sleep(61_000); requested.length = 0;
    const before = await readFile(f.statePath);
    const applied = await execute('apply');
    expect(applied, JSON.stringify({ applied, requests: requested.length, rejected, posts: requested.filter(r => r.method === 'POST').length })).toMatchObject({ exit: 0, output: { status: 'acknowledged' } });
    expect(applied.output.receipt_ids).toHaveLength(4);
    expect(requested.filter(request => request.method === 'POST')).toHaveLength(4);
    expect(requested.length).toBeGreaterThan(300);
    expect(rejected).toBe(0);
    expect(time.waits.filter(ms => ms > 0).length).toBeGreaterThan(1);
    for (const request of requested) expect(requested.filter(other => other.at > request.at - 60_000 && other.at <= request.at).length).toBeLessThanOrEqual(300);
    const after = await readFile(f.statePath);
    expect(after).not.toEqual(before);
    const native = JSON.parse(after.toString());
    expect(native.version).toBe(3);
    expect(native.rounds).toEqual(JSON.parse(before.toString()).rounds);
    await time.sleep(61_000); requested.length = 0;
    expect(await execute('resume')).toMatchObject({ exit: 0, output: { status: 'acknowledged' } });
    expect(requested.filter(request => request.method === 'POST')).toEqual([]);
    expect(await readFile(f.statePath)).toEqual(after);
    if (sources === 3) expect(f.calls.some(call => new URL(call.path, 'http://localhost').searchParams.get('after_sequence') === '50')).toBe(true);
  });
});
