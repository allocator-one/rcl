import { readTransientInput } from '../telemetry/transient-input.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter } from './adapter.js';
import { CheckpointJournal } from './checkpoint.js';
import { decodeCapturedInputs } from './captured-inputs.js';
import { openCapturedAsyncDelegate, readAsyncPhase, recordAsyncLateFailure, type AsyncDelegate } from './checkpoint-async-store.js';
import { executeCheckpointAsync } from './checkpoint-async-execution.js';
import { parseAsyncReview } from './checkpoint-async.js';
import { defaultAdapterFactory } from './runner.js';
import { asyncTargetKey, publishAsyncReview, resolveAsyncStoreDir, workerEnv } from './async-lane.js';

export const MAX_ASYNC_DELEGATE_BYTES = 16_384;
function refuse(): never { throw new Error('retained_async_invalid_delegation'); }

/** Bounded transient stdin; delegation secrets never appear in argv or a credential file. */
export async function readRetainedAsyncInput(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  return readTransientInput(stream, MAX_ASYNC_DELEGATE_BYTES);
}

/** Launch the existing detached lifecycle with only a restricted same-checkpoint capability. */
export async function launchRetainedAsyncWorkers(delegates: readonly AsyncDelegate[], onError: () => void,
  cliScript = fileURLToPath(new URL('../index.js', import.meta.url))): Promise<number> {
  const payloads = delegates.map(delegate => {
    let bytes: string | undefined;
    try { bytes = JSON.stringify(delegate); } catch { refuse(); }
    if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > MAX_ASYNC_DELEGATE_BYTES) refuse();
    return bytes;
  });
  const launches = payloads.map(async bytes => {
    let errorReported = false;
    const reportErrorOnce = () => { if (!errorReported) { errorReported = true; onError(); } };
    try {
      const child = spawn(process.execPath, [...(/\.[cm]?ts$/.test(cliScript) ? ['--import', import.meta.resolve('tsx')] : []), cliScript, 'retained-async-worker'], {
        detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: workerEnv(),
      });
      const spawned = new Promise<boolean>(resolve => {
        let settled = false;
        child.once('spawn', () => { if (!settled) { settled = true; resolve(true); } });
        child.on('error', () => { reportErrorOnce(); if (!settled) { settled = true; resolve(false); } });
      });
      child.stdin.on('error', reportErrorOnce); child.stdin.end(bytes); child.unref();
      return await spawned ? 1 : 0;
    } catch { reportErrorOnce(); return 0; }
  });
  return (await Promise.all(launches)).reduce<number>((total, value) => total + value, 0);
}

/** Run one delegated async call; ordinary opinions remain derivative of durable original accounting. */
export async function runRetainedAsyncWorker(bytes: string, dependencies: {
  adapterFactory?: (provider: string) => ReviewAdapter;
  publish?: (review: ModelReview) => Promise<void>;
} = {}): Promise<void> {
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > MAX_ASYNC_DELEGATE_BYTES || Buffer.from(bytes).toString('utf8') !== bytes) refuse();
  let delegate: AsyncDelegate; try { delegate = JSON.parse(bytes); } catch { return refuse(); }
  const original = await openCapturedAsyncDelegate(delegate);
  const journal = await CheckpointJournal.inspectRead(delegate.checkpointPath);
  const captured = decodeCapturedInputs((await journal.readBindings())['captured-inputs']!, journal.getPlan());
  // This immutable private phase binding was proven under original native ownership.
  // A pending launch need not have a runId, and later rounds cannot redirect it.
  const opinionTarget = asyncTargetKey('', delegate.target, original.opinionCycle.cycleId ?? undefined);
  let latest: ModelReview | undefined;
  await executeCheckpointAsync({ delegate,
    adapterFactory: call => (dependencies.adapterFactory ?? (provider => defaultAdapterFactory(provider, captured.config.reasoningEffort)))(call.provider),
    onLateAuditError: (_error, attemptId) => recordAsyncLateFailure(delegate, attemptId), onReviewRecorded: async review => { latest = review; },
  });
  const durable = (await readAsyncPhase({ commonDir: delegate.commonDir, namespace: delegate.namespace,
    plan: journal.getPlan() })).state.outcomes.filter(outcome => outcome.callIndex === delegate.callIndex).at(-1);
  if (durable) latest = structuredClone(parseAsyncReview(durable.reviewBytes, original.call.ref)) as ModelReview;
  if (latest) {
    const publish = dependencies.publish ?? (async review => publishAsyncReview(await resolveAsyncStoreDir(delegate.commonDir), opinionTarget, review));
    await publish(latest);
  }
  // The hidden command exits here even if an adapter ignored abort. Unknown
  // intents remain possibly billed; no provider retry or fabricated opinion.
}
