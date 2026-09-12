import { z } from 'zod';
import { buildEvent, type WireEvent } from '../telemetry/events.js';
import { MAX_FREE_TEXT } from '../telemetry/scrub.js';
import type { RunDetail } from './types.js';

export interface FindingRetriageInput {
  run: RunDetail;
  target: string;
  runId: string;
  reportSha256: string;
  findingRef: string;
  repository: string;
  prNumber: number;
  reason: string;
}

/** A new explicit judgment under the original report key, never a native-state repair. */
export function prepareFindingRetriage(input: FindingRetriageInput): WireEvent {
  const { run } = input;
  const require = (ok: boolean, message: string): void => { if (!ok) throw new Error(message); };
  require(z.uuid().safeParse(input.runId).success && run.id.toLowerCase() === input.runId.toLowerCase(),
    'Retriage run ID does not match server evidence.');
  require(run.target.kind === 'pr' || run.target.kind === 'patch', 'Retriage requires a PR-bound review.');
  require(run.target.repo?.toLowerCase() === input.repository.toLowerCase() && run.target.pr_number === input.prNumber,
    'Retriage repository/PR does not match server evidence.');
  require(typeof run.target.head_sha === 'string' && /^[a-f0-9]{40}$/i.test(run.target.head_sha),
    'Retriage requires a recorded review head.');
  require(/^[a-f0-9]{64}$/.test(input.reportSha256), 'Retriage report digest must be a lower-case SHA-256.');
  const reports = run.artifacts?.filter((a) => a.kind === 'report_json') ?? [];
  require(reports.length === 1 && reports[0]!.stored && reports[0]!.declared_sha256 === input.reportSha256,
    'Retriage requires one stored report with the selected digest.');
  require(input.target.length > 0 && input.target.length <= 200 && run.converge?.target === input.target,
    'Retriage target does not match server evidence.');
  const round = run.converge?.round;
  require(z.number().int().positive().max(2_147_483_647).safeParse(round).success, 'Retriage requires a recorded round.');
  require(input.findingRef.length > 0 && input.findingRef.length <= 32, 'Retriage finding ref is invalid.');
  const findings = run.findings.filter((f) => f.ref === input.findingRef);
  require(findings.length === 1, 'Retriage requires one exact finding ref.');
  const finding = findings[0]!;
  const key = finding.identity_key;
  // A legacy key can stand for unrelated sightings. Only this run's qualified
  // report key can carry a new judgment without guessing a canonical mapping.
  const prefix = `report:${run.id.toLowerCase()}:`;
  require(typeof key === 'string' && key.startsWith(prefix) && /^[a-f0-9]{16}$/.test(key.slice(prefix.length)),
    'Retriage requires a run-scoped report key; legacy or unqualified identities are not supported.');
  require(run.findings.filter((f) => f.identity_key === key).length === 1, 'Retriage refuses a colliding report key.');
  require(z.enum(['critical', 'important', 'minor', 'nitpick']).safeParse(finding.severity).success,
    'Retriage finding severity is invalid.');
  const reason = input.reason.trim();
  require(reason.length > 0 && reason.length <= MAX_FREE_TEXT, 'Retriage requires an explicit reason of 1 to 2000 characters.');

  const payload = {
    report_json_sha256: input.reportSha256,
    finding_ref: input.findingRef,
    verdicts: [{ identity_key: key!, verdict: 'dismissed', severity: finding.severity, reason }],
  };
  const event = buildEvent({ kind: 'verdicts_recorded', runId: run.id, convergeTarget: input.target, round: round!, payload });
  require(event.converge_target === input.target && JSON.stringify(event.payload) === JSON.stringify(payload),
    'Retriage refused: transport scrubbing would change the selected evidence or reason.');
  return event;
}
