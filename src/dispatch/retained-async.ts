import { readTransientInput } from '../telemetry/transient-input.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter } from './adapter.js';
import { CheckpointJournal } from './checkpoint.js';
import { decodeCapturedInputs } from './captured-inputs.js';
import { openCapturedAsyncDelegate, type AsyncDelegate } from './checkpoint-async-store.js';
import { executeCheckpointAsync } from './checkpoint-async-execution.js';
import { defaultAdapterFactory } from './runner.js';
import { asyncTargetKey, publishAsyncReview, resolveAsyncStoreDir, workerEnv } from './async-lane.js';

export const MAX_ASYNC_DELEGATE_BYTES = 16_384;
function refuse(): never { throw new Error('retained_async_invalid_delegation'); }

/** Bounded transient stdin; delegation secrets never appear in argv or a credential file. */
export async function readRetainedAsyncInput(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  return readTransientInput(stream, MAX_ASYNC_DELEGATE_BYTES);
}

/** Launch the existing detached lifecycle with only a restricted same-checkpoint capability. */
export function launchRetainedAsyncWorkers(delegates: readonly AsyncDelegate[], onError: () => void,
  cliScript = fileURLToPath(new URL('../index.js', import.meta.url))): number {
  let launched = 0;
  for (const delegate of delegates) {
    const bytes = JSON.stringify(delegate); if (Buffer.byteLength(bytes) > MAX_ASYNC_DELEGATE_BYTES) refuse();
    try {
      const child = spawn(process.execPath, [...(/\.[cm]?ts$/.test(cliScript) ? ['--import', import.meta.resolve('tsx')] : []), cliScript, 'retained-async-worker'], {
        detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: workerEnv(),
      });
      child.on('error', onError); child.stdin.on('error', onError); child.stdin.end(bytes); child.unref(); launched++;
    } catch { onError(); }
  }
  return launched;
}

/** Run one delegated async call; ordinary opinions remain derivative of durable original accounting. */
export async function runRetainedAsyncWorker(bytes: string, dependencies: {
  adapterFactory?: (provider: string) => ReviewAdapter;
  publish?: (review: ModelReview) => Promise<void>;
} = {}): Promise<void> {
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > MAX_ASYNC_DELEGATE_BYTES || Buffer.from(bytes).toString('utf8') !== bytes) refuse();
  let delegate: AsyncDelegate; try { delegate = JSON.parse(bytes); } catch { return refuse(); }
  await openCapturedAsyncDelegate(delegate);
  const journal = await CheckpointJournal.inspectRead(delegate.checkpointPath);
  const captured = decodeCapturedInputs((await journal.readBindings())['captured-inputs']!, journal.getPlan());
  let latest: ModelReview | undefined;
  await executeCheckpointAsync({ delegate,
    adapterFactory: call => (dependencies.adapterFactory ?? (provider => defaultAdapterFactory(provider, captured.config.reasoningEffort)))(call.provider),
    onLateAuditError: () => {}, onReviewRecorded: async review => { latest = review; },
  });
  if (latest) {
    const publish = dependencies.publish ?? (async review => publishAsyncReview(await resolveAsyncStoreDir(delegate.commonDir), asyncTargetKey('', delegate.target), review));
    await publish(latest);
  }
  // The hidden command exits here even if an adapter ignored abort. Unknown
  // intents remain possibly billed; no provider retry or fabricated opinion.
}
