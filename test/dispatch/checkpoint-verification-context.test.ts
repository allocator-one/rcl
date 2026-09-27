import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointJournal, exportCheckpointProof, freezeCheckpointPlan, type CheckpointProof } from '../../src/dispatch/checkpoint.js';
import { createOriginalLaunch, encodeOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { createRecoveryOperation, encodeRecoveryOperation } from '../../src/dispatch/recovery-operation.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { verificationContextForCheckpointProof, verificationContextFromValidatedCheckpoint } from '../../src/dispatch/checkpoint-verification-context.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const roots: string[] = [], target = 'allocator-one/rcl#105', runId = '11111111-1111-4111-8111-111111111111';
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function proof(kind: 'launch' | 'operation' | 'missing' | 'bad-launch' | 'bad-operation' = 'launch'): Promise<CheckpointProof> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vctx-'))); roots.push(dir);
  const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: 'c'.repeat(64), configSha256: 'd'.repeat(64), specSha256: 'e'.repeat(64), contextSha256: 'f'.repeat(64), toolsSha256: '0'.repeat(64), parser: { name: 'findings-json', version: 1 }, roster: [{ seat: 's0', model: 'm', role: 'r', route: 'fake' }], chunks: [{ index: 0, total: 1, digest: '1'.repeat(64) }], prompts: [{ seat: 's0', chunk: 0, systemSha256: '2'.repeat(64), userSha256: '3'.repeat(64) }] });
  return withNativeTarget(dir, target, async owner => {
    const journal = await CheckpointJournal.create({ commonDir: dir, namespace: `v${roots.length}`, plan, ownership: owner });
    const capture = 'captured bytes';
    await journal.bind('captured-inputs', capture, owner);
    if (kind === 'launch' || kind === 'bad-launch') await journal.bind('launch', encodeOriginalLaunch(createOriginalLaunch({ runId, target, originalNativeClaim: { attempt: 1, round: 1 }, capturedInputsSha256: hash(capture), planDigest: kind === 'bad-launch' ? '9'.repeat(64) : plan.digest, startedAtMs: 100, expiresAtMs: 900, maxPhysicalCalls: 3, maxAttemptsPerCell: 2 })), owner);
    else if (kind !== 'missing') await journal.bind('operation', encodeRecoveryOperation(createRecoveryOperation({ operationId: '22222222-2222-4222-8222-222222222222', successorRunId: runId, sourceRunId: '33333333-3333-4333-8333-333333333333', sourceReportSha256: '4'.repeat(64), sourceCheckpointSha256: '5'.repeat(64), capturedInputsSha256: hash(capture), planDigest: plan.digest, target, originalNativeClaim: { attempt: 1, round: 1 }, ...(kind === 'bad-operation' ? {} : { successorNativeClaim: { attempt: 2, round: 1 } }), startedAtMs: 120, expiresAtMs: 800, maxAdditionalCalls: 2, maxAttemptsPerCell: 2 })), owner);
    await journal.recordIntent('s0:0', { id: 'review-1', kind: 'paid' }, owner); await journal.finalize(owner); return exportCheckpointProof(journal);
  });
}
describe('verification context from proof', () => {
  it('derives original parent bindings only from a branded sealed proof', async () => { const p = await proof(); expect(verificationContextForCheckpointProof(p)).toMatchObject({ runId, startedAtMs: 100, expiresAtMs: 900, planDigest: p.plan.digest, finalizationDigest: p.state.records.at(-1)!.digest, reviewerAttemptIds: ['review-1'] }); });
  it('derives a successor parent with its claimed successor run', async () => { const p = await proof('operation'); expect(verificationContextForCheckpointProof(p)).toMatchObject({ runId, startedAtMs: 120, expiresAtMs: 800, reviewerAttemptIds: ['review-1'] }); });
  it('matches the validated-state helper for the same actual proof', async () => { const p = await proof(); expect(verificationContextFromValidatedCheckpoint(p.plan, { state: p.state, bindings: p.bindings })).toEqual(verificationContextForCheckpointProof(p)); });
  it('refuses arbitrary proof-shaped values before reading any fields', () => { expect(() => verificationContextForCheckpointProof({ state: { finalized: true } } as never)).toThrow('checkpoint_verification_unvalidated_proof'); });
  it.each(['missing', 'bad-launch', 'bad-operation'] as const)('refuses a branded proof whose parent binding is %s', async kind => { await expect(proof(kind).then(verificationContextForCheckpointProof)).rejects.toThrow(kind === 'missing' ? 'checkpoint_verification_missing_binding' : 'checkpoint_verification_binding_mismatch'); });
});
