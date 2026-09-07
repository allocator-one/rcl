import { uuidv7 } from '../report/uuid.js';
import { scrubDeep } from './scrub.js';

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

/**
 * Build one event. Ids are minted here and travel with the event into the
 * outbox, so a spooled retry re-sends the same id.
 */
export function buildEvent(input: EventInput): WireEvent {
  const now = input.now ?? new Date();
  return {
    id: uuidv7(now.getTime()),
    kind: input.kind,
    ...(input.convergeTarget !== undefined ? { converge_target: input.convergeTarget } : {}),
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
  if (event.kind === 'attempt_claimed') return event.attempt !== undefined;
  if (!RUN_BOUND_KINDS.has(event.kind)) return true;
  return typeof event.run_id === 'string' && event.run_id !== '' && event.round !== undefined;
}
