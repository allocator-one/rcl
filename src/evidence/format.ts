import type { GateStatus, Projection, RunDetail } from './types.js';

/** Terminal rendering of what Harness holds; one line per entry, no colour, safe to grep. */

function short(sha: string | null | undefined): string {
  return typeof sha === 'string' && sha.length > 0 ? sha.slice(0, 10) : '—';
}

function projectionLines(name: string, projection: Projection, judged: boolean): string[] {
  const lines = [
    `${name}: ${projection.status}${projection.conclusive ? '' : ' (inconclusive)'}${judged ? ' ← judged' : ''}` +
      (projection.run_id ? ` — run ${short(projection.run_id)}${projection.run_url ? ` ${projection.run_url}` : ''}` : ''),
  ];
  for (const round of projection.rounds) {
    lines.push(
      `  round ${round.converge_round ?? '·'}: ${short(round.id)} head ${short(round.head_sha)} ${round.tier}` +
        `${round.received_at ? ` ${round.received_at}` : ''}${round.url ? ` ${round.url}` : ''}`
    );
  }
  for (const finding of projection.actionable) {
    const where = finding.file ? `${finding.file}${finding.start_line !== null ? `:${finding.start_line}` : ''}` : '—';
    lines.push(
      `  actionable ${finding.identity_key ?? finding.ref ?? '?'} ${finding.severity}/${finding.gating_reason} ${where} ${finding.title}`
    );
  }
  return lines;
}

export function formatGateStatus(status: GateStatus, judged: 'advisory' | 'enforced'): string[] {
  const head = status.head;
  const headLine =
    head === null
      ? `${status.repo}#${status.pr_number} — no head known to Harness`
      : `${status.repo}#${status.pr_number} — head ${short(head.sha)}${head.source ? ` (${head.source})` : ''}` +
        `${head.merged ? ` — merged${head.merge_commit_sha ? ` as ${short(head.merge_commit_sha)}` : ''}` : ''}` +
        `${head.is_cross_repository ? ' — fork' : ''}`;
  const decision = status.decision;
  return [
    headLine,
    ...projectionLines('advisory', status.advisory, judged === 'advisory'),
    ...projectionLines('enforced', status.enforced, judged === 'enforced'),
    decision
      ? `decision: ${decision.decision} at ${short(decision.reviewed_head_sha)} (${decision.source}` +
        `${decision.merged_at ? `, merged ${decision.merged_at}` : ''})`
      : 'decision: —',
  ];
}

function reviewerHealth(run: RunDetail): string {
  const stats = run.stats ?? {};
  const total = stats['totalReviews'];
  const ok = stats['successfulReviews'];
  if (typeof total === 'number' && typeof ok === 'number') return `${ok}/${total}`;
  return `${run.calls.filter((call) => call.status === 'success').length}/${run.calls.length}`;
}

export function formatRun(run: RunDetail): string[] {
  const runner = run.runner ?? {};
  const runnerKind = typeof runner['kind'] === 'string' ? runner['kind'] : '—';
  const ciRunId = typeof runner['ci_run_id'] === 'string' ? ` ${runner['ci_run_id']}` : '';
  const target = run.target;
  const named = target.repo && target.pr_number ? `${target.repo}#${target.pr_number}` : target.kind;
  const converge = run.converge;
  const lines = [
    `run ${run.id}${run.url ? ` ${run.url}` : ''}`,
    `target ${named} @ ${short(target.head_sha)} (head ${run.head_verified ?? 'unknown'}${run.repo_verified ? ', repo verified' : ''}` +
      `${run.is_cross_repository ? ', fork' : ''})`,
    `credential ${run.credential_kind ?? '—'} (${run.tier ?? 'asserted'}) — runner ${runnerKind}${ciRunId} — rcl ${run.rcl_version ?? '—'}` +
      (run.provenance && run.provenance !== 'live' ? ` — ${run.provenance}` : ''),
    `reviewers ${reviewerHealth(run)} ok` +
      (converge ? ` — converge ${converge.target}${converge.round !== null && converge.round !== undefined ? ` round ${converge.round}` : ''}` : '') +
      (run.received_at ? ` — received ${run.received_at}` : ''),
  ];
  for (const artifact of run.artifacts ?? []) {
    lines.push(`artifact ${artifact.kind} ${artifact.stored ? 'stored' : 'missing'}${artifact.url ? ` ${artifact.url}` : ''}`);
  }
  lines.push(`findings (${run.findings.length}): identity severity gating file:line title — verdict`);
  for (const finding of run.findings) {
    const where = finding.file ? `${finding.file}${finding.start_line !== null ? `:${finding.start_line}` : ''}` : '—';
    const verdict = finding.verdict
      ? `${finding.verdict.verdict}${finding.verdict.round !== null && finding.verdict.round !== undefined ? ` (round ${finding.verdict.round})` : ''}`
      : '—';
    lines.push(
      `  ${finding.identity_key ?? finding.ref ?? '?'} ${finding.severity} ${finding.gating_reason ?? 'none'} ${where} ${finding.title} — ${verdict}`
    );
  }
  lines.push(`calls (${run.calls.length}):`);
  for (const call of run.calls) {
    const duration = typeof call.duration_ms === 'number' ? ` ${call.duration_ms}ms` : '';
    lines.push(`  call ${call.model}${call.role ? ` ${call.role}` : ''} ${call.status}${duration}${call.error ? ` — ${call.error}` : ''}`);
  }
  return lines;
}
