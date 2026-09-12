import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describeOutcome } from '../telemetry/sink.js';
import { MAX_FREE_TEXT } from '../telemetry/scrub.js';
import { prepareFindingRetriage } from './finding-retriage.js';
import { safeJson, text } from './format.js';
import { getRun } from './reads.js';
import { EVIDENCE_EXIT, openSink, type EvidenceDeps } from './status.js';
import { parsePullRequestArg } from './target.js';

export interface FindingRetriageOptions {
  target: string;
  run: string;
  reportSha256: string;
  findingRef: string;
  forPr: string;
  reasonFile: string;
  submit?: boolean;
}

/** Preview or send one fresh verdict; no native writes, review, outbox or historical replay. */
export async function runFindingRetriage(options: FindingRetriageOptions, deps: EvidenceDeps): Promise<number> {
  let pr;
  let reason: string;
  try {
    pr = parsePullRequestArg(options.forPr, null);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.run) ||
        !/^[a-f0-9]{64}$/.test(options.reportSha256)) throw new Error('Retriage requires an explicit run UUID and lower-case report SHA-256.');
    reason = new TextDecoder('utf-8', { fatal: true })
      .decode(await readFile(resolve(deps.cwd ?? process.cwd(), options.reasonFile))).trim();
    if (!reason || reason.length > MAX_FREE_TEXT) throw new Error('Retriage requires an explicit reason of 1 to 2000 characters.');
  } catch (err) {
    deps.stderr(text(err instanceof Error ? err.message : String(err), 400));
    return EVIDENCE_EXIT.usage;
  }

  const sink = await openSink(deps);
  if (!sink) return EVIDENCE_EXIT.unanswered;
  const run = await getRun(sink, options.run);
  if (run.kind !== 'ok') {
    deps.stderr(`Cannot read retriage run: ${describeOutcome(run)}`);
    return EVIDENCE_EXIT.unanswered;
  }

  let event;
  try {
    event = prepareFindingRetriage({ run: run.value, target: options.target, runId: options.run,
      reportSha256: options.reportSha256, findingRef: options.findingRef,
      repository: `${pr.owner}/${pr.repo}`, prNumber: pr.number, reason });
  } catch (err) {
    deps.stderr(text(err instanceof Error ? err.message : String(err), 400));
    return EVIDENCE_EXIT.usage;
  }

  if (!options.submit) {
    deps.stdout(`Preview for ${text(new URL(sink.baseUrl).host, 200)}: no verdict submitted. Use --submit to record this new judgment.`);
    deps.stdout(safeJson(event));
    deps.stdout('The digest matches stored report metadata; original report bytes were not retrieved or verified. Native history is unchanged.');
    return EVIDENCE_EXIT.ok;
  }

  const result = await sink.postEvents([event]);
  if (result.kind !== 'ok') {
    deps.stderr(`Verdict not acknowledged: ${describeOutcome(result)}. No retry or outbox flush was performed. Inspect server evidence before retrying.`);
    return EVIDENCE_EXIT.unanswered;
  }
  if (result.value.inserted !== 1 || result.value.duplicates !== 0) {
    deps.stderr('A fresh verdict insertion was not acknowledged. Inspect server evidence before retrying.');
    return EVIDENCE_EXIT.unanswered;
  }
  deps.stdout(`Verdict acknowledged: ${result.value.inserted} inserted, ${result.value.duplicates} duplicate. This is not a convergence verdict; check evidence status separately.`);
  return EVIDENCE_EXIT.ok;
}
