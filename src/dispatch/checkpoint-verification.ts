import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_TIMER_DELAY_MS } from '../config/schema.js';
import { stableStringify } from '../report/run-header.js';
import { MAX_ARTIFACT_BYTES } from '../telemetry/envelope-validation.js';
import type { ModelAnswer } from './adapter.js';

const integer = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).refine(value => !!value.trim() && !/[\0\r\n]/.test(value));
const attemptId = z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
const planSchema = z.object({
  runId: uuid,
  // These private bytes are an immutable comparison anchor, not a trusted plan.
  gatingPlanBytes: z.string().min(1),
  model: text, provider: text,
  batches: z.array(z.object({ systemPrompt: z.string(), userPrompt: z.string() }).strict()).max(500),
  startedAtMs: integer, expiresAtMs: integer,
  verificationTimeoutMs: integer.min(1).max(MAX_TIMER_DELAY_MS),
  verificationPassTimeoutMs: integer.min(1).max(MAX_TIMER_DELAY_MS),
  maxPhysicalCalls: integer.max(500),
}).strict();
const intentSchema = z.object({ batchIndex: integer, attemptId, startedAtMs: integer }).strict();
const resultSchema = z.object({ batchIndex: integer, attemptId, finishedAtMs: integer, answerBytes: z.string().min(1) }).strict();
const terminalSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('complete'), finishedAtMs: integer }).strict(),
  z.object({ status: z.literal('failed'), finishedAtMs: integer, reason: text }).strict(),
]);
const bindingsSchema = z.object({ planDigest: digest, finalizationDigest: digest, capturedInputsSha256: digest, operationSha256: digest }).strict();
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plan'), plan: planSchema }).strict(),
  z.object({ type: z.literal('intent'), intent: intentSchema }).strict(),
  z.object({ type: z.literal('result'), result: resultSchema }).strict(),
  z.object({ type: z.literal('terminal'), terminal: terminalSchema }).strict(),
]);
const recordSchema = z.object({ sequence: integer.min(1), previousDigest: digest, digest,
  event: eventSchema, bindings: bindingsSchema,
}).strict();
const answerSchema = z.object({ model: text, provider: text, text: z.string(),
  durationMs: z.number().finite().nonnegative(), status: z.enum(['success', 'timeout', 'error']), error: z.string().optional(),
}).strict();
// Validate request-bearing fields here. Finding semantics are independently
// regenerated from captured source before replay; arbitrary annotations are not
// authenticated merely by matching this structural schema.
const requestPlanSchema = z.object({ version: z.literal(1), findings: z.array(z.unknown()),
  initialGating: z.array(z.unknown()), candidateIndices: z.array(integer), model: text,
  verificationTimeoutMs: integer.min(1).max(MAX_TIMER_DELAY_MS),
  verificationPassTimeoutMs: integer.min(1).max(MAX_TIMER_DELAY_MS),
  batches: z.array(z.object({ findingIndices: z.array(integer), systemPrompt: z.string(), userPrompt: z.string() }).strict()).max(500),
}).strict();

export type VerificationPlanInput = z.infer<typeof planSchema>;
export type VerificationIntent = z.infer<typeof intentSchema>;
export type VerificationResult = z.infer<typeof resultSchema>;
export type VerificationTerminal = z.infer<typeof terminalSchema>;
export type VerificationEvent = z.infer<typeof eventSchema>;
export type VerificationRecord = z.infer<typeof recordSchema>;
export interface VerificationContext extends z.infer<typeof bindingsSchema> {
  runId: string;
  startedAtMs: number;
  expiresAtMs: number;
  reviewerAttemptIds: readonly string[];
}
export interface VerificationState {
  plan: VerificationPlanInput;
  records: VerificationRecord[];
  intents: VerificationIntent[];
  outcomes: VerificationResult[];
  uncertain: VerificationIntent[];
  terminal?: VerificationTerminal;
}

export function verificationDigest(bytes: string): string { return createHash('sha256').update(bytes).digest('hex'); }

/** Parse exact observed adapter bytes against the frozen verifier route. */
export function parseVerificationAnswer(bytes: string, plan: Pick<VerificationPlanInput, 'model' | 'provider'>): ModelAnswer {
  opaque(bytes);
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new Error('checkpoint_verification_invalid_answer'); }
  const answer = answerSchema.safeParse(value);
  refuse(answer.success && answer.data.model === plan.model && answer.data.provider === plan.provider, 'invalid_answer');
  return freeze(answer.data) as ModelAnswer;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function refuse(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`checkpoint_verification_${reason}`);
}
function opaque(bytes: string): void {
  refuse(Buffer.byteLength(bytes, 'utf8') <= 8 * 1024 * 1024 && Buffer.from(bytes, 'utf8').toString('utf8') === bytes, 'invalid_bytes');
}
function binding(context: VerificationContext): z.infer<typeof bindingsSchema> {
  return bindingsSchema.parse({ planDigest: context.planDigest, finalizationDigest: context.finalizationDigest,
    capturedInputsSha256: context.capturedInputsSha256, operationSha256: context.operationSha256 });
}

/** Snapshot before any await. Validation is structural; this never authorizes a provider request. */
export function snapshotVerificationEvent(input: VerificationEvent): VerificationEvent {
  const parsed = eventSchema.safeParse(input);
  refuse(parsed.success, 'invalid_event');
  const event = parsed.data;
  if (event.type === 'plan') {
    opaque(event.plan.gatingPlanBytes);
    for (const batch of event.plan.batches) { opaque(batch.systemPrompt); opaque(batch.userPrompt); }
    let value: unknown;
    try { value = JSON.parse(event.plan.gatingPlanBytes); } catch { throw new Error('checkpoint_verification_invalid_gating_plan'); }
    const saved = requestPlanSchema.safeParse(value);
    refuse(saved.success && stableStringify(value) === event.plan.gatingPlanBytes, 'invalid_gating_plan');
    const plan = saved.data;
    refuse(plan.model === event.plan.model && plan.verificationTimeoutMs === event.plan.verificationTimeoutMs &&
      plan.verificationPassTimeoutMs === event.plan.verificationPassTimeoutMs &&
      stableStringify(plan.batches.map(({ systemPrompt, userPrompt }) => ({ systemPrompt, userPrompt }))) === stableStringify(event.plan.batches), 'request_plan_mismatch');
  } else if (event.type === 'result') opaque(event.result.answerBytes);
  refuse(Buffer.byteLength(stableStringify(event), 'utf8') <= MAX_ARTIFACT_BYTES, 'too_large');
  return freeze(event);
}

/** A proof of private local recording, not of remote ownership, model truth or launch authority. */
export function validateVerificationRecords(input: readonly unknown[], context: VerificationContext): VerificationState | undefined {
  refuse(input.length <= 1002, 'too_many_records');
  if (!input.length) return undefined;
  const expected = stableStringify(binding(context));
  const records: VerificationRecord[] = [], intents: VerificationIntent[] = [], outcomes: VerificationResult[] = [];
  const byBatch = new Map<number, VerificationIntent>(), ids = new Set(context.reviewerAttemptIds), results = new Set<number>();
  let plan: VerificationPlanInput | undefined, terminal: VerificationTerminal | undefined, previous = context.finalizationDigest;
  // Reserve the portable wrapper and one separator per record, also covering
  // local trailing newlines. A writer must never publish evidence its reader
  // would refuse because JSON/container overhead crossed the same byte cap.
  let retainedBytes = Buffer.byteLength('{"records":[],"version":1}', 'utf8');
  for (const [index, value] of input.entries()) {
    const parsed = recordSchema.safeParse(value);
    refuse(parsed.success, 'invalid_record');
    const record = parsed.data, { digest: hash, ...unsigned } = record;
    retainedBytes += Buffer.byteLength(stableStringify(record), 'utf8') + 1;
    refuse(retainedBytes <= MAX_ARTIFACT_BYTES, 'too_large');
    refuse(record.sequence === index + 1 && record.previousDigest === previous &&
      hash === verificationDigest(stableStringify(unsigned)) && stableStringify(record.bindings) === expected, 'invalid_record');
    const event = snapshotVerificationEvent(record.event);
    refuse(!terminal, 'finalized');
    if (event.type === 'plan') {
      refuse(index === 0 && !plan, 'duplicate_plan');
      plan = event.plan;
      refuse(plan.runId === context.runId && plan.startedAtMs >= context.startedAtMs && plan.expiresAtMs >= plan.startedAtMs &&
        plan.expiresAtMs <= context.expiresAtMs && plan.expiresAtMs - plan.startedAtMs <= plan.verificationPassTimeoutMs &&
        plan.maxPhysicalCalls <= plan.batches.length && plan.maxPhysicalCalls + context.reviewerAttemptIds.length <= 500, 'invalid_plan');
    } else {
      refuse(plan, 'missing_plan');
      if (event.type === 'intent') {
        const row = event.intent;
        refuse(row.batchIndex < plan.batches.length && !byBatch.has(row.batchIndex) && !ids.has(row.attemptId), 'duplicate_or_unknown_intent');
        refuse(row.startedAtMs >= plan.startedAtMs && row.startedAtMs < plan.expiresAtMs &&
          row.startedAtMs >= (intents.at(-1)?.startedAtMs ?? plan.startedAtMs), 'invalid_intent_time');
        refuse(intents.length < plan.maxPhysicalCalls, 'call_cap');
        byBatch.set(row.batchIndex, row); ids.add(row.attemptId); intents.push(row);
      } else if (event.type === 'result') {
        const row = event.result, launch = byBatch.get(row.batchIndex);
        refuse(launch && launch.attemptId === row.attemptId && !results.has(row.batchIndex), 'missing_or_duplicate_intent');
        refuse(row.finishedAtMs >= launch.startedAtMs, 'invalid_result_time');
        parseVerificationAnswer(row.answerBytes, plan);
        results.add(row.batchIndex); outcomes.push(row);
      } else {
        const row = event.terminal;
        refuse(row.finishedAtMs >= plan.startedAtMs && intents.every(x => x.startedAtMs <= row.finishedAtMs) &&
          outcomes.every(x => x.finishedAtMs <= row.finishedAtMs), 'invalid_terminal_time');
        if (row.status === 'complete') refuse(results.size === plan.batches.length && row.finishedAtMs < plan.expiresAtMs, 'incomplete');
        terminal = row;
      }
    }
    records.push(record); previous = hash;
  }
  refuse(plan, 'missing_plan');
  return freeze({ plan, records, intents, outcomes, uncertain: intents.filter(row => !results.has(row.batchIndex)), ...(terminal ? { terminal } : {}) });
}

export function appendVerificationRecord(records: readonly VerificationRecord[], event: VerificationEvent, context: VerificationContext): VerificationRecord {
  const unsigned = { sequence: records.length + 1, previousDigest: records.at(-1)?.digest ?? context.finalizationDigest,
    bindings: binding(context), event: snapshotVerificationEvent(event) };
  const record = { ...unsigned, digest: verificationDigest(stableStringify(unsigned)) };
  validateVerificationRecords([...records, record], context);
  return freeze(record);
}

/** Canonical sealed portable bytes. Consumers must regenerate the plan from validated captures before replay. */
export function encodeVerificationProof(state: VerificationState, context: VerificationContext): { bytes: string; digest: string } {
  const checked = validateVerificationRecords(state.records, context);
  refuse(checked?.terminal, 'unsealed');
  const bytes = stableStringify({ version: 1, records: checked.records });
  refuse(Buffer.byteLength(bytes, 'utf8') <= MAX_ARTIFACT_BYTES, 'too_large');
  return freeze({ bytes, digest: verificationDigest(bytes) });
}

/** Structural only. Matching supplied context is not a substitute for authenticated ancestry. */
export function decodeVerificationProof(bytes: string, context: VerificationContext): VerificationState {
  refuse(typeof bytes === 'string' && Buffer.byteLength(bytes, 'utf8') <= MAX_ARTIFACT_BYTES &&
    Buffer.from(bytes, 'utf8').toString('utf8') === bytes, 'invalid_proof');
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new Error('checkpoint_verification_invalid_proof'); }
  const parsed = z.object({ version: z.literal(1), records: z.array(z.unknown()).max(1002) }).strict().safeParse(value);
  refuse(parsed.success && stableStringify(value) === bytes, 'invalid_proof');
  const state = validateVerificationRecords(parsed.data.records, context);
  refuse(state?.terminal, 'unsealed');
  return state;
}
