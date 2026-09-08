import { describeOutcome } from '../telemetry/sink.js';
import { formatRun, safeJson, text } from './format.js';

// Run ids are UUIDs (v7 live, v5 backfill); anything else never reaches the network or the terminal raw.
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { EVIDENCE_EXIT, openSink, type EvidenceDeps } from './status.js';

/**
 * `rcl evidence show <run-id>` (RCL-41): one recorded run as Harness holds
 * it — header, verification, reviewer health, artifact state, findings with
 * their identity, gating reason and (once the server joins it) verdict.
 * Exit 0 when the run was read (`EVIDENCE_EXIT.ok`), 2 without a run id, 3 when it could not be.
 */
export async function runEvidenceShow(runId: string, options: { json?: boolean }, deps: EvidenceDeps): Promise<number> {
  // UUIDs are case-insensitive text; the server echoes the canonical lowercase form.
  const id = (runId ?? '').trim().toLowerCase();
  if (id === '') {
    deps.stderr('Name the run id: `run.id` in a report, or the id in an `Evidence recorded:` URL.');
    return EVIDENCE_EXIT.usage;
  }
  if (!RUN_ID.test(id)) {
    deps.stderr(`Not a run id (a UUID): ${text(id, 80)}`);
    return EVIDENCE_EXIT.usage;
  }

  const sink = await openSink(deps);
  if (!sink) return EVIDENCE_EXIT.unanswered;

  const outcome = await sink.getRun(id);
  if (outcome.kind !== 'ok') {
    deps.stderr(`Cannot read run ${id}: ${describeOutcome(outcome)}`);
    return EVIDENCE_EXIT.unanswered;
  }

  if (options.json) {
    deps.stdout(safeJson(outcome.value));
  } else {
    for (const line of formatRun(outcome.value)) deps.stdout(line);
  }
  return EVIDENCE_EXIT.ok;
}
