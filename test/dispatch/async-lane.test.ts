import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  partitionAsyncAssignments,
  asyncTargetKey,
  spoolAsyncCalls,
  runAsyncWorker,
  collectAsyncResults,
  workerEnv,
} from '../../src/dispatch/async-lane.js';
import type { ReviewAdapter } from '../../src/dispatch/adapter.js';
import type { Role, ReviewAssignment } from '../../src/roles/types.js';
import type { ModelReview } from '../../src/consensus/types.js';

function makeRole(name: string, isSpecialized = false): Role {
  return { name, systemPrompt: 'system', focus: [], description: name, isSpecialized };
}

function makeAssignment(model: string, role = 'general'): ReviewAssignment {
  return { model, provider: 'openrouter', role: makeRole(role) };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rcl-async-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('partitionAsyncAssignments', () => {
  it('splits assignments into blocking and async by model list', () => {
    const assignments = [
      makeAssignment('anthropic/claude-fable-5'),
      makeAssignment('openrouter/moonshotai/kimi-k3'),
      makeAssignment('openai/gpt-5.6-sol'),
    ];
    const { blocking, async } = partitionAsyncAssignments(assignments, [
      'openrouter/moonshotai/kimi-k3',
    ]);
    expect(blocking.map((a) => a.model)).toEqual([
      'anthropic/claude-fable-5',
      'openai/gpt-5.6-sol',
    ]);
    expect(async.map((a) => a.model)).toEqual(['openrouter/moonshotai/kimi-k3']);
  });

  it('returns everything as blocking when no async models are configured', () => {
    const assignments = [makeAssignment('anthropic/claude-fable-5')];
    const { blocking, async } = partitionAsyncAssignments(assignments, []);
    expect(blocking).toHaveLength(1);
    expect(async).toHaveLength(0);
  });
});

describe('asyncTargetKey', () => {
  it('is stable for the same target and differs across targets', () => {
    const a1 = asyncTargetKey('allocator-one/rcl#12');
    const a2 = asyncTargetKey('allocator-one/rcl#12');
    const b = asyncTargetKey('allocator-one/rcl#13');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it('produces filesystem-safe keys', () => {
    const key = asyncTargetKey('weird target/../../name with spaces#7');
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('workerEnv', () => {
  it('keeps provider credentials and basics, drops unrelated secrets', () => {
    const env = workerEnv({
      ANTHROPIC_API_KEY: 'a',
      OPENROUTER_API_KEY: 'o',
      GEMINI_API_KEY: 'g',
      OPENAI_BASE_URL: 'http://localhost',
      PATH: '/usr/bin',
      HOME: '/home/u',
      HTTPS_PROXY: 'http://proxy',
      GITHUB_TOKEN: 'gh-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      SSH_AUTH_SOCK: '/tmp/sock',
      NPM_TOKEN: 'npm-secret',
    });
    expect(env['ANTHROPIC_API_KEY']).toBe('a');
    expect(env['OPENROUTER_API_KEY']).toBe('o');
    expect(env['GEMINI_API_KEY']).toBe('g');
    expect(env['OPENAI_BASE_URL']).toBe('http://localhost');
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HTTPS_PROXY']).toBe('http://proxy');
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['SSH_AUTH_SOCK']).toBeUndefined();
    expect(env['NPM_TOKEN']).toBeUndefined();
  });
});

describe('spool → worker → collect round trip', () => {
  const spec = {
    model: 'openrouter/moonshotai/kimi-k3',
    role: 'general',
    provider: 'openrouter',
    systemPrompt: 'sys',
    userPrompt: 'user',
  };

  function fakeAdapter(findingsCount: number): ReviewAdapter {
    return {
      name: 'fake',
      provider: 'openrouter',
      review: async (model, role) => ({
        model,
        role,
        provider: 'openrouter',
        findings: Array.from({ length: findingsCount }, (_, i) => ({
          id: `f${i}`,
          file: 'a.ts',
          startLine: 1,
          endLine: 2,
          severity: 'important' as const,
          category: 'correctness' as const,
          title: `finding ${i}`,
          description: 'desc',
        })),
        durationMs: 5,
        status: 'success' as const,
      }),
      ask: async () => {
        throw new Error('not used');
      },
    };
  }

  it('worker consumes a spool file and writes a result the next collect merges, marked async', async () => {
    const targetKey = asyncTargetKey('repo#1');
    const spools = await spoolAsyncCalls([spec], {
      storeDir: dir,
      targetKey,
      timeoutMs: 1000,
      maxRetries: 0,
    });
    expect(spools).toHaveLength(1);

    await runAsyncWorker(spools[0]!, () => fakeAdapter(2));

    // Spool consumed, result present.
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith('pending-'))).toBe(false);
    expect(files.some((f) => f.startsWith('result-'))).toBe(true);

    const collected = await collectAsyncResults(dir, targetKey);
    expect(collected).toHaveLength(1);
    const review = collected[0]!;
    expect(review.model).toBe('openrouter/moonshotai/kimi-k3');
    expect(review.async).toBe(true);
    expect(review.status).toBe('success');
    expect(review.findings).toHaveLength(2);

    // Collect consumes: a second collect returns nothing.
    expect(await collectAsyncResults(dir, targetKey)).toHaveLength(0);
  });

  it('does not collect results belonging to a different target', async () => {
    const keyA = asyncTargetKey('repo#1');
    const keyB = asyncTargetKey('repo#2');
    const spools = await spoolAsyncCalls([spec], {
      storeDir: dir,
      targetKey: keyA,
      timeoutMs: 1000,
      maxRetries: 0,
    });
    await runAsyncWorker(spools[0]!, () => fakeAdapter(1));

    expect(await collectAsyncResults(dir, keyB)).toHaveLength(0);
    expect(await collectAsyncResults(dir, keyA)).toHaveLength(1);
  });

  it('returns empty on a missing store directory instead of throwing', async () => {
    const collected = await collectAsyncResults(join(dir, 'does-not-exist'), 'k');
    expect(collected).toEqual([]);
  });

  it('records a failed async call as a non-success review instead of losing it', async () => {
    const failing: ReviewAdapter = {
      name: 'fake',
      provider: 'openrouter',
      review: async () => {
        throw new Error('boom');
      },
      ask: async () => {
        throw new Error('not used');
      },
    };
    const targetKey = asyncTargetKey('repo#1');
    const spools = await spoolAsyncCalls([spec], {
      storeDir: dir,
      targetKey,
      timeoutMs: 1000,
      maxRetries: 0,
    });
    await runAsyncWorker(spools[0]!, () => failing);
    const collected = await collectAsyncResults(dir, targetKey);
    expect(collected).toHaveLength(1);
    expect(collected[0]!.status).toBe('error');
    expect(collected[0]!.async).toBe(true);
  });

  it('skips corrupt result files without aborting the collect', async () => {
    const targetKey = asyncTargetKey('repo#1');
    await writeFile(join(dir, `result-${targetKey}-corrupt.json`), '{not json');
    const spools = await spoolAsyncCalls([spec], {
      storeDir: dir,
      targetKey,
      timeoutMs: 1000,
      maxRetries: 0,
    });
    await runAsyncWorker(spools[0]!, () => fakeAdapter(1));
    const collected = await collectAsyncResults(dir, targetKey);
    expect(collected).toHaveLength(1);
  });
});
