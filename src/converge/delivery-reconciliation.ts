import { resolveGitCommonDir } from './attempt-budget.js';
import { loadConvergeRunState, writeState } from './run-state.js';
import { withNativeTarget } from './target-ownership.js';
import type { HarnessSink } from '../telemetry/sink.js';
import { getRun } from '../evidence/reads.js';

export async function reconcileDeliveredRun(runId: string, sink: HarnessSink, options: { cwd?: string; gitCommonDir?: string; getRun?: typeof getRun } = {}): Promise<'reconciled' | 'unchanged'> {
  const read = await (options.getRun ?? getRun)(sink, runId);
  if (read.kind !== 'ok') return 'unchanged';
  const detail = read.value, target = detail.converge?.target;
  if (!target || !/^[A-Za-z0-9._-]+$/.test(target) || detail.id.toLowerCase() !== runId.toLowerCase()) return 'unchanged';
  let common: string;
  try {
    common = options.gitCommonDir ?? await resolveGitCommonDir(options.cwd);
  } catch {
    return 'unchanged';
  }
  return withNativeTarget(common, target, async ownership => {
    const state = await loadConvergeRunState(common, target), launch = state?.lastLaunch;
    if (!state || !launch || launch.status !== 'completed' || !launch.deliveryPending ||
      launch.runId?.toLowerCase() !== runId.toLowerCase() ||
      detail.converge?.round !== launch.round || detail.converge?.attempt !== launch.attempt ||
      detail.target.head_sha !== launch.headSha ||
      !detail.artifacts?.some(artifact => artifact.kind === 'report_json' && artifact.stored && artifact.declared_sha256 === launch.reportJsonSha256)) return 'unchanged';
    state.lastLaunch = { ...launch, deliveryPending: false };
    state.updatedAt = new Date().toISOString();
    await writeState(common, state, ownership);
    return 'reconciled';
  });
}
