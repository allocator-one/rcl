import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { assertAttestedCapacityGrant, resolvePRCapacity } from '../../src/resolver/pr-capacity-authority.js';

const target = { owner: 'owner', repo: 'repo', number: 7 };
const headSha = 'a'.repeat(40);
const headName = `rcl-cap/${headSha}`;
const chunksName = 'rcl-cap-chunks/128';
const callsName = 'rcl-cap-calls/2048';
// The limits live in the label names; a description is repository-level and
// editable after the application, so it is deliberately meaningless here.
const labels = [{ name: headName }, { name: chunksName }, { name: callsName }];
const applied = (id: number, name: string, actor = { login: 'maintainer', id: 42 }, extra: object = {}) => ({
  id, event: 'labeled', created_at: `2026-10-05T12:00:${String(id).padStart(2, '0')}Z`,
  label: { name }, actor, ...extra,
});
const events = [applied(10, headName), applied(11, chunksName), applied(12, callsName)];
const removed = (id: number, name: string, actor = { login: 'maintainer', id: 42 }) =>
  ({ ...applied(id, name, actor), event: 'unlabeled' });

function fixture() {
  const pr = { head: { sha: headSha }, labels };
  const get = vi.fn().mockResolvedValue({ data: pr });
  const history = vi.fn().mockResolvedValue(events);
  const iterator = vi.fn(async function* () { yield { data: await history() }; });
  const paginate = Object.assign(vi.fn(), { iterator });
  const permission = vi.fn().mockResolvedValue({ data: {
    permission: 'write', role_name: 'maintain', user: { login: 'maintainer', id: 42 },
  } });
  const auth = vi.fn().mockResolvedValue({ type: 'token', token: 'fixture-token' });
  const octokit = {
    auth, pulls: { get }, issues: { listEvents: vi.fn() }, paginate,
    repos: { getCollaboratorPermissionLevel: permission },
  } as unknown as Octokit;
  return { octokit, get, history, iterator, paginate, permission, auth, pr };
}
/** Permission lookup that knows each actor's own level. */
function permissionsBy(f: ReturnType<typeof fixture>, levels: Record<string, [number, string]>) {
  f.permission.mockImplementation(async ({ username }: { username: string }) => ({
    data: { permission: levels[username]![1], user: { login: username, id: levels[username]![0] } },
  }));
}
const withLabels = (f: ReturnType<typeof fixture>, names: string[]) =>
  f.get.mockResolvedValue({ data: { ...f.pr, labels: names.map(name => ({ name })) } });

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

  it.each([[1, 1], [512, 8192]])('accepts the inclusive bounds chunks=%i calls=%i', async (chunks, calls) => {
    const f = fixture();
    const names = [headName, `rcl-cap-chunks/${chunks}`, `rcl-cap-calls/${calls}`];
    withLabels(f, names);
    f.history.mockResolvedValue(names.map((name, index) => applied(10 + index, name)));
    await expect(resolvePRCapacity(target, undefined, f.octokit)).resolves.toEqual({
      maxReviewChunks: chunks, maxBlockingCalls: calls, headSha,
    });
  });

  it.each([
    ['rcl-cap-chunks/513', callsName], ['rcl-cap-chunks/0', callsName], ['rcl-cap-chunks/-1', callsName],
    ['rcl-cap-chunks/1.5', callsName], ['rcl-cap-chunks/1e2', callsName], ['rcl-cap-chunks/01', callsName],
    ['rcl-cap-chunks/', callsName], ['rcl-cap-chunks/64;calls=2', callsName],
    [chunksName, 'rcl-cap-calls/8193'], [chunksName, 'rcl-cap-calls/0'], [chunksName, 'rcl-cap-calls/00'],
    ['RCL-CAP-CHUNKS/128', callsName],
  ])('refuses malformed or excessive limits: %s %s', async (chunks, calls) => {
    const f = fixture();
    withLabels(f, [headName, chunks, calls]);
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/capacity/i);
    expect(f.permission).not.toHaveBeenCalled();
  });

  it('takes the limits from the label names and ignores any description', async () => {
    const f = fixture();
    f.get.mockResolvedValue({ data: { ...f.pr, labels: labels.map(entry => ({
      ...entry, description: 'chunks=512;calls=8192' })) } });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).resolves.toEqual({
      maxReviewChunks: 128, maxBlockingCalls: 2048, headSha,
    });
  });

  it('still authorizes when a description is edited during authorization', async () => {
    const f = fixture();
    const edited = { ...f.pr, labels: labels.map(entry => ({ ...entry, description: 'chunks=512;calls=8192' })) };
    f.get.mockResolvedValueOnce({ data: f.pr }).mockResolvedValueOnce({ data: edited });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).resolves.toMatchObject({
      maxReviewChunks: 128, maxBlockingCalls: 2048,
    });
  });

  it.each([
    ['a stale head label', [`rcl-cap/${'b'.repeat(40)}`, chunksName, callsName]],
    ['a short head label', ['rcl-cap/short', chunksName, callsName]],
    ['an upper-case head label', [`RCL-CAP/${headSha}`, chunksName, callsName]],
    ['a bare marker', ['rcl-cap', chunksName, callsName]],
    ['no chunks label', [headName, callsName]],
    ['no calls label', [headName, chunksName]],
    ['no head label', [chunksName, callsName]],
    ['only the head label', [headName]],
  ])('refuses %s', async (_, names) => {
    const f = fixture();
    withLabels(f, names);
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/capacity/i);
    expect(f.permission).not.toHaveBeenCalled();
  });

  it.each([
    ['head labels', [headName, `rcl-cap/${'b'.repeat(40)}`, chunksName, callsName]],
    ['chunks labels', [headName, chunksName, 'rcl-cap-chunks/512', callsName]],
    ['calls labels', [headName, chunksName, callsName, 'rcl-cap-calls/8192']],
  ])('refuses multiple %s even when one is valid', async (_, names) => {
    const f = fixture();
    withLabels(f, names);
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/ambiguous/i);
  });

  it.each(['read', 'triage', 'none', undefined])('refuses insufficient current permission: %s', async permission => {
    const f = fixture();
    f.permission.mockResolvedValue({ data: { permission, role_name: 'admin', user: { login: 'maintainer', id: 42 } } });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/permission/i);
  });

  it.each([headName, chunksName, callsName])(
    'refuses a grant whose %s was applied by an actor without write permission', async name => {
      const f = fixture();
      f.history.mockResolvedValue(events.map(entry =>
        entry.label.name === name ? { ...entry, actor: { login: 'triager', id: 77 } } : entry));
      permissionsBy(f, { maintainer: [42, 'write'], triager: [77, 'triage'] });
      await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/permission/i);
      expect(f.permission).toHaveBeenCalledWith(expect.objectContaining({ username: 'triager' }));
    });

  it('refuses a limit raised by a user without write permission after a maintainer applied a smaller one', async () => {
    const f = fixture();
    const raised = ['rcl-cap-chunks/512'];
    withLabels(f, [headName, ...raised, callsName]);
    f.history.mockResolvedValue([
      applied(10, headName), applied(11, chunksName), applied(12, callsName),
      removed(13, chunksName, { login: 'triager', id: 77 }),
      applied(14, raised[0]!, { login: 'triager', id: 77 }),
    ]);
    permissionsBy(f, { maintainer: [42, 'write'], triager: [77, 'triage'] });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/permission/i);
  });

  it('accepts limits applied by different actors when each has write permission', async () => {
    const f = fixture();
    f.history.mockResolvedValue([
      applied(10, headName), applied(11, chunksName, { login: 'maintainer-2', id: 43 }), applied(12, callsName),
    ]);
    permissionsBy(f, { maintainer: [42, 'write'], 'maintainer-2': [43, 'admin'] });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).resolves.toMatchObject({ maxReviewChunks: 128 });
    expect(f.permission).toHaveBeenCalledTimes(2);
  });

  it('requires authenticated metadata for capacity authorization', async () => {
    const f = fixture();
    f.auth.mockResolvedValue({ type: 'unauthenticated' });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/authenticated/i);
    expect(f.permission).not.toHaveBeenCalled();
  });

  it('checks the latest application actor of each label, regardless of API event order', async () => {
    const f = fixture();
    f.history.mockResolvedValue([
      applied(22, callsName, { login: 'outsider', id: 43 }),
      ...events,
      removed(21, callsName),
    ]);
    permissionsBy(f, { maintainer: [42, 'write'], outsider: [43, 'read'] });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/permission/i);
    expect(f.permission).toHaveBeenCalledWith(expect.objectContaining({ username: 'outsider' }));
  });

  it.each([
    ['no history', []],
    ['a removed head label', [...events, removed(20, headName)]],
    ['a removed chunks label', [...events, removed(20, chunksName)]],
    ['a removed calls label', [...events, removed(20, callsName)]],
    ['an unattributed application', [events[0], events[1], { ...events[2], actor: null }]],
    ['a chunks label with no application', [events[0], events[2]]],
    ['an ambiguous same-label application', [...events, applied(10, chunksName, { login: 'other', id: 43 })]],
    ['an invalid timestamp', [events[0], events[1], { ...events[2], created_at: 'invalid' }]],
  ])('refuses absent, removed, unattributed or ambiguous label history: %s', async (_, history) => {
    const f = fixture();
    f.history.mockResolvedValue(history);
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/capacity/i);
    expect(f.iterator).toHaveBeenCalled();
    expect(f.permission).not.toHaveBeenCalled();
  });

  it('refuses a mismatched actor returned by the permission endpoint', async () => {
    const f = fixture();
    f.permission.mockResolvedValue({ data: { permission: 'admin', user: { login: 'maintainer', id: 99 } } });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/permission/i);
  });

  it.each([
    ['head', { head: { sha: 'b'.repeat(40) } }],
    ['head label removal', { labels: [{ name: chunksName }, { name: callsName }] }],
    ['chunks label removal', { labels: [{ name: headName }, { name: callsName }] }],
    ['chunks label replacement', { labels: [{ name: headName }, { name: 'rcl-cap-chunks/512' }, { name: callsName }] }],
    ['calls label replacement', { labels: [{ name: headName }, { name: chunksName }, { name: 'rcl-cap-calls/8192' }] }],
  ])('refuses a changed PR %s during authorization', async (_, change) => {
    const f = fixture();
    f.get.mockResolvedValueOnce({ data: f.pr }).mockResolvedValueOnce({ data: { ...f.pr, ...change } });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/capacity/i);
  });

  it.each([headName, chunksName, callsName])(
    'refuses removal and reapplication of %s during authorization even with unchanged PR labels', async name => {
      const f = fixture();
      f.history.mockResolvedValueOnce(events).mockResolvedValueOnce([
        ...events, removed(30, name), applied(31, name),
      ]);
      await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/changed/i);
    });

  it('refuses an unauthorized limit reapplication visible in the final PR read', async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce({ data: f.pr }).mockImplementationOnce(async () => {
      // The label is removed and reapplied while the final PR read is in flight.
      // Its name and limits remain unchanged, but its original approval is gone.
      f.history.mockResolvedValue([
        ...events, removed(30, chunksName), applied(31, chunksName, { login: 'outsider', id: 43 }),
      ]);
      return { data: f.pr };
    });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/changed/i);
  });

  it.each(['initial', 'recheck'] as const)('bounds requests and refuses incomplete history during the %s scan', async phase => {
    const f = fixture(), readPage = vi.fn();
    let scans = 0;
    const iterator = vi.fn(async function* () {
      scans += 1;
      if (phase === 'recheck' && scans === 1) {
        yield { data: events };
        return;
      }
      // Even attributable grants in the prefix cannot authorize while a later
      // removal or reapplication might exist beyond the scan budget.
      for (let page = 0; page < 30; page++) {
        readPage(page);
        yield { data: Array.from({ length: 100 }, (_, index) => page === 0 && index < 3
          ? events[index] : { id: 1000 + page * 100 + index, event: 'commented' }) };
      }
    });
    Object.assign(f.octokit.paginate, { iterator });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/history.*limit/i);
    expect(readPage).toHaveBeenCalledTimes(11);
    expect(f.paginate).not.toHaveBeenCalled(); // Never collect the full history.
    expect(f.permission).toHaveBeenCalledTimes(phase === 'initial' ? 0 : 1);
    expect(f.get).toHaveBeenCalledTimes(phase === 'initial' ? 1 : 2);
  });

  it('accepts complete history at the page limit and orders same-second transitions across pages', async () => {
    const f = fixture(), readPage = vi.fn();
    const latest = { ...events[1]!, id: 99, created_at: events[1]!.created_at, actor: { login: 'new-maintainer', id: 43 } };
    permissionsBy(f, { maintainer: [42, 'write'], 'new-maintainer': [43, 'write'] });
    f.iterator.mockImplementation(async function* () {
      for (let page = 0; page < 10; page++) {
        readPage(page);
        yield { data: Array.from({ length: 100 }, (_, index) => index !== 0
          ? { id: 1000 + page * 100 + index, event: 'commented' }
          : page === 0 ? events[0] : page === 1 ? events[2] : page === 2 ? events[1]
          : page === 5 ? { ...removed(98, chunksName), created_at: events[1]!.created_at }
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
      yield { data: events };
      yield { data: [events[0]] };
    });
    await expect(resolvePRCapacity(target, undefined, f.octokit)).rejects.toThrow(/ambiguous/i);
    expect(f.permission).not.toHaveBeenCalled();
  });

  it.each(['get', 'auth', 'history', 'permission'] as const)('fails closed and sanitizes %s errors', async method => {
    const f = fixture();
    f[method].mockRejectedValue(new Error('secret-fixture-token'));
    const error = await resolvePRCapacity(target, undefined, f.octokit).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/capacity/i);
    expect(error.message).not.toContain('secret-fixture-token');
    expect(error.cause).toBeUndefined();
  });
});

describe('assertAttestedCapacityGrant', () => {
  const grant = { maxReviewChunks: 128, maxBlockingCalls: 2048 } as Parameters<typeof assertAttestedCapacityGrant>[1];

  it.each([
    { maxReviewChunks: '64' },
    { maxBlockingCalls: '200' },
  ])('refuses an explicit capacity flag in an attested review that holds no grant: %j', (flags) => {
    expect(() => assertAttestedCapacityGrant(flags, undefined)).toThrow(/authorized exact-head PR capacity/);
  });

  it('allows an attested review without capacity flags or with the granted values', () => {
    expect(() => assertAttestedCapacityGrant({}, undefined)).not.toThrow();
    expect(() => assertAttestedCapacityGrant({ maxReviewChunks: '128', maxBlockingCalls: '2048' }, grant)).not.toThrow();
  });

  it('refuses a flag that differs from the grant', () => {
    expect(() => assertAttestedCapacityGrant({ maxReviewChunks: '129' }, grant)).toThrow(/conflicts/);
    expect(() => assertAttestedCapacityGrant({ maxBlockingCalls: '1' }, grant)).toThrow(/conflicts/);
  });
});
