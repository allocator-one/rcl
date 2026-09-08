import type { HarnessSink, RequestOptions, SinkOutcome } from '../telemetry/sink.js';
import { isGateStatus, isRunDetail, type GateStatus, type RunDetail } from './types.js';

/**
 * The two evidence reads (epic IO-12475, section 9) on top of the sink's
 * generic GET: each names what it asked for, so an answer about another pull
 * request or run — or one shaped wrong — is refused, never trusted.
 */

/** `GET /api/v1/reviews/prs/:owner/:repo/:number` — the gate status Harness computed for a pull request. */
export function getGateStatus(
  sink: HarnessSink,
  owner: string,
  repo: string,
  number: number,
  options: RequestOptions = {}
): Promise<SinkOutcome<GateStatus>> {
  const path = `/api/v1/reviews/prs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}`;
  return sink.getJson(path, (data) => (isGateStatus(data, `${owner}/${repo}`, number) ? data : null), options);
}

/** `GET /api/v1/reviews/runs/:id` — one recorded run with its findings, calls and artifact state. */
export function getRun(sink: HarnessSink, id: string, options: RequestOptions = {}): Promise<SinkOutcome<RunDetail>> {
  return sink.getJson(`/api/v1/reviews/runs/${encodeURIComponent(id)}`, (data) => (isRunDetail(data, id) ? data : null), options);
}
