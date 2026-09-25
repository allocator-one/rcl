import { z } from 'zod';
import { GatingSchema, ThresholdsSchema } from '../config/schema.js';
import type { ResolvedGatingConfig } from '../consensus/gating.js';
import type { Role } from '../roles/types.js';
import { sha256Hex, stableStringify, type ResolvedThresholds } from './run-header.js';

export const MAX_AGGREGATION_INPUT_BYTES = 8 * 1024 * 1024;
export const AGGREGATION_ALGORITHM = Object.freeze({ name: 'consensus', version: 1 } as const);
const algorithmSchema = z.object({ name: z.literal(AGGREGATION_ALGORITHM.name), version: z.literal(AGGREGATION_ALGORITHM.version) }).strict();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const thresholdsSchema = ThresholdsSchema.required().strict();
const verifierSchema = GatingSchema.shape.verificationModel.unwrap().min(1).refine(model => !model.startsWith('openrouter/'));
const gatingSchema = z.object({
  mode: GatingSchema.shape.mode.unwrap(), minModels: GatingSchema.shape.minModels.unwrap().safe(),
  verificationModel: verifierSchema.nullable(),
  verificationTimeoutMs: GatingSchema.shape.verificationTimeout.unwrap(),
  verificationPassTimeoutMs: GatingSchema.shape.verificationPassTimeout.unwrap(),
}).strict();
const roleSchema = z.object({ name: z.string().min(1), systemPrompt: z.string(), focus: z.array(z.string()),
  severityBias: z.record(z.string(), z.number().finite()).optional(), description: z.string(), isSpecialized: z.boolean() }).strict();
const roleEntrySchema = z.object({ name: z.string().min(1), role: roleSchema }).strict().refine(entry => entry.name === entry.role.name);
// loadMergedWeights applies the supported voter's inclusive [0.5, 1.5] range.
const weightEntrySchema = z.object({ model: z.string().min(1).refine(model => !/[\u0000-\u001f\u007f-\u009f]/.test(model)), weight: z.number().finite().min(0.5).max(1.5) }).strict();
const wireSchema = z.object({
  version: z.literal(1), algorithm: algorithmSchema, diffSha256: digestSchema,
  roles: z.array(roleEntrySchema).refine(rows => rows.every((row, index) => index === 0 || rows[index - 1]!.name < row.name)),
  thresholds: thresholdsSchema, gating: gatingSchema,
  modelWeights: z.array(weightEntrySchema).refine(rows => rows.every((row, index) => index === 0 || rows[index - 1]!.model < row.model)).optional(),
  belowThresholdAppendix: z.boolean(),
}).strict();
const inputSchema = z.object({
  algorithm: algorithmSchema, diffSha256: digestSchema, roleMap: z.instanceof(Map), thresholds: thresholdsSchema,
  gating: gatingSchema.extend({ verificationModel: verifierSchema.optional() }), modelWeights: z.instanceof(Map).optional(),
  belowThresholdAppendix: z.boolean(),
}).strict();

export interface CaptureAggregationInput {
  algorithm: typeof AGGREGATION_ALGORITHM;
  diffSha256: string;
  /** Complete actual name-keyed map, including any async roles; not reconstructed from seats. */
  roleMap: ReadonlyMap<string, Role>;
  /** Pass actual effective values; this boundary never re-resolves mutable defaults. */
  thresholds: ResolvedThresholds;
  gating: ResolvedGatingConfig;
  /** Undefined disables weighting; an empty map remains explicitly active. */
  modelWeights?: ReadonlyMap<string, number>;
  belowThresholdAppendix: boolean;
}
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type CapturedAggregationInputs = DeepReadonly<{
  version: 1; bytes: string; digest: string; algorithm: typeof AGGREGATION_ALGORITHM; diffSha256: string;
  roles: Array<{ name: string; role: Role }>; thresholds: ResolvedThresholds; gating: ResolvedGatingConfig;
  modelWeights?: Array<{ model: string; weight: number }>; belowThresholdAppendix: boolean;
}>;
const capturedValues = new WeakSet<object>();
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function bound(bytes: string): void {
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes, 'utf8') > MAX_AGGREGATION_INPUT_BYTES ||
    Buffer.from(bytes, 'utf8').toString('utf8') !== bytes) throw new Error('aggregation_invalid_bytes');
}
function compareKeys(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

/** Runtime validation brand, not provider, source-lineage or persistence authority. */
export function isCapturedAggregationInputs(value: unknown): value is CapturedAggregationInputs {
  return value !== null && typeof value === 'object' && capturedValues.has(value);
}

/**
 * Snapshot resolved static inputs before the first paid intent. The caller binds
 * these bytes in the existing capture document; this pure function stores nothing.
 */
export function captureAggregationInputs(input: CaptureAggregationInput): CapturedAggregationInputs {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error('aggregation_invalid_input');
  const actual = parsed.data;
  let componentBytes = 0;
  const retain = <T>(value: T): T => {
    componentBytes += Buffer.byteLength(stableStringify(value), 'utf8');
    if (componentBytes > MAX_AGGREGATION_INPUT_BYTES) throw new Error('aggregation_invalid_bytes');
    return value;
  };
  const roles = [...actual.roleMap.entries()].map(([name, role]) => {
    const entry = roleEntrySchema.safeParse({ name, role });
    if (!entry.success || stableStringify(entry.data) !== stableStringify({ name, role })) throw new Error('aggregation_invalid_input');
    return retain(entry.data);
  }).sort((left, right) => compareKeys(left.name, right.name));
  const modelWeights = actual.modelWeights === undefined ? undefined : [...actual.modelWeights.entries()].map(([model, weight]) => {
    const entry = weightEntrySchema.safeParse({ model, weight });
    if (!entry.success) throw new Error('aggregation_invalid_input');
    return retain(entry.data);
  }).sort((left, right) => compareKeys(left.model, right.model));
  const bytes = stableStringify({ version: 1, algorithm: actual.algorithm, diffSha256: actual.diffSha256, roles,
    thresholds: actual.thresholds, gating: { ...actual.gating, verificationModel: actual.gating.verificationModel ?? null },
    ...(modelWeights !== undefined ? { modelWeights } : {}), belowThresholdAppendix: actual.belowThresholdAppendix });
  return decodeAggregationInputs(bytes, actual.diffSha256);
}

/** Decode only the captured values. No defaults, filesystem, server weights or provider selection. */
export function decodeAggregationInputs(bytes: string, expectedDiffSha256: string): CapturedAggregationInputs {
  bound(bytes);
  if (!digestSchema.safeParse(expectedDiffSha256).success) throw new Error('aggregation_invalid_expected_diff');
  let decoded: unknown;
  try { decoded = JSON.parse(bytes); } catch { throw new Error('aggregation_invalid_json'); }
  const parsed = wireSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('aggregation_invalid_document');
  if (stableStringify(parsed.data) !== bytes) throw new Error('aggregation_noncanonical_json');
  const wire = parsed.data;
  if (wire.diffSha256 !== expectedDiffSha256) throw new Error('aggregation_diff_mismatch');
  // Explicit null on wire freezes unavailable selection; runtime keeps the existing gating API.
  const captured: CapturedAggregationInputs = freeze({ ...wire, bytes, digest: sha256Hex(bytes),
    gating: { ...wire.gating, verificationModel: wire.gating.verificationModel ?? undefined } });
  capturedValues.add(captured);
  return captured;
}
