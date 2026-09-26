import { z } from 'zod';
import { blockingCheckpointReviewSchema } from './checkpoint.js';
import { sha256Hex, stableStringify } from '../report/run-header.js';
import { MAX_ARTIFACT_BYTES } from '../telemetry/envelope-validation.js';
import { MAX_TIMER_DELAY_MS } from '../config/schema.js';

const integer = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(512).refine(value => !!value.trim() && !/[\0\r\n]/.test(value));
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
const contextSchema = z.object({ runId: uuid, target: text, planDigest: digest, capturedInputsSha256: digest,
  launchSha256: digest, startedAtMs: integer, expiresAtMs: integer, reviewerReservedCalls: integer.min(1).max(500) }).strict();
const callSchema = z.object({ id: text, assignment: text, chunk: integer, chunkSha256: digest,
  provider: text, model: text, role: text, systemPromptSha256: digest, userPromptSha256: digest }).strict();
const planSchema = z.object({ version: z.literal(1), context: contextSchema, calls: z.array(callSchema).min(1).max(8),
  maxPhysicalCalls: integer.min(1).max(500), maxAttemptsPerCall: integer.min(1).max(500), expiresAtMs: integer }).strict();
const intentSchema = z.object({ callIndex: integer, attemptId: z.string().regex(/^async-[a-f0-9-]{36}$/), startedAtMs: integer }).strict();
const resultSchema = z.object({ callIndex: integer, attemptId: intentSchema.shape.attemptId, finishedAtMs: integer,
  reviewBytes: z.string().min(1), reviewSha256: digest, possiblyBilled: z.boolean() }).strict();
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('intent'), intent: intentSchema }).strict(),
  z.object({ type: z.literal('result'), result: resultSchema }).strict(),
  z.object({ type: z.literal('seal'), cutoffMs: integer }).strict(),
]);
const recordSchema = z.object({ sequence: integer.min(1), previousDigest: digest, digest, event: eventSchema }).strict();
const wireSchema = z.object({ version: z.literal(1), plan: planSchema, records: z.array(recordSchema).max(1001) }).strict();
const asyncReviewSchema = blockingCheckpointReviewSchema.extend({ async: z.literal(true) }).strict();
export type AsyncContext = z.infer<typeof contextSchema>;
export type AsyncCall = z.infer<typeof callSchema>;
export type AsyncPlan = z.infer<typeof planSchema>;
export type AsyncIntent = z.infer<typeof intentSchema>;
export type AsyncResult = z.infer<typeof resultSchema>;
export type AsyncEvent = z.infer<typeof eventSchema>;
export type AsyncRecord = z.infer<typeof recordSchema>;
export interface AsyncState { records: readonly AsyncRecord[]; intents: readonly AsyncIntent[]; outcomes: readonly AsyncResult[]; uncertain: readonly AsyncIntent[]; cutoffMs?: number }
export interface AsyncProof { version: 1; bytes: string; digest: string; context: AsyncContext; plan: AsyncPlan; state: AsyncState;
  physicalAttempts: Array<{ runId: string; attemptId: string; callIndex: number; call: AsyncCall; outcomeCertainty: 'observed' | 'uncertain'; possiblyBilled: boolean;
    reviewBytes: string | null; reviewSha256: string | null; durationMs: number | null; usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | null }> }
export function asyncRefuse(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(`checkpoint_async_${reason}`); }
export function freezeAsync<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const v of Object.values(value)) freezeAsync(v); Object.freeze(value); } return value; }
function bound(bytes: string, limit = MAX_ARTIFACT_BYTES): void {
  asyncRefuse(typeof bytes === 'string' && Buffer.byteLength(bytes, 'utf8') <= limit && Buffer.from(bytes, 'utf8').toString('utf8') === bytes, 'invalid_bytes');
}
/** Frozen phase allocation, not evidence that its async call matrix came from captured inputs. */
export function validateAsyncPlan(input: unknown): AsyncPlan {
  const parsed = planSchema.safeParse(input); asyncRefuse(parsed.success, 'invalid_plan'); const plan = parsed.data, context = plan.context;
  asyncRefuse(context.expiresAtMs >= context.startedAtMs && context.expiresAtMs - context.startedAtMs <= MAX_TIMER_DELAY_MS &&
    plan.expiresAtMs >= context.startedAtMs && plan.expiresAtMs <= context.expiresAtMs, 'deadline');
  asyncRefuse(plan.maxPhysicalCalls + context.reviewerReservedCalls <= 500, 'budget');
  const ids = new Set<string>(), assignments = new Map<string, string>();
  for (const call of plan.calls) {
    asyncRefuse(call.id === `${call.assignment}:${call.chunk}` && !ids.has(call.id), 'call'); ids.add(call.id);
    const route = stableStringify([call.model, call.role, call.provider]);
    asyncRefuse(!assignments.has(call.assignment) || assignments.get(call.assignment) === route, 'call'); assignments.set(call.assignment, route);
  }
  bound(stableStringify(plan)); return freezeAsync(plan);
}
/** Exact schema-valid observed bytes; no provider truth or billing authority is inferred. */
export function parseAsyncReview(bytes: string, call: AsyncCall) {
  bound(bytes, 8 * 1024 * 1024); let value: unknown; try { value = JSON.parse(bytes); } catch { throw new Error('checkpoint_async_invalid_review'); }
  const parsed = asyncReviewSchema.safeParse(value); asyncRefuse(parsed.success && parsed.data.model === call.model && parsed.data.role === call.role && parsed.data.provider === call.provider, 'invalid_review');
  return freezeAsync(parsed.data);
}
export function validateAsyncResult(input: unknown, plan: AsyncPlan, intents: readonly AsyncIntent[]): AsyncResult {
  const parsed = resultSchema.safeParse(input); asyncRefuse(parsed.success, 'invalid_result'); const result = parsed.data;
  const intent = intents.find(row => row.attemptId === result.attemptId);
  asyncRefuse(intent && intent.callIndex === result.callIndex && result.finishedAtMs >= intent.startedAtMs, 'result_intent');
  asyncRefuse(sha256Hex(result.reviewBytes) === result.reviewSha256, 'result_digest');
  const review = parseAsyncReview(result.reviewBytes, plan.calls[result.callIndex]!);
  asyncRefuse(review.status !== 'success' || result.possiblyBilled, 'success_billing'); return freezeAsync(result);
}
/** Replays exact ordered records. Unknown outcomes consume budget and cannot be retried. */
export function validateAsyncRecords(input: readonly unknown[], planInput: AsyncPlan): AsyncState {
  const plan = validateAsyncPlan(planInput); asyncRefuse(input.length <= 1001, 'too_many_records');
  const records: AsyncRecord[] = [], intents: AsyncIntent[] = [], outcomes: AsyncResult[] = []; let cutoffMs: number | undefined, previous = sha256Hex(stableStringify(plan));
  for (const [index, raw] of input.entries()) {
    const parsed = recordSchema.safeParse(raw); asyncRefuse(parsed.success, 'invalid_record'); const record = parsed.data, { digest: hash, ...unsigned } = record;
    asyncRefuse(cutoffMs === undefined && record.sequence === index + 1 && record.previousDigest === previous && hash === sha256Hex(stableStringify(unsigned)), 'invalid_record');
    const event = record.event;
    if (event.type === 'intent') {
      const intent = event.intent, prior = intents.filter(row => row.callIndex === intent.callIndex), last = prior.at(-1), result = last && outcomes.find(row => row.attemptId === last.attemptId);
      asyncRefuse(intent.callIndex < plan.calls.length && !intents.some(row => row.attemptId === intent.attemptId), 'duplicate_or_unknown_intent');
      asyncRefuse(!last || result && parseAsyncReview(result.reviewBytes, plan.calls[intent.callIndex]!).status !== 'success', 'retry_unresolved_or_success');
      asyncRefuse(intent.startedAtMs >= plan.context.startedAtMs && intent.startedAtMs < plan.expiresAtMs &&
        intent.startedAtMs >= (intents.at(-1)?.startedAtMs ?? 0) && intent.startedAtMs >= (result?.finishedAtMs ?? 0), 'intent_time');
      asyncRefuse(intents.length < plan.maxPhysicalCalls && prior.length < plan.maxAttemptsPerCall, 'budget'); intents.push(intent);
    } else if (event.type === 'result') {
      const result = validateAsyncResult(event.result, plan, intents); asyncRefuse(!outcomes.some(row => row.attemptId === result.attemptId), 'duplicate_result'); outcomes.push(result);
    } else {
      asyncRefuse(event.cutoffMs >= plan.context.startedAtMs && intents.every(row => row.startedAtMs <= event.cutoffMs) && outcomes.every(row => row.finishedAtMs <= event.cutoffMs), 'cutoff_time'); cutoffMs = event.cutoffMs;
    }
    records.push(record); previous = hash;
  }
  bound(stableStringify({ version: 1, plan, records }));
  return freezeAsync({ records, intents, outcomes, uncertain: intents.filter(row => !outcomes.some(result => result.attemptId === row.attemptId)), ...(cutoffMs === undefined ? {} : { cutoffMs }) });
}
export function appendAsyncRecord(records: readonly AsyncRecord[], event: AsyncEvent, plan: AsyncPlan): AsyncRecord {
  const unsigned = { sequence: records.length + 1, previousDigest: records.at(-1)?.digest ?? sha256Hex(stableStringify(plan)), event };
  const record = { ...unsigned, digest: sha256Hex(stableStringify(unsigned)) }; validateAsyncRecords([...records, record], plan); return freezeAsync(record);
}
/** A canonical sealed accounting snapshot; external capture/producer/lineage authority is separate. */
export function decodeAsyncProof(bytes: string, expectedContext: AsyncContext): AsyncProof {
  bound(bytes); let value: unknown; try { value = JSON.parse(bytes); } catch { throw new Error('checkpoint_async_invalid_proof'); }
  const parsed = wireSchema.safeParse(value); asyncRefuse(parsed.success && stableStringify(parsed.data) === bytes, 'noncanonical_proof');
  const plan = validateAsyncPlan(parsed.data.plan); asyncRefuse(stableStringify(contextSchema.parse(expectedContext)) === stableStringify(plan.context), 'context');
  const state = validateAsyncRecords(parsed.data.records, plan); asyncRefuse(state.cutoffMs !== undefined, 'unsealed');
  const physicalAttempts: AsyncProof['physicalAttempts'] = state.intents.map(intent => {
    const result = state.outcomes.find(row => row.attemptId === intent.attemptId), call = plan.calls[intent.callIndex]!, review = result && parseAsyncReview(result.reviewBytes, call);
    return { runId: plan.context.runId, attemptId: intent.attemptId, callIndex: intent.callIndex, call,
      outcomeCertainty: result ? 'observed' : 'uncertain', possiblyBilled: result?.possiblyBilled ?? true, reviewBytes: result?.reviewBytes ?? null,
      reviewSha256: result?.reviewSha256 ?? null, durationMs: review?.durationMs ?? null, usage: review?.usage ?? null };
  });
  return freezeAsync({ version: 1, bytes, digest: sha256Hex(bytes), context: plan.context, plan, state, physicalAttempts });
}
export function encodeAsyncProof(plan: AsyncPlan, records: readonly AsyncRecord[]): AsyncProof {
  return decodeAsyncProof(stableStringify({ version: 1, plan, records }), plan.context);
}
