import { describe, expect, it } from 'vitest';
import { sha256Hex, stableStringify } from '../../src/report/run-header.js';
import { appendAsyncRecord, decodeAsyncProof, validateAsyncPlan, validateAsyncRecords,
  type AsyncEvent, type AsyncRecord } from '../../src/dispatch/checkpoint-async.js';
import { appendVerificationRecord, decodeVerificationProof, validateVerificationRecords,
  type VerificationEvent, type VerificationRecord } from '../../src/dispatch/checkpoint-verification.js';

const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const bindings = { planDigest: sha256Hex('plan'), finalizationDigest: sha256Hex('final'),
  capturedInputsSha256: sha256Hex('capture'), operationSha256: sha256Hex('operation') };
const context = { ...bindings, runId, startedAtMs: 100, expiresAtMs: 1000, reviewerAttemptIds: [] };
const asyncPlan = validateAsyncPlan({ version: 1, context: { runId, target: 'fixture#1',
  planDigest: bindings.planDigest, capturedInputsSha256: bindings.capturedInputsSha256, launchSha256: sha256Hex('launch'),
  startedAtMs: 100, expiresAtMs: 1000, reviewerReservedCalls: 1 },
  calls: [{ id: 'a:0', assignment: 'a', chunk: 0, chunkSha256: sha256Hex('chunk'), provider: 'fake', model: 'fake/model',
    role: 'general', systemPromptSha256: sha256Hex('system'), userPromptSha256: sha256Hex('user') }],
  maxPhysicalCalls: 1, maxAttemptsPerCall: 1, expiresAtMs: 1000 });
const reviewBytes = JSON.stringify({ model: 'fake/model', provider: 'fake', role: 'general', async: true,
  status: 'error', findings: [], durationMs: 0 });
const answerBytes = JSON.stringify({ model: 'fake/model', provider: 'fake', status: 'error', text: '', durationMs: 0 });
const attemptId = (index: number) => `async-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
function asyncHistory(count: number, plan = asyncPlan): AsyncRecord[] {
  const events: AsyncEvent[] = [];
  for (let index = 0; index < count; index++) {
    events.push({ type: 'intent', intent: { callIndex: 0, attemptId: attemptId(index), startedAtMs: 110 } },
      { type: 'not-dispatched', result: { callIndex: 0, attemptId: attemptId(index), finishedAtMs: 110,
        reviewBytes, reviewSha256: sha256Hex(reviewBytes) } });
  }
  let previousDigest = sha256Hex(stableStringify(plan));
  return events.map((event, index) => {
    const unsigned = { sequence: index + 1, previousDigest, event };
    const record = { ...unsigned, digest: sha256Hex(stableStringify(unsigned)) }; previousDigest = record.digest; return record;
  });
}
function retainAsyncRecord(records: readonly AsyncRecord[], event: AsyncEvent, plan = asyncPlan): AsyncRecord {
  const unsigned = { sequence: records.length + 1,
    previousDigest: records.at(-1)?.digest ?? sha256Hex(stableStringify(plan)), event };
  return { ...unsigned, digest: sha256Hex(stableStringify(unsigned)) };
}
function verificationHistory(count: number, batchCount = 1): VerificationRecord[] {
  const batches = Array.from({ length: batchCount }, (_, index) => ({ systemPrompt: 'system', userPrompt: 'user', findingIndices: [index] }));
  const gating = { version: 1, findings: [], initialGating: [], candidateIndices: [], model: 'fake/model',
    verificationTimeoutMs: 100, verificationPassTimeoutMs: 600,
    batches };
  const plan = { runId, gatingPlanBytes: stableStringify(gating), model: gating.model, provider: 'fake',
    batches: batches.map(({ systemPrompt, userPrompt }) => ({ systemPrompt, userPrompt })), startedAtMs: 200, expiresAtMs: 800,
    verificationTimeoutMs: 100, verificationPassTimeoutMs: 600, maxPhysicalCalls: batchCount };
  const events: VerificationEvent[] = [{ type: 'plan', plan }];
  for (let index = 0; index < count; index++) {
    events.push({ type: 'intent', intent: { batchIndex: 0, attemptId: `verifier-${index}`, startedAtMs: 210 } },
      { type: 'not-dispatched', result: { batchIndex: 0, attemptId: `verifier-${index}`, finishedAtMs: 210, answerBytes } });
  }
  let previousDigest = context.finalizationDigest;
  return events.map((event, index) => {
    const unsigned = { sequence: index + 1, previousDigest, bindings, event };
    const record = { ...unsigned, digest: sha256Hex(stableStringify(unsigned)) }; previousDigest = record.digest; return record;
  });
}
function retainVerificationRecord(records: readonly VerificationRecord[], event: VerificationEvent): VerificationRecord {
  const unsigned = { sequence: records.length + 1, previousDigest: records.at(-1)?.digest ?? context.finalizationDigest, bindings, event };
  return { ...unsigned, digest: sha256Hex(stableStringify(unsigned)) };
}

describe('non-dispatched structural capacity is separate from the paid budget', () => {
  it('replays a sealed legacy async prefix while refusing another intent and permitting resolution', () => {
    const calls = ['a', 'b', 'c'].map(assignment => ({ ...asyncPlan.calls[0]!, id: `${assignment}:0`, assignment }));
    const plan = validateAsyncPlan({ ...asyncPlan, calls, maxPhysicalCalls: 3, maxAttemptsPerCall: 1 });
    const records = asyncHistory(499, plan), firstId = attemptId(998), secondId = attemptId(999);
    records.push(retainAsyncRecord(records, { type: 'intent', intent: { callIndex: 0, attemptId: firstId, startedAtMs: 111 } }, plan));
    records.push(retainAsyncRecord(records, { type: 'intent', intent: { callIndex: 1, attemptId: secondId, startedAtMs: 112 } }, plan));
    expect(validateAsyncRecords(records, plan).uncertain).toHaveLength(2);
    expect(() => appendAsyncRecord(records, { type: 'intent', intent: { callIndex: 2, attemptId: attemptId(1000), startedAtMs: 113 } }, plan)).toThrow('intent_capacity');
    const sealed = [...records, retainAsyncRecord(records, { type: 'seal', cutoffMs: 113 }, plan)];
    expect(sealed).toHaveLength(1001);
    expect(decodeAsyncProof(stableStringify({ version: 1, plan, records: sealed }), plan.context).state.uncertain).toHaveLength(2);
    records.push(appendAsyncRecord(records, { type: 'result', result: { callIndex: 0, attemptId: firstId, finishedAtMs: 113,
      reviewBytes, reviewSha256: sha256Hex(reviewBytes), possiblyBilled: true } }, plan));
    records.push(appendAsyncRecord(records, { type: 'seal', cutoffMs: 113 }, plan));
    expect(decodeAsyncProof(stableStringify({ version: 1, plan, records }), plan.context).state.uncertain).toHaveLength(1);
  });

  it('refuses a 501st async non-start marker while permitting a paid result and seal', () => {
    const records = asyncHistory(500), id = attemptId(999);
    records.push(retainAsyncRecord(records, { type: 'intent', intent: { callIndex: 0, attemptId: id, startedAtMs: 111 } }));
    expect(validateAsyncRecords(records, asyncPlan).uncertain).toHaveLength(1);
    expect(() => appendAsyncRecord(records, { type: 'not-dispatched', result: { callIndex: 0, attemptId: id, finishedAtMs: 112,
      reviewBytes, reviewSha256: sha256Hex(reviewBytes) } }, asyncPlan)).toThrow('not_dispatched_capacity');
    records.push(appendAsyncRecord(records, { type: 'result', result: { callIndex: 0, attemptId: id, finishedAtMs: 112,
      reviewBytes, reviewSha256: sha256Hex(reviewBytes), possiblyBilled: true } }, asyncPlan));
    records.push(appendAsyncRecord(records, { type: 'seal', cutoffMs: 112 }, asyncPlan));
    expect(decodeAsyncProof(stableStringify({ version: 1, plan: asyncPlan, records }), asyncPlan.context).physicalAttempts).toHaveLength(1);
  });

  it('replays a sealed legacy verifier prefix while refusing another intent and permitting resolution', () => {
    const records = verificationHistory(499, 3), firstId = 'verifier-real-0', secondId = 'verifier-real-1';
    records.push(retainVerificationRecord(records, { type: 'intent', intent: { batchIndex: 0, attemptId: firstId, startedAtMs: 211 } }));
    records.push(retainVerificationRecord(records, { type: 'intent', intent: { batchIndex: 1, attemptId: secondId, startedAtMs: 212 } }));
    expect(validateVerificationRecords(records, context)?.uncertain).toHaveLength(2);
    expect(() => appendVerificationRecord(records, { type: 'intent', intent: { batchIndex: 2, attemptId: 'verifier-real-2', startedAtMs: 213 } }, context)).toThrow('intent_capacity');
    const terminal = { type: 'terminal' as const, terminal: { status: 'failed' as const, finishedAtMs: 213, reason: 'legacy cutoff' } };
    const sealed = [...records, retainVerificationRecord(records, terminal)];
    expect(sealed).toHaveLength(1002);
    expect(decodeVerificationProof(stableStringify({ version: 1, records: sealed }), context).uncertain).toHaveLength(2);
    records.push(appendVerificationRecord(records, { type: 'result', result: { batchIndex: 0, attemptId: firstId, finishedAtMs: 213, answerBytes } }, context));
    records.push(appendVerificationRecord(records, terminal, context));
    expect(decodeVerificationProof(stableStringify({ version: 1, records }), context).uncertain).toHaveLength(1);
  });

  it('reserves the last non-start slot for an unresolved async intent and can retain later paid retries beyond the old record cap', () => {
    const plan = validateAsyncPlan({ ...asyncPlan, maxPhysicalCalls: 2, maxAttemptsPerCall: 2,
      calls: [...asyncPlan.calls, { ...asyncPlan.calls[0]!, id: 'b:0', assignment: 'b' }] });
    const records = asyncHistory(499, plan), firstId = attemptId(998), secondId = attemptId(999);
    records.push(appendAsyncRecord(records, { type: 'intent', intent: { callIndex: 0, attemptId: firstId, startedAtMs: 111 } }, plan));
    const second = { type: 'intent' as const, intent: { callIndex: 1, attemptId: secondId, startedAtMs: 112 } };
    expect(() => appendAsyncRecord(records, second, plan)).toThrow('intent_capacity');
    records.push(appendAsyncRecord(records, { type: 'result', result: { callIndex: 0, attemptId: firstId, finishedAtMs: 112,
      reviewBytes, reviewSha256: sha256Hex(reviewBytes), possiblyBilled: true } }, plan));
    records.push(appendAsyncRecord(records, second, plan));
    records.push(appendAsyncRecord(records, { type: 'result', result: { callIndex: 1, attemptId: secondId, finishedAtMs: 113,
      reviewBytes, reviewSha256: sha256Hex(reviewBytes), possiblyBilled: true } }, plan));
    records.push(appendAsyncRecord(records, { type: 'seal', cutoffMs: 113 }, plan));
    expect(records).toHaveLength(1003);
    expect(decodeAsyncProof(stableStringify({ version: 1, plan, records }), plan.context).physicalAttempts).toHaveLength(2);
  });

  it('reserves the last verifier non-start slot until its outstanding result, retaining both paid results and terminal beyond the old cap', () => {
    const records = verificationHistory(499, 2), firstId = 'verifier-real-0', secondId = 'verifier-real-1';
    records.push(appendVerificationRecord(records, { type: 'intent', intent: { batchIndex: 0, attemptId: firstId, startedAtMs: 211 } }, context));
    const second = { type: 'intent' as const, intent: { batchIndex: 1, attemptId: secondId, startedAtMs: 212 } };
    expect(() => appendVerificationRecord(records, second, context)).toThrow('intent_capacity');
    records.push(appendVerificationRecord(records, { type: 'result', result: { batchIndex: 0, attemptId: firstId, finishedAtMs: 212, answerBytes } }, context));
    records.push(appendVerificationRecord(records, second, context));
    records.push(appendVerificationRecord(records, { type: 'result', result: { batchIndex: 1, attemptId: secondId, finishedAtMs: 213, answerBytes } }, context));
    records.push(appendVerificationRecord(records, { type: 'terminal', terminal: { status: 'complete', finishedAtMs: 213 } }, context));
    expect(records).toHaveLength(1004);
    expect(decodeVerificationProof(stableStringify({ version: 1, records }), context).outcomes).toHaveLength(2);
  });

  it('retains one real async call and seal after repeated non-starts with a one-call and one-attempt budget', () => {
    const records = asyncHistory(499), id = attemptId(999);
    records.push(appendAsyncRecord(records, { type: 'intent', intent: { callIndex: 0, attemptId: id, startedAtMs: 111 } }, asyncPlan));
    records.push(appendAsyncRecord(records, { type: 'result', result: { callIndex: 0, attemptId: id, finishedAtMs: 112,
      reviewBytes, reviewSha256: sha256Hex(reviewBytes), possiblyBilled: true } }, asyncPlan));
    records.push(appendAsyncRecord(records, { type: 'seal', cutoffMs: 112 }, asyncPlan));
    const proof = decodeAsyncProof(stableStringify({ version: 1, plan: asyncPlan, records }), asyncPlan.context);
    expect(proof.state.notDispatched).toHaveLength(499); expect(proof.physicalAttempts).toHaveLength(1);
    expect(proof.physicalAttempts[0]).toMatchObject({ attemptId: id, possiblyBilled: true, outcomeCertainty: 'observed' });
  });

  it('refuses another async intent at the non-start cap while leaving room to seal', () => {
    const records = asyncHistory(500);
    expect(validateAsyncRecords(records, asyncPlan).uncertain).toEqual([]);
    expect(() => appendAsyncRecord(records, { type: 'intent', intent: { callIndex: 0, attemptId: attemptId(999), startedAtMs: 111 } }, asyncPlan)).toThrow('intent_capacity');
    records.push(appendAsyncRecord(records, { type: 'seal', cutoffMs: 112 }, asyncPlan));
    expect(decodeAsyncProof(stableStringify({ version: 1, plan: asyncPlan, records }), asyncPlan.context).physicalAttempts).toEqual([]);
  });

  it('retains a verifier result and terminal after repeated non-starts with a one-call budget', () => {
    const records = verificationHistory(499), id = 'verifier-real';
    records.push(appendVerificationRecord(records, { type: 'intent', intent: { batchIndex: 0, attemptId: id, startedAtMs: 211 } }, context));
    records.push(appendVerificationRecord(records, { type: 'result', result: { batchIndex: 0, attemptId: id, finishedAtMs: 212, answerBytes } }, context));
    records.push(appendVerificationRecord(records, { type: 'terminal', terminal: { status: 'complete', finishedAtMs: 212 } }, context));
    const state = decodeVerificationProof(stableStringify({ version: 1, records }), context);
    expect(state.notDispatched).toHaveLength(499); expect(state.outcomes).toHaveLength(1); expect(state.uncertain).toEqual([]);
  });

  it('refuses another verifier intent at the non-start cap while leaving room for its terminal', () => {
    const records = verificationHistory(500);
    expect(validateVerificationRecords(records, context)?.uncertain).toEqual([]);
    expect(() => appendVerificationRecord(records, { type: 'intent', intent: { batchIndex: 0, attemptId: 'verifier-real', startedAtMs: 211 } }, context)).toThrow('intent_capacity');
    records.push(appendVerificationRecord(records, { type: 'terminal', terminal: { status: 'failed', finishedAtMs: 212, reason: 'non-start limit' } }, context));
    expect(decodeVerificationProof(stableStringify({ version: 1, records }), context).outcomes).toEqual([]);
  });
});
