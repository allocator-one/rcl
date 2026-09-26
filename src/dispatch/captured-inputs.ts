import { z } from 'zod';
import { capturedAsyncSchema, captureAsyncInputs, decodeCapturedAsync, type CaptureAsyncInputs, type CapturedAsyncInputs } from './captured-async.js';
import { decodeAggregationInputs, isCapturedAggregationInputs, type CapturedAggregationInputs } from '../report/aggregation-inputs.js';
import { ConfigSchema, type Config } from '../config/schema.js';
import type { BuiltPrompt } from '../prepare/prompt-builder.js';
import { sha256Hex, stableStringify } from '../report/run-header.js';
import type { ReviewAssignment } from '../roles/types.js';
import { freezeCheckpointPlan, type FrozenCheckpointPlan } from './checkpoint.js';
import { resolveQuorumPolicy, type QuorumPolicy } from './quorum.js';

/** Shared local/server protocol bounds; never truncate captured inputs to fit. */
export const CAPTURED_INPUT_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, cells: 500, seats: 200, chunks: 32 });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1);
const versionedTool = z.object({ name: text, version: z.number().int().positive().safe() }).strict();
const toolsSchema = z.object({ parser: versionedTool, aggregation: versionedTool }).strict();
const configSchema = ConfigSchema.omit({ githubToken: true, harness: true }).strict();
const roleSchema = z.object({ name: text, systemPrompt: z.string(), focus: z.array(z.string()),
  severityBias: z.record(z.string(), z.number().finite()).optional(), description: z.string(), isSpecialized: z.boolean() }).strict();
const contextSchema = z.array(z.object({ label: text, content: z.string(), sha256: digest }).strict());
const captureSchema = z.object({
  version: z.literal(1),
  plan: z.unknown(),
  policy: z.object({ version: z.literal(1), fraction: z.number().finite() }).strict(),
  blobs: z.record(digest, z.string()),
  aggregationSha256: digest.optional(),
  async: capturedAsyncSchema.optional(),
  roles: z.array(z.object({ cell: text, sha256: digest }).strict()).max(CAPTURED_INPUT_LIMITS.cells),
}).strict();

export interface CaptureReviewerInputs {
  plan: FrozenCheckpointPlan;
  policy: Pick<QuorumPolicy, 'version' | 'fraction'>;
  /** Exact source bytes captured before dispatch, never reconstructed from a terminal summary. */
  patchBytes: string;
  configBytes: string;
  specBytes: string;
  contextBytes: string;
  toolsBytes: string;
  chunkBytes: string[];
  assignments: ReviewAssignment[];
  prompts: BuiltPrompt[];
  /** Actual static aggregation values captured before the first provider intent. */
  aggregation?: CapturedAggregationInputs;
  async?: CaptureAsyncInputs;
}

export interface CapturedReviewerInputs extends Omit<CaptureReviewerInputs, 'policy' | 'async'> {
  version: 1;
  bytes: string;
  digest: string;
  policy: QuorumPolicy;
  config: Config;
  async?: CapturedAsyncInputs;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function bound(bytes: string): void {
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes, 'utf8') > CAPTURED_INPUT_LIMITS.bytes ||
    Buffer.from(bytes, 'utf8').toString('utf8') !== bytes) throw new Error('capture_invalid_bytes');
}

/** Generated protocol documents use one canonical encoding; ambiguous JSON is never accepted. */
function decodeCanonical(bytes: string): unknown {
  bound(bytes);
  let decoded: unknown;
  try { decoded = JSON.parse(bytes); } catch { throw new Error('capture_invalid_json'); }
  if (stableStringify(decoded) !== bytes) throw new Error('capture_noncanonical_json');
  return decoded;
}

function validatedPlan(value: unknown): FrozenCheckpointPlan {
  let plan: FrozenCheckpointPlan;
  try { plan = freezeCheckpointPlan(value as FrozenCheckpointPlan); }
  catch { throw new Error('capture_invalid_plan'); }
  if (stableStringify(plan) !== stableStringify(value) || plan.roster.length < 2 ||
    plan.roster.length > CAPTURED_INPUT_LIMITS.seats || plan.chunks.length > CAPTURED_INPUT_LIMITS.chunks ||
    plan.cells.length > CAPTURED_INPUT_LIMITS.cells) throw new Error('capture_invalid_plan');
  return plan;
}

/**
 * Capture every effective input once, sharing equal content across cells. The
 * resulting document is private evidence, not a telemetry header or authority
 * claim. Persist it in the existing checkpoint before any provider intent.
 */
export function captureReviewerInputs(input: CaptureReviewerInputs): CapturedReviewerInputs {
  const plan = validatedPlan(input.plan);
  if (input.assignments.length !== plan.cells.length || input.prompts.length !== plan.cells.length ||
    input.chunkBytes.length !== plan.chunks.length) throw new Error('capture_incomplete_matrix');
  const blobs: Record<string, string> = Object.create(null) as Record<string, string>;
  let uniqueBytes = 0;
  function add(bytes: string, expected?: string): string {
    bound(bytes);
    const hash = sha256Hex(bytes);
    if (expected !== undefined && hash !== expected) throw new Error('capture_input_mismatch');
    if (!Object.hasOwn(blobs, hash)) uniqueBytes += Buffer.byteLength(bytes, 'utf8');
    if (uniqueBytes > CAPTURED_INPUT_LIMITS.bytes) throw new Error('capture_invalid_bytes');
    blobs[hash] = bytes;
    return hash;
  }
  add(input.patchBytes, plan.patchSha256); add(input.configBytes, plan.configSha256);
  add(input.specBytes, plan.specSha256); add(input.contextBytes, plan.contextSha256); add(input.toolsBytes, plan.toolsSha256);
  plan.chunks.forEach((chunk, index) => add(input.chunkBytes[index]!, chunk.digest));
  const roles = plan.cells.map((cell, index) => {
    const assignment = input.assignments[index]!, prompt = input.prompts[index]!;
    if (assignment.model !== cell.model || assignment.provider !== cell.route || assignment.role.name !== cell.role) {
      throw new Error('capture_assignment_mismatch');
    }
    add(prompt.systemPrompt, cell.systemPromptSha256); add(prompt.userPrompt, cell.userPromptSha256);
    return { cell: cell.id, sha256: add(stableStringify(assignment.role)) };
  });
  let aggregationSha256: string | undefined;
  if (input.aggregation !== undefined) {
    if (!isCapturedAggregationInputs(input.aggregation)) throw new Error('capture_unvalidated_aggregation');
    const aggregation = decodeAggregationInputs(input.aggregation.bytes, plan.patchSha256);
    aggregationSha256 = add(aggregation.bytes, aggregation.digest);
  }
  const async = input.async === undefined ? undefined : captureAsyncInputs(input.async, plan, add);
  const bytes = stableStringify({ version: 1, plan, policy: input.policy, blobs, roles,
    ...(async === undefined ? {} : { async }),
    ...(aggregationSha256 !== undefined ? { aggregationSha256 } : {}) });
  return decodeCapturedInputs(bytes, plan);
}

/**
 * Hydrate only exact frozen inputs. The expected plan comes from the caller's
 * fresh target/input check; source lineage and producer authority are separate
 * mandatory admission checks. Legacy reports without this capture cannot pass.
 */
export function decodeCapturedInputs(bytes: string, expectedPlan: unknown): CapturedReviewerInputs {
  const parsed = captureSchema.safeParse(decodeCanonical(bytes));
  if (!parsed.success) throw new Error('capture_invalid_document');
  const captured = parsed.data, plan = validatedPlan(captured.plan), expected = validatedPlan(expectedPlan);
  if (stableStringify(plan) !== stableStringify(expected)) throw new Error('capture_plan_mismatch');
  const policy = resolveQuorumPolicy(plan.roster.length, captured.policy.fraction);
  const referenced = new Set<string>();
  function get(hash: string): string {
    const value = captured.blobs[hash];
    if (typeof value !== 'string' || sha256Hex(value) !== hash) throw new Error('capture_missing_or_changed_blob');
    bound(value); referenced.add(hash); return value;
  }
  const patchBytes = get(plan.patchSha256), configBytes = get(plan.configSha256), specBytes = get(plan.specSha256);
  const contextBytes = get(plan.contextSha256), toolsBytes = get(plan.toolsSha256);
  const config = configSchema.safeParse(decodeCanonical(configBytes));
  if (!config.success || stableStringify(config.data) !== configBytes ||
    (config.data.quorumFraction ?? 2 / 3) !== policy.fraction) throw new Error('capture_invalid_config_or_policy');
  const context = contextSchema.safeParse(decodeCanonical(contextBytes));
  if (!context.success || context.data.some(doc => sha256Hex(doc.content) !== doc.sha256)) throw new Error('capture_invalid_context');
  const tools = toolsSchema.safeParse(decodeCanonical(toolsBytes));
  if (!tools.success || stableStringify(tools.data.parser) !== stableStringify(plan.parser)) throw new Error('capture_incompatible_tools');
  const chunkBytes = plan.chunks.map(chunk => get(chunk.digest));
  if (captured.roles.length !== plan.cells.length) throw new Error('capture_incomplete_matrix');
  const seatRoles = new Map<string, string>();
  const assignments: ReviewAssignment[] = [], prompts: BuiltPrompt[] = [];
  plan.cells.forEach((cell, index) => {
    const reference = captured.roles[index]!;
    if (reference.cell !== cell.id) throw new Error('capture_assignment_mismatch');
    const role = roleSchema.safeParse(decodeCanonical(get(reference.sha256)));
    if (!role.success || role.data.name !== cell.role ||
      seatRoles.has(cell.seat) && seatRoles.get(cell.seat) !== reference.sha256) throw new Error('capture_assignment_mismatch');
    seatRoles.set(cell.seat, reference.sha256);
    assignments.push({ model: cell.model, provider: cell.route, role: role.data });
    prompts.push({ systemPrompt: get(cell.systemPromptSha256), userPrompt: get(cell.userPromptSha256) });
  });
  const aggregation = captured.aggregationSha256 === undefined ? undefined
    : decodeAggregationInputs(get(captured.aggregationSha256), plan.patchSha256);
  if (aggregation && stableStringify(aggregation.algorithm) !== stableStringify(tools.data.aggregation)) {
    throw new Error('capture_incompatible_aggregation');
  }
  const async = captured.async === undefined ? undefined : decodeCapturedAsync(captured.async, plan, get, bytes => roleSchema.parse(decodeCanonical(bytes)));
  if (Object.keys(captured.blobs).length !== referenced.size) throw new Error('capture_unreferenced_blob');
  return freeze({ version: 1, bytes, digest: sha256Hex(bytes), plan, policy, config: config.data,
    patchBytes, configBytes, specBytes, contextBytes, toolsBytes, chunkBytes, assignments, prompts,
    ...(async === undefined ? {} : { async }),
    ...(aggregation !== undefined ? { aggregation } : {}) });
}
