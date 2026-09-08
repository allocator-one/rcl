import { describeOutcome } from '../telemetry/sink.js';
import { formatRun } from './format.js';
import { EVIDENCE_EXIT, openSink, type EvidenceDeps } from './status.js';

/**
 * `rcl evidence show <run-id>` (RCL-41): one recorded run as Harness holds
 * it — header, verification, reviewer health, artifact state, findings with
 * their identity, gating reason and (once the server joins it) verdict.
 * Exit 0 when the run was read, 2 without a run id, 3 when it could not be.
 */
export async function runEvidenceShow(runId: string, options: { json?: boolean }, deps: EvidenceDeps): Promise<number> {
  const id = (runId ?? '').trim();
  if (id === '') {
    deps.stderr('Name the run id: `run.id` in a report, or the id in an `Evidence recorded:` URL.');
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
    deps.stdout(JSON.stringify(outcome.value, null, 2));
  } else {
    for (const line of formatRun(outcome.value)) deps.stdout(line);
  }
  return EVIDENCE_EXIT.converged;
}
