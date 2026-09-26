import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { createReviewCycleRemote, ReviewCycleRejected } from '../../src/converge/cycle-remote.js';
import { fakeFetch } from '../telemetry/fixtures.js';
const head = 'a'.repeat(40);
const request = { operation_id: randomUUID(), previous_cycle_id: null, head_sha: head };
const receipt = { ...request, id: randomUUID(), inserted_at: new Date().toISOString() };
function fixture(handler: Parameters<typeof fakeFetch>[0]) {
  const transport = fakeFetch(handler);
  const sink = new HarnessSink({ credential: { url: 'https://harness.example', token: 'fixture', source: 'login' }, rclVersion: '4.1.9', fetchImpl: transport.fetch });
  return { remote: createReviewCycleRemote(sink, 'Allocator-One/RCL', 42, head), ...transport };
}
it('requires scoped capability and exact current head before accepting active membership', async () => {
  const { remote, requests } = fixture(() => ({ status: 200, body: { data: { repo: 'allocator-one/rcl', pr_number: 42,
    cycle_protocol: 1, active_cycle: receipt, head: { sha: head, merged: false } } } }));
  expect(await remote.current()).toEqual(receipt);
  expect(requests[0].url).toBe('https://harness.example/api/v1/reviews/prs/allocator-one/rcl/42');
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
  expect(() => createReviewCycleRemote(sink, repo, 42, head)).toThrow('fresh_review_requires_pr');
  expect(requests).toHaveLength(0);
});
