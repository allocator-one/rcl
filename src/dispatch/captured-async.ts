import { z } from 'zod';
import { MAX_TIMER_DELAY_MS } from '../config/schema.js';
import type { BuiltPrompt } from '../prepare/prompt-builder.js';
import type { ReviewAssignment, Role } from '../roles/types.js';
import { stableStringify } from '../report/run-header.js';
import type { AsyncCall } from './checkpoint-async.js';
import type { FrozenCheckpointPlan } from './checkpoint.js';

const integer = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(512).refine(value => !!value.trim() && !/[\0\r\n]/.test(value));
/** Optional v1 capture extension. Every hash refers to the existing capture blobs. */
export const capturedAsyncSchema = z.object({ version: z.literal(1),
  timeoutMs: integer.positive().max(MAX_TIMER_DELAY_MS), maxAttemptsPerCall: integer.min(1).max(500),
  maxPhysicalCalls: integer.min(1).max(500),
  calls: z.array(z.object({ id: text, assignment: text, chunk: integer, chunkSha256: digest,
    provider: text, model: text, role: text, roleSha256: digest, systemPromptSha256: digest, userPromptSha256: digest }).strict()).min(1).max(8),
}).strict();
export interface CaptureAsyncInputs {
  timeoutMs: number; maxAttemptsPerCall: number; maxPhysicalCalls: number;
  calls: Array<{ assignmentId: string; chunk: number; assignment: ReviewAssignment; prompt: BuiltPrompt }>;
}
export interface CapturedAsyncInputs {
  version: 1; timeoutMs: number; maxAttemptsPerCall: number; maxPhysicalCalls: number;
  calls: Array<{ ref: AsyncCall; assignment: ReviewAssignment; prompt: BuiltPrompt }>;
}

/** Capture actual prepared calls; this does not build prompts or infer a schedule from results. */
export function captureAsyncInputs(input: CaptureAsyncInputs, plan: FrozenCheckpointPlan, add: (bytes: string) => string) {
  return capturedAsyncSchema.parse({ version: 1, timeoutMs: input.timeoutMs,
    maxAttemptsPerCall: input.maxAttemptsPerCall, maxPhysicalCalls: input.maxPhysicalCalls,
    calls: input.calls.map(call => ({ id: `${call.assignmentId}:${call.chunk}`, assignment: call.assignmentId,
      chunk: call.chunk, chunkSha256: plan.chunks[call.chunk]?.digest, model: call.assignment.model,
      provider: call.assignment.provider, role: call.assignment.role.name, roleSha256: add(stableStringify(call.assignment.role)),
      systemPromptSha256: add(call.prompt.systemPrompt), userPromptSha256: add(call.prompt.userPrompt) })) });
}

/** Decode exact role/route/chunk/prompt bindings, preserving duplicate assignment instances. */
export function decodeCapturedAsync(wire: z.infer<typeof capturedAsyncSchema>, plan: FrozenCheckpointPlan,
  get: (hash: string) => string, decodeRole: (bytes: string) => Role): CapturedAsyncInputs {
  const ids = new Set<string>(), assignments = new Map<string, string>();
  const calls = wire.calls.map(({ roleSha256, ...ref }) => {
    const role = decodeRole(get(roleSha256));
    const signature = stableStringify([ref.provider, ref.model, ref.role, roleSha256]);
    if (ref.id !== `${ref.assignment}:${ref.chunk}` || ids.has(ref.id) || plan.chunks[ref.chunk]?.digest !== ref.chunkSha256 ||
      role.name !== ref.role || assignments.has(ref.assignment) && assignments.get(ref.assignment) !== signature) {
      throw new Error('capture_invalid_async_matrix');
    }
    ids.add(ref.id); assignments.set(ref.assignment, signature);
    return { ref, assignment: { provider: ref.provider, model: ref.model, role },
      prompt: { systemPrompt: get(ref.systemPromptSha256), userPrompt: get(ref.userPromptSha256) } };
  });
  return { version: 1, timeoutMs: wire.timeoutMs, maxAttemptsPerCall: wire.maxAttemptsPerCall, maxPhysicalCalls: wire.maxPhysicalCalls, calls };
}
