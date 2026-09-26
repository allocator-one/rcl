import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { stableStringify } from '../../src/report/run-header.js';
import { snapshotVerificationEvent, validateVerificationRecords,
  type VerificationEvent } from '../../src/dispatch/checkpoint-verification.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const bindings = { planDigest: digest('plan'), finalizationDigest: digest('final'),
  capturedInputsSha256: digest('capture'), operationSha256: digest('operation') };
const context = { ...bindings, runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  startedAtMs: 100, expiresAtMs: 1000, reviewerAttemptIds: [] };
function plan(batchCount: number, shared = false) {
  const batch = { systemPrompt: 'system', userPrompt: 'user' };
  const batches = Array.from({ length: batchCount }, () => shared ? batch : { ...batch });
  const wire = { version: 1, findings: [], initialGating: [], candidateIndices: [], model: 'openai/verifier',
    verificationTimeoutMs: 100, verificationPassTimeoutMs: 600,
    batches: batches.map((row, index) => ({ ...row, findingIndices: [index] })) };
  return { runId: context.runId, gatingPlanBytes: stableStringify(wire), model: wire.model, provider: 'openai', batches,
    startedAtMs: 200, expiresAtMs: 800, verificationTimeoutMs: 100, verificationPassTimeoutMs: 600, maxPhysicalCalls: batchCount };
}
function history(batchCount: number, sharedBindings = false) {
  const events: VerificationEvent[] = [{ type: 'plan', plan: plan(batchCount) }];
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    events.push({ type: 'intent', intent: { batchIndex, attemptId: `verifier-${batchIndex}`, startedAtMs: 210 } });
    events.push({ type: 'result', result: { batchIndex, attemptId: `verifier-${batchIndex}`, finishedAtMs: 220,
      answerBytes: JSON.stringify({ model: 'openai/verifier', provider: 'openai', status: 'success', text: '[]', durationMs: 10 }) } });
  }
  events.push({ type: 'terminal', terminal: { status: 'complete', finishedAtMs: 230 } });
  let previousDigest = context.finalizationDigest;
  return events.map((event, index) => {
    const unsigned = { sequence: index + 1, previousDigest, bindings: sharedBindings ? bindings : { ...bindings }, event };
    const record = { ...unsigned, digest: digest(stableStringify(unsigned)) };
    previousDigest = record.digest;
    return record;
  });
}

describe('verification input bound compatibility', () => {
  it('accepts all 500 completed calls within the existing 1002-record limit', () => {
    const records = history(500);
    expect(records).toHaveLength(1002);
    const state = validateVerificationRecords(records, context)!;
    expect(state.outcomes).toHaveLength(500);
    expect(state.terminal).toEqual({ status: 'complete', finishedAtMs: 230 });
  });

  it('accepts repeated references to valid immutable bindings and prompt objects', () => {
    const records = history(2, true);
    expect(validateVerificationRecords(records, context)?.outcomes).toHaveLength(2);
    const input = { type: 'plan' as const, plan: plan(2, true) };
    expect(snapshotVerificationEvent(input)).toEqual(input);
  });

  it('rejects excessive record counts before expanding the input array', () => {
    expect(() => validateVerificationRecords(new Array(200_000), context)).toThrow('checkpoint_verification_too_many_records');
  });
});
