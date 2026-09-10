import { uuidv7 } from '../report/uuid.js';
import { validateReportIdentityMappings, type ReportIdentityMapping } from '../converge/run-state.js';
import { scrubDeep, scrubIdentifier } from './scrub.js';

/**
 * Converge events (epic IO-12475, section 5.4): the rcl-converge commands
 * report what they did, each event carrying its own client id so a retried
 * batch never records anything twice. Round-bound kinds name the run of
 * their round — the server resolves the repository and PR from that run,
 * never from the client-defined converge target, which travels only as a
 * label.
 */

export type ConvergeEventKind =
  | 'attempt_claimed'
  | 'cap_changed'
  | 'round_processed'
  | 'verdicts_recorded'
  | 'resolution'
  | 'loss';

/** Kinds the server refuses without `run_id` (and `round`). */
export const RUN_BOUND_KINDS: ReadonlySet<ConvergeEventKind> = new Set([
  'round_processed',
  'verdicts_recorded',
  'resolution',
]);

export interface WireEvent {
  id: string;
  kind: ConvergeEventKind;
  converge_target?: string;
  run_id?: string;
  round?: number;
  attempt?: number;
  payload: Record<string, unknown>;
  occurred_at: string;
}

export interface EventInput {
  kind: ConvergeEventKind;
  convergeTarget?: string;
  runId?: string;
  round?: number;
  attempt?: number;
  payload?: Record<string, unknown>;
  now?: Date;
}

/** One classified sighting of a round, as `round_processed` reports it (RCL-47). */
export interface RoundIdentity {
  /** The finding's own key as the report carries it — what the server stored for the finding. */
  identity_key: string;
  /** The identity `converge-report` matched the sighting to (its own key when new). */
  matched_identity: string;
  status: 'new' | 'repeat' | 'suppressed' | 'regating';
  suppress_reason?: string;
}

/**
 * The per-finding classification of a round for the `round_processed`
 * payload: the server applies a standing verdict to a sighting whose key
 * moved with the code only when it knows which identity rcl matched it to
 * (IO-12601). A finding without an identity in the report (pre-3.0) is
 * reported under the matched identity itself. Identical mappings share one
 * entry; conflicting mappings cannot be represented by the key-only protocol.
 */
export function roundIdentities(
  findings: readonly ReportIdentityMapping[]
): RoundIdentity[] {
  validateReportIdentityMappings(findings);
  const seen = new Set<string>();
  const out: RoundIdentity[] = [];
  for (const f of findings) {
    // An absent or blank report key (a pre-3.0 report) falls back to the matched identity.
    const key = f.finding.identity?.trim() || f.identity;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      identity_key: key,
      matched_identity: f.identity,
      status: f.status,
      ...(f.suppressReason ? { suppress_reason: f.suppressReason } : {}),
    });
  }
  return out;
}

/**
 * Build one event. Ids are minted here and travel with the event into the
 * outbox, so a spooled retry re-sends the same id.
 */
export function buildEvent(input: EventInput): WireEvent {
  const now = input.now ?? new Date();
  return {
    id: uuidv7(now.getTime()),
    kind: input.kind,
    // The target is a slug the loop chose; it still passes the key scrubber.
    ...(input.convergeTarget !== undefined ? { converge_target: scrubIdentifier(input.convergeTarget) } : {}),
    ...(input.runId !== undefined ? { run_id: input.runId } : {}),
    ...(input.round !== undefined ? { round: input.round } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    payload: scrubDeep(input.payload ?? {}),
    occurred_at: now.toISOString(),
  };
}

/**
 * Whether the server can take this event: a run-bound kind without the run
 * id of its round (a pre-3.0 report, or a round the state never recorded)
 * would be refused, so it is not worth sending.
 */
export function deliverable(event: WireEvent): boolean {
  const counter = (n: number | undefined) => n === undefined || (Number.isSafeInteger(n) && n >= 1);
  if (!counter(event.round) || !counter(event.attempt)) return false;
  // A run id that is not a UUID would be refused by the server and could
  // poison the batch it travels in.
  if (event.run_id !== undefined && !UUID.test(event.run_id)) return false;
  if (event.kind === 'attempt_claimed') return event.attempt !== undefined;
  if (!RUN_BOUND_KINDS.has(event.kind)) return true;
  return event.run_id !== undefined && event.round !== undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
