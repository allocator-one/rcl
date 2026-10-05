import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { resolvePRCapacity } from '../../src/resolver/pr-capacity-authority.js';

const target = { owner: 'owner', repo: 'repo', number: 7 };
const headSha = 'a'.repeat(40);
const name = `rcl-cap/${headSha}`;
const label = { name, description: 'chunks=128;calls=2048' };
const event = {
  id: 10, event: 'labeled', created_at: '2026-10-05T12:00:00Z',
  label: { name }, actor: { login: 'maintainer', id: 42 },
};

function fixture() {
  const pr = { head: { sha: headSha }, labels: [label] };
  const get = vi.fn().mockResolvedValue({ data: pr });
  const events = vi.fn().mockResolvedValue([event]);
  const iterator = vi.fn(async function* () { yield { data: await events() }; });
  const paginate = Object.assign(vi.fn(), { iterator });
  const permission = vi.fn().mockResolvedValue({ data: {
    permission: 'write', role_name: 'maintain', user: { login: 'maintainer', id: 42 },
  } });
  const auth = vi.fn().mockResolvedValue({ type: 'token', token: 'fixture-token' });
  const octokit = {
    auth, pulls: { get }, issues: { listEvents: vi.fn() }, paginate,
    repos: { getCollaboratorPermissionLevel: permission },
  } as unknown as Octokit;
  return { octokit, get, events, iterator, paginate, permission, auth, pr };
}

describe('resolvePRCapacity', () => {
  it('leaves an unlabelled PR at default capacity without authorization lookups', async () => {
    const f = fixture();
    f.get.mockResolvedValue({ data: { ...f.pr, labels: [{ name: 'bug' }] } });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).resolves.toBeUndefined();
    expect(f.auth).not.toHaveBeenCalled();
    expect(f.iterator).not.toHaveBeenCalled();
    expect(f.paginate).not.toHaveBeenCalled();
    expect(f.permission).not.toHaveBeenCalled();
  });

  it.each(['write', 'maintain', 'admin'])('accepts an exact-head allocation approved by %s', async permission => {
    const f = fixture();
    f.permission.mockResolvedValue({ data: { permission, user: { login: 'maintainer', id: 42 } } });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).resolves.toEqual({
      maxReviewChunks: 128, maxBlockingCalls: 2048, headSha,
    });
    expect(f.permission).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', username: 'maintainer' });
    expect(f.iterator).toHaveBeenCalledWith(f.octokit.issues.listEvents, {
      owner: 'owner', repo: 'repo', issue_number: 7, per_page: 100,
    });
    expect(f.get).toHaveBeenCalledTimes(2);
  });

  it.each(['chunks=1;calls=1', 'chunks=512;calls=8192'])('accepts the inclusive bounds %s', async description => {
    const f = fixture();
    f.get.mockResolvedValue({ data: { ...f.pr, labels: [{ ...label, description }] } });
    const [chunks, calls] = description.match(/\d+/g)!.map(Number);
    await expect(resolvePRCapacity(target, undefined, f.octokit)).resolves.toEqual({
      maxReviewChunks: chunks, maxBlockingCalls: calls, headSha,
    });
  });

  it.each([
    'chunks=513;calls=8192', 'chunks=512;calls=8193', 'chunks=0;calls=1',
    'chunks=1;calls=0', 'chunks=-1;calls=1', 'chunks=1.5;calls=1',
    'chunks=1e2;calls=1', 'chunks=01;calls=1', 'chunks=1;calls=2;extra=3',
    'calls=2;chunks=1', 'chunks=1;calls=2\n', null,
  ])('refuses malformed or excessive limits: %s', async description => {
    const f = fixture();
    f.get.mockResolvedValue({ data: { ...f.pr, labels: [{ ...label, description }] } });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/capacity/i);
    expect(f.permission).not.toHaveBeenCalled();
  });

  it.each([
    `rcl-cap/${'b'.repeat(40)}`, 'rcl-cap/short', 'rcl-cap', `RCL-CAP/${headSha}`,
  ])('refuses stale or malformed capacity labels: %s', async invalidName => {
    const f = fixture();
    f.get.mockResolvedValue({ data: { ...f.pr, labels: [{ ...label, name: invalidName }] } });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/capacity/i);
  });

  it('refuses multiple capacity labels even when one is valid', async () => {
    const f = fixture();
    f.get.mockResolvedValue({ data: { ...f.pr, labels: [label, { ...label, name: `rcl-cap/${'b'.repeat(40)}` }] } });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/ambiguous/i);
  });

  it.each(['read', 'triage', 'none', undefined])('refuses insufficient current permission: %s', async permission => {
    const f = fixture();
    f.permission.mockResolvedValue({ data: { permission, role_name: 'admin', user: { login: 'maintainer', id: 42 } } });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/permission/i);
  });

  it('requires authenticated metadata for capacity authorization', async () => {
    const f = fixture();
    f.auth.mockResolvedValue({ type: 'unauthenticated' });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/authenticated/i);
    expect(f.permission).not.toHaveBeenCalled();
  });

  it('checks the latest application actor, regardless of API event order', async () => {
    const f = fixture();
    f.events.mockResolvedValue([
      { ...event, id: 12, created_at: '2026-10-05T12:02:00Z', actor: { login: 'outsider', id: 43 } },
      event,
      { ...event, id: 11, created_at: '2026-10-05T12:01:00Z', event: 'unlabeled' },
    ]);
    f.permission.mockResolvedValue({ data: { permission: 'read', user: { login: 'outsider', id: 43 } } });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/permission/i);
    expect(f.permission).toHaveBeenCalledWith(expect.objectContaining({ username: 'outsider' }));
  });

  it.each([
    [], [{ ...event, event: 'unlabeled' }], [{ ...event, actor: null }],
    [event, { ...event, actor: { login: 'other', id: 43 } }],
    [{ ...event, created_at: 'invalid' }],
  ].map(events => ({ events })))('refuses absent, removed, unattributed or ambiguous label history %#', async ({ events }) => {
    const f = fixture();
    f.events.mockResolvedValue(events);
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/capacity/i);
    expect(f.iterator).toHaveBeenCalled();
    expect(f.permission).not.toHaveBeenCalled();
  });

  it('refuses a mismatched actor returned by the permission endpoint', async () => {
    const f = fixture();
    f.permission.mockResolvedValue({ data: { permission: 'admin', user: { login: 'maintainer', id: 99 } } });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/permission/i);
  });

  it.each(['head', 'removal', 'description'])('refuses a changed PR %s during authorization', async change => {
    const f = fixture();
    const changed = change === 'head' ? { ...f.pr, head: { sha: 'b'.repeat(40) } }
      : { ...f.pr, labels: change === 'removal' ? [] : [{ ...label, description: 'chunks=512;calls=8192' }] };
    f.get.mockResolvedValueOnce({ data: f.pr }).mockResolvedValueOnce({ data: changed });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/capacity/i);
  });

  it('refuses removal and reapplication during authorization even with unchanged PR labels', async () => {
    const f = fixture();
    f.events.mockResolvedValueOnce([event]).mockResolvedValueOnce([
      event,
      { ...event, id: 11, created_at: '2026-10-05T12:01:00Z', event: 'unlabeled' },
      { ...event, id: 12, created_at: '2026-10-05T12:02:00Z' },
    ]);
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/changed/i);
  });

  it.each(['initial', 'recheck'] as const)('bounds requests and refuses incomplete history during the %s scan', async phase => {
    const f = fixture(), readPage = vi.fn();
    let scans = 0;
    const iterator = vi.fn(async function* () {
      scans += 1;
      if (phase === 'recheck' && scans === 1) {
        yield { data: [event] };
        return;
      }
      // Even an attributable grant in the prefix cannot authorize while a
      // later removal or reapplication might exist beyond the scan budget.
      for (let page = 0; page < 30; page++) {
        readPage(page);
        yield { data: Array.from({ length: 100 }, (_, index) => page === 0 && index === 0
          ? event : { id: 1000 + page * 100 + index, event: 'commented' }) };
      }
    });
    Object.assign(f.octokit.paginate, { iterator });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/history.*limit/i);
    expect(readPage).toHaveBeenCalledTimes(11);
    expect(f.paginate).not.toHaveBeenCalled(); // Never collect the full history.
    expect(f.permission).toHaveBeenCalledTimes(phase === 'initial' ? 0 : 1);
    expect(f.get).toHaveBeenCalledTimes(1);
  });

  it('accepts complete history at the page limit and orders same-second transitions across pages', async () => {
    const f = fixture(), readPage = vi.fn();
    const latest = { ...event, id: 12, actor: { login: 'new-maintainer', id: 43 } };
    f.permission.mockResolvedValue({ data: { permission: 'write', user: latest.actor } });
    f.iterator.mockImplementation(async function* () {
      for (let page = 0; page < 10; page++) {
        readPage(page);
        yield { data: Array.from({ length: 100 }, (_, index) => index !== 0
          ? { id: 1000 + page * 100 + index, event: 'commented' }
          : page === 0 ? event : page === 5 ? { ...event, id: 11, event: 'unlabeled' }
          : page === 9 ? latest : { id: 1000 + page * 100, event: 'commented' }) };
      }
    });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).resolves.toEqual({
      maxReviewChunks: 128, maxBlockingCalls: 2048, headSha,
    });
    expect(readPage).toHaveBeenCalledTimes(20);
    expect(f.paginate).not.toHaveBeenCalled();
    expect(f.permission).toHaveBeenCalledWith(expect.objectContaining({ username: 'new-maintainer' }));
  });

  it('refuses duplicate capacity transitions across pages before permission lookup', async () => {
    const f = fixture();
    f.iterator.mockImplementation(async function* () {
      yield { data: [event] };
      yield { data: [event] };
    });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/ambiguous/i);
    expect(f.permission).not.toHaveBeenCalled();
  });

  it.each(['get', 'auth', 'events', 'permission'] as const)('fails closed and sanitizes %s errors', async method => {
    const f = fixture();
    f[method].mockRejectedValue(new Error('secret-fixture-token'));
    const error = await resolvePRCapacity(target, undefined, f.octokit).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/capacity/i);
    expect(error.message).not.toContain('secret-fixture-token');
    expect(error.cause).toBeUndefined();
  });
});
