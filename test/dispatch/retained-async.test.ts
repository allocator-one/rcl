import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn,
}));

import { launchRetainedAsyncWorkers } from '../../src/dispatch/retained-async.js';
import type { AsyncDelegate } from '../../src/dispatch/checkpoint-async-store.js';

function delegate(): AsyncDelegate {
  return {
    version: 1, commonDir: '/tmp/repo', namespace: 'run', target: 'repo#1',
    checkpointPath: '/tmp/repo/checkpoint', planDigest: 'a'.repeat(64), callIndex: 0, token: 'b'.repeat(64),
  };
}

function child(event: 'spawn' | 'error') {
  const process = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
    unref: ReturnType<typeof vi.fn>;
  };
  process.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  process.unref = vi.fn();
  queueMicrotask(() => process.emit(event, event === 'error' ? new Error('synthetic spawn failure') : undefined));
  return process;
}

afterEach(() => vi.clearAllMocks());

describe('retained async worker launch accounting', () => {
  it('counts a worker only after the child reports a successful spawn', async () => {
    const spawned = child('spawn');
    spawn.mockReturnValueOnce(spawned);
    const onError = vi.fn();

    await expect(launchRetainedAsyncWorkers([delegate()], onError, '/tmp/rcl.js')).resolves.toBe(1);

    expect(onError).not.toHaveBeenCalled();
    expect(spawned.stdin.end).toHaveBeenCalledOnce();
    expect(spawned.unref).toHaveBeenCalledOnce();
    spawned.stdin.emit('error', new Error('synthetic stdin failure'));
    expect(onError).toHaveBeenCalledOnce();
  });

  it('reports an asynchronous spawn error without counting the worker', async () => {
    const failed = child('error');
    spawn.mockReturnValueOnce(failed);
    const onError = vi.fn();

    await expect(launchRetainedAsyncWorkers([delegate()], onError, '/tmp/rcl.js')).resolves.toBe(0);

    expect(onError).toHaveBeenCalledOnce();
    expect(failed.stdin.end).toHaveBeenCalledOnce();
    expect(failed.unref).toHaveBeenCalledOnce();
    failed.emit('spawn');
    failed.stdin.emit('error', new Error('synthetic stdin failure'));
    expect(onError).toHaveBeenCalledOnce();
  });
});
