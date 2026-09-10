import { resolveGitCommonDir } from '../converge/attempt-budget.js';
import { loadConvergeRunStateEvidence } from '../converge/run-state.js';
import { describeOutcome } from '../telemetry/sink.js';
import { prepareFindingRecovery } from './finding-recovery.js';
import { safeJson, text } from './format.js';
import { getRun } from './reads.js';
import { EVIDENCE_EXIT, openSink, type EvidenceDeps } from './status.js';
import { parsePullRequestArg } from './target.js';

export interface FindingRecoveryOptions {
  target: string;
  run: string;
  reportSha256: string;
  findingRef: string;
  identity: string;
  forPr: string;
  submit?: boolean;
}

/**
 * Preview by default; --submit sends only the correction. This explicit repair
 * never flushes/spools outbox entries, reruns a council, or changes native state.
 * A refused/uncertain submission remains a failure; an operator can retry the
 * same selection because the server also deduplicates by run and finding ref.
 */
export async function runFindingRecovery(options: FindingRecoveryOptions, deps: EvidenceDeps): Promise<number> {
  let pr;
  let evidence;
  try {
    pr = parsePullRequestArg(options.forPr, null);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.run) ||
        !/^[a-f0-9]{64}$/.test(options.reportSha256)) throw new Error('Recovery requires an explicit run UUID and lower-case report SHA-256.');
    evidence = await loadConvergeRunStateEvidence(await resolveGitCommonDir(deps.cwd), options.target);
    if (!evidence) throw new Error('No retained native state for this convergence target.');
  } catch (err) {
    deps.stderr(text(err instanceof Error ? err.message : String(err), 400));
    return EVIDENCE_EXIT.usage;
  }

  const sink = await openSink(deps);
  if (!sink) return EVIDENCE_EXIT.unanswered;
  const run = await getRun(sink, options.run);
  if (run.kind !== 'ok') {
    deps.stderr(`Cannot read recovery run: ${describeOutcome(run)}`);
    return EVIDENCE_EXIT.unanswered;
  }

  let event;
  try {
    event = prepareFindingRecovery({
      state: evidence.state, stateSha256: evidence.sha256, run: run.value, target: options.target,
      runId: options.run, reportSha256: options.reportSha256, findingRef: options.findingRef,
      identity: options.identity, repository: `${pr.owner}/${pr.repo}`, prNumber: pr.number,
    });
  } catch (err) {
    deps.stderr(text(err instanceof Error ? err.message : String(err), 400));
    return EVIDENCE_EXIT.usage;
  }

  if (!options.submit) {
    deps.stdout(`Preview for ${text(new URL(sink.baseUrl).host, 200)}: no correction submitted. Use --submit to send this assertion.`);
    deps.stdout(safeJson(event));
    deps.stdout('Harness must still validate the existing canonical verdict. Original report bytes were not retrieved or verified.');
    return EVIDENCE_EXIT.ok;
  }

  const result = await sink.postEvents([event]);
  if (result.kind !== 'ok') {
    deps.stderr(`Correction not acknowledged: ${describeOutcome(result)}. No retry or outbox flush was performed.`);
    return EVIDENCE_EXIT.unanswered;
  }
  deps.stdout(`Correction acknowledged: ${result.value.inserted} inserted, ${result.value.duplicates} duplicate. This is not a convergence verdict.`);
  return EVIDENCE_EXIT.ok;
}
