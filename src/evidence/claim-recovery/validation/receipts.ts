import { isDeepStrictEqual } from 'node:util';
import { decodeOriginalReport } from '../../original-run/decode.js';
import { instant, object, normalizeUrl, uuidSchema } from './primitives.js';

const MAX_READ_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface EventReceiptScope {
  base_url: string;
  org_id: string;
  run_id: string;
  repo: string;
  pr_number: number;
}

export interface EventReceipt extends Omit<EventReceiptScope, 'base_url'> {
  id: string;
  actor_user_id: string | null;
  kind: string;
  converge_target: string | null;
  round: number | null;
  attempt: number | null;
  occurred_at: string;
  payload: Record<string, unknown>;
}

const uuid = (value: unknown): value is string => uuidSchema.safeParse(value).success;
export const positiveCounter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const kind = (value: unknown): value is string => typeof value === 'string' && /^[a-z_]{1,64}$/.test(value);
const scopeFields = ['org_id', 'run_id', 'repo', 'pr_number'] as const;
const eventFields = ['id', 'kind', 'run_id', 'converge_target', 'round', 'attempt', 'payload', 'occurred_at'];

export function isEventReceiptScope(value: EventReceiptScope): boolean {
  return typeof value.base_url === 'string' && normalizeUrl(value.base_url) === value.base_url &&
    uuid(value.org_id) && uuid(value.run_id) && typeof value.repo === 'string' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repo) && positiveCounter(value.pr_number);
}

function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (Array.isArray(value)) return value.every(item => jsonValue(item, depth + 1));
  return object(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(item => jsonValue(item, depth + 1));
}

/** Validate normalized event fields without asserting server acceptance. */
export function isEventReceipt(raw: unknown, scope: EventReceiptScope): raw is EventReceipt {
  if (!isEventReceiptScope(scope) || !object(raw) || !scopeFields.every(field => raw[field] === scope[field]) ||
      ![...scopeFields, ...eventFields, 'actor_user_id'].every(field => Object.hasOwn(raw, field)) ||
      !uuid(raw.id) || !(raw.actor_user_id === null || uuid(raw.actor_user_id)) || !kind(raw.kind) ||
      !(raw.converge_target === null || typeof raw.converge_target === 'string') ||
      !(raw.round === null || positiveCounter(raw.round)) || !(raw.attempt === null || positiveCounter(raw.attempt)) ||
      !object(raw.payload) || !jsonValue(raw.payload)) return false;
  try { instant(raw.occurred_at); return true; } catch { return false; }
}

/**
 * Match the normalized stored fields, including authenticated actor and full
 * timestamp precision. Optional wire fields become explicit database nulls;
 * payload absence/null and ordering remain distinct. Prepared bytes are read
 * without rewriting them, and this comparison never submits an event.
 */
export function matchesPreparedEventReceipt(
  raw: unknown, eventJson: string, scope: EventReceiptScope, actor: string
): boolean {
  try {
    if (!isEventReceiptScope(scope) || !uuid(actor) || !isEventReceipt(raw, scope) || raw.actor_user_id !== actor ||
        Buffer.byteLength(eventJson, 'utf8') > MAX_READ_RESPONSE_BYTES) return false;
    const { value: event, transformations } = decodeOriginalReport(eventJson, { exactNumbers: true });
    if (transformations.length || !object(event) || Object.keys(event).some(key => !eventFields.includes(key)) ||
        !uuid(event.id) || !kind(event.kind) || event.run_id !== scope.run_id || !positiveCounter(event.round) ||
        !object(event.payload) || !jsonValue(event.payload) ||
        !(event.converge_target === undefined || event.converge_target === null || typeof event.converge_target === 'string') ||
        !(event.attempt === undefined || event.attempt === null || positiveCounter(event.attempt))) return false;
    if (instant(raw.occurred_at) !== instant(event.occurred_at)) return false;
    return eventFields.filter(field => field !== 'occurred_at').every(field =>
      isDeepStrictEqual(raw[field as keyof EventReceipt], event[field] ?? null));
  } catch { return false; }
}

/** Server acceptance metadata is separate from the original wire assertion. */
export interface StoredEventReceipt extends EventReceipt {
  /** Positive safe-integer position in this run's stored event stream. */
  sequence: number;
  /** Exact server timestamp, retaining all supplied microsecond precision. */
  received_at: string;
}

/** Validate a selected API receipt, including its server-owned chronology. */
export function isStoredEventReceipt(raw: unknown, scope: EventReceiptScope): raw is StoredEventReceipt {
  if (!object(raw) || !isEventReceipt(raw, scope) || !Object.hasOwn(raw, 'sequence') ||
      !Object.hasOwn(raw, 'received_at') || !positiveCounter(raw.sequence)) return false;
  try { instant(raw.received_at); return true; } catch { return false; }
}
