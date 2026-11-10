import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { createReviewCycleRemote, ReviewCycleRejected, type LivePullRequestReader } from '../../src/converge/cycle-remote.js';
import { fakeFetch } from '../telemetry/fixtures.js';
const head = 'a'.repeat(40);
const request = { operation_id: randomUUID(), previous_cycle_id: null, head_sha: head };
const receipt = { ...request, id: randomUUID(), inserted_at: new Date().toISOString() };
function fixture(handler: Parameters<typeof fakeFetch>[0], requestedHead = head,
  readLivePr: LivePullRequestReader = vi.fn(async () => ({ headSha: requestedHead, merged: false, state: 'open' }))) {
  const transport = fakeFetch(handler);
  const sink = new HarnessSink({ credential: { url: 'https://harness.example', token: 'fixture', source: 'login' }, rclVersion: '4.1.9', fetchImpl: transport.fetch });
  return { remote: createReviewCycleRemote(sink, 'Allocator-One/RCL', 42, requestedHead, readLivePr), readLivePr, ...transport };
}
it('requires scoped capability and exact current head before accepting active membership', async () => {
  const { remote, requests } = fixture(() => ({ status: 200, body: { data: { repo: 'allocator-one/rcl', pr_number: 42,
    cycle_protocol: 1, active_cycle: receipt, head: { sha: head, merged: false } } } }));
  expect(await remote.current()).toEqual(receipt);
  expect(requests[0].url).toBe('https://harness.example/api/v1/reviews/prs/allocator-one/rcl/42');
});
it('accepts a stale Harness status head and an older cycle when GitHub confirms the requested head', async () => {
  const requestedHead = 'c'.repeat(40);
  const priorCycle = { ...receipt, head_sha: 'b'.repeat(40) };
  const { remote, readLivePr } = fixture(() => ({ status: 200, body: { data: { repo: 'allocator-one/rcl', pr_number: 42,
    cycle_protocol: 1, active_cycle: priorCycle, head: { sha: head, merged: false } } } }), requestedHead);
  expect(await remote.current()).toEqual(priorCycle);
  expect(readLivePr).toHaveBeenCalledTimes(1);
});

it.each([
  { liveHead: 'b'.repeat(40), merged: false, state: 'open' },
  { liveHead: head, merged: true, state: 'closed' },
  { liveHead: head, merged: false, state: 'closed' },
])('refuses changed or merged live GitHub PR membership before returning the active cycle', async ({ liveHead, merged, state }) => {
  const { remote } = fixture(() => ({ status: 200, body: { data: { repo: 'allocator-one/rcl', pr_number: 42,
    cycle_protocol: 1, active_cycle: receipt, head: { sha: head, merged: false } } } }), head,
  vi.fn(async () => ({ headSha: liveHead, merged, state })));
  await expect(remote.current()).rejects.toThrow('fresh_review_head_changed');
});

it.each([
  () => { throw new Error('network failure'); },
  () => Promise.resolve({ headSha: '', merged: false }),
  () => Promise.resolve({ headSha: head, merged: false }),
])('fails closed when the GitHub PR lookup is unavailable or malformed', async readLivePr => {
  const { remote } = fixture(() => ({ status: 200, body: { data: { repo: 'allocator-one/rcl', pr_number: 42,
    cycle_protocol: 1, active_cycle: receipt, head: { sha: head, merged: false } } } }), head,
  readLivePr as () => Promise<{ headSha: string; merged: boolean; state: string }>);
  await expect(remote.current()).rejects.toThrow('fresh_review_github_unavailable');
});
it.each([
  { repo: 'other/rcl', pr_number: 42, cycle_protocol: 1 },
  { repo: 'allocator-one/rcl', pr_number: 43, cycle_protocol: 1 },
  { repo: 'allocator-one/rcl', pr_number: 42 },
])('rejects incompatible or differently scoped status', async scope => {
  const { remote } = fixture(() => ({ status: 200, body: { data: { ...scope, active_cycle: null, head: { sha: head, merged: false } } } }));
  await expect(remote.current()).rejects.toThrow('fresh_review_capability_unavailable');
});
it('posts the same operation receipt over the credential-bound transport', async () => {
  const { remote, requests } = fixture(() => ({ status: 201, body: { data: receipt } }));
  expect(await remote.start(request)).toEqual(receipt);
  expect(JSON.parse(requests[0].body!)).toEqual(request);
  expect(requests[0].headers.authorization).toBe('Bearer fixture');
});
it('distinguishes definite noncommit from an uncertain postcommit failure', async () => {
  const refused = fixture(() => ({ status: 409, body: { error: 'conflict', message: 'Fresh review refused: head_changed' } }));
  await expect(refused.remote.start(request)).rejects.toBeInstanceOf(ReviewCycleRejected);
  const uncertain = fixture(() => ({ status: 503, body: { error: 'unavailable' } }));
  await expect(uncertain.remote.start(request)).rejects.not.toBeInstanceOf(ReviewCycleRejected);
});

it('negotiates a first cycle before Harness has any cached head or review history', async () => {
  const { remote } = fixture(() => ({ status: 200, body: { data: { repo: 'allocator-one/rcl', pr_number: 42,
    cycle_protocol: 1, active_cycle: null, head: null } } }));
  expect(await remote.current()).toBeNull();
});

it.each(['./repo', '../repo', 'owner/.', 'owner/..'])('rejects URL dot segments in repository %s before transport', repo => {
  const { fetch, requests } = fakeFetch(() => ({ status: 500, body: {} }));
  const sink = new HarnessSink({ credential: { url: 'https://harness.example', token: 'fixture', source: 'login' }, rclVersion: '4.1.11', fetchImpl: fetch });
  expect(() => createReviewCycleRemote(sink, repo, 42, head, async () => ({ headSha: head, merged: false, state: 'open' }))).toThrow('fresh_review_requires_pr');
  expect(requests).toHaveLength(0);
});

const status = (active: unknown) => ({ status: 200, body: { data: { repo: 'allocator-one/rcl', pr_number: 42, cycle_protocol: 1, active_cycle: active } } });
it.each([
  ['an unknown repository', { status: 404, body: { error: 'not_found', message: 'Not found' } }, 'HTTP 404'],
  ['an invalid request', { status: 422, body: { error: 'unprocessable_entity', message: 'operation_id, previous_cycle_id and head_sha are required' } }, 'HTTP 422'],
  ['a disabled organization', { status: 403, body: { error: 'reviews_disabled', message: 'Reviews are disabled' } }, 'reviews_disabled'],
])('treats %s as a confirmed noncommit and keeps the server reason (RCL-193)', async (_label, refusal, reason) => {
  const { remote } = fixture(request => request.method === 'POST' ? refusal : status(null));
  const error = await remote.start(request).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ReviewCycleRejected);
  expect((error as Error).message).toContain(reason);
});
it('keeps a refusal uncertain when this operation already owns the active cycle', async () => {
  const { remote } = fixture(req => req.method === 'POST' ? { status: 404, body: { error: 'not_found', message: 'Not found' } } : status(receipt));
  const error = await remote.start(request).catch((caught: unknown) => caught);
  expect(error).not.toBeInstanceOf(ReviewCycleRejected);
  expect((error as Error).message).toMatch(/fresh_review_receipt_unavailable: rejected HTTP 404 not_found: Not found/);
});
it('keeps a refusal uncertain when the active cycle cannot be read back', async () => {
  const { remote } = fixture(req => req.method === 'POST' ? { status: 404, body: { error: 'not_found', message: 'Not found' } } : { status: 503, body: {} });
  await expect(remote.start(request)).rejects.toThrow(/fresh_review_receipt_unavailable: rejected HTTP 404/);
});
it('keeps a malformed success uncertain, since the cycle may exist', async () => {
  const { remote } = fixture(req => req.method === 'POST' ? { status: 201, body: { data: { unexpected: true } } } : status(null));
  const error = await remote.start(request).catch((caught: unknown) => caught);
  expect(error).not.toBeInstanceOf(ReviewCycleRejected);
  expect((error as Error).message).toContain('HTTP 201');
});
