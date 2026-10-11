import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { MAX_DISPATCHES_PER_CELL, runJournaledCouncil, type JournaledRunnerOptions } from '../../src/dispatch/journaled-council.js';
import type { ReviewAdapter } from '../../src/dispatch/adapter.js';
import type { ModelReview } from '../../src/consensus/types.js';
import type { ReviewAssignment } from '../../src/roles/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const target = 'allocator-one/allocator-one#9129';
const PROVIDERS = ['anthropic', 'openai', 'google'] as const;

/** RCL-80's shape is 12 chunks x 17 blocking seats = 204 chunk-major calls; smaller councils keep the rest fast. */
function council(CHUNKS = 12, SEATS = 17) {
  const seats: ReviewAssignment[] = Array.from({ length: SEATS }, (_, seat) => {
    const provider = PROVIDERS[seat % PROVIDERS.length]!;
    return { model: `${provider}/seat-${seat}`, provider,
      role: { name: 'general', systemPrompt: 'system', focus: [], description: 'fixture', isSpecialized: false } };
  });
  const assignments = Array.from({ length: CHUNKS }, () => seats).flat();
  const prompts = Array.from({ length: CHUNKS }, (_, chunk) => seats.map(() => ({ systemPrompt: 'system', userPrompt: `chunk-${chunk}` }))).flat();
  const plan = freezeCheckpointPlan({ version: 2, target, headSha: '0'.repeat(40), mergeBaseSha: '1'.repeat(40),
    patchSha256: hash('patch'), configSha256: hash('config'), specSha256: hash('spec'), contextSha256: hash('context'),
    toolsSha256: hash('tools'), parser: { name: 'findings-json', version: 1 },
    roster: seats.map((seat, index) => ({ seat: `s${index}`, model: seat.model, role: 'general', route: seat.provider, lane: 'blocking' as const })),
    chunks: Array.from({ length: CHUNKS }, (_, index) => ({ index, total: CHUNKS, digest: hash(`chunk-${index}`) })),
    prompts: Array.from({ length: CHUNKS }, (_, chunk) => seats.map((_, seat) => ({ seat: `s${seat}`, chunk,
      systemSha256: hash('system'), userSha256: hash(`chunk-${chunk}`) }))).flat(),
  });
  return { assignments, prompts, plan, CHUNKS, SEATS };
}

const key = (model: string, userPrompt: string) => `${model}|${userPrompt}`;
const review = (model: string, provider: string, userPrompt: string): ModelReview => ({ model, role: 'general', provider,
  status: 'success', durationMs: 1, findings: [{ id: `${model}-${userPrompt}`, file: 'src/a.ts', startLine: 1, endLine: 1,
    severity: 'minor', category: 'correctness', title: `Finding from ${model} on ${userPrompt}`, description: 'fixture' }] });

/** Fake providers that count calls per cell and in-flight calls per provider. */
function providers(options: { hang?: (cell: string) => boolean; onStart?: (calls: number) => void } = {}) {
  const calls = new Map<string, number>();
  const inFlight = new Map<string, number>();
  let total = 0, peak = 0;
  const peaks = new Map<string, number>();
  const factory = (provider: string): ReviewAdapter => ({ name: provider, provider, ask: async () => { throw new Error('unused'); },
    review: async (model, _role, _system, userPrompt, adapterOptions) => {
      const cell = key(model, userPrompt);
      calls.set(cell, (calls.get(cell) ?? 0) + 1);
      inFlight.set(provider, (inFlight.get(provider) ?? 0) + 1);
      peaks.set(provider, Math.max(peaks.get(provider) ?? 0, inFlight.get(provider)!));
      peak = Math.max(peak, [...inFlight.values()].reduce((sum, value) => sum + value, 0));
      options.onStart?.(++total);
      try {
        if (options.hang?.(cell)) {
          await new Promise((_resolve, reject) => adapterOptions.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        }
        await new Promise(resolve => setTimeout(resolve, 1));
        return review(model, provider, userPrompt);
      } finally { inFlight.set(provider, inFlight.get(provider)! - 1); }
    } });
  return { factory, calls, peaks, peak: () => peak };
}

type Council = ReturnType<typeof council>;
async function withJournal<T>(commonDir: string, create: boolean, work: (journal: CheckpointJournal, ownership: Parameters<Parameters<typeof withNativeTarget>[2]>[0]) => Promise<T>, { plan }: Council = council()): Promise<T> {
  return withNativeTarget(commonDir, target, async ownership => {
    const open = { commonDir, namespace: 'ordinary-fixture', plan, ownership };
    return work(await (create ? CheckpointJournal.create(open) : CheckpointJournal.openWrite(open)), ownership);
  });
}

function runner(adapterFactory: (provider: string) => ReviewAdapter, overrides: Partial<JournaledRunnerOptions> = {}, cells = 12 * 17): JournaledRunnerOptions {
  return { timeoutMs: 5_000, maxRetries: 0, concurrency: 9, providerConcurrency: { anthropic: 2 },
    quorum: { fraction: 2 / 3, blocking: Array.from({ length: cells }, () => true) }, adapterFactory, ...overrides };
}

async function commonDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'rcl-journaled-council-')); roots.push(path);
  return path;
}

describe('journaled ordinary council (RCL-80)', () => {
  it('resumes an interrupted 12x17 council without repeating any successful call', async () => {
    const dir = await commonDir(), { assignments, prompts, CHUNKS, SEATS } = council();
    const abort = new AbortController();
    const first = providers({ onStart: started => { if (started === 80) abort.abort(); } });
    const interrupted = await withJournal(dir, true, (journal, ownership) => runJournaledCouncil({ journal, ownership,
      assignments, prompts, runner: runner(first.factory, { signal: abort.signal }) }));
    expect(interrupted.interrupted).toBe(true);
    expect(first.peaks.get('anthropic')).toBeLessThanOrEqual(2);
    expect(first.peak()).toBeLessThanOrEqual(9);
    const firstSuccesses = new Set(interrupted.reviews.flatMap((item, index) =>
      item.status === 'success' ? [key(assignments[index]!.model, prompts[index]!.userPrompt)] : []));
    expect(firstSuccesses.size).toBeGreaterThan(40);

    const second = providers();
    const resumed = await withJournal(dir, false, (journal, ownership) => runJournaledCouncil({ journal, ownership,
      assignments, prompts, runner: runner(second.factory) }));
    expect(resumed.interrupted).toBe(false);
    expect(resumed.retained).toBe(firstSuccesses.size);
    for (const cell of firstSuccesses) expect(second.calls.has(cell)).toBe(false);
    for (const [cell, count] of second.calls) expect(count + (first.calls.get(cell) ?? 0)).toBeLessThanOrEqual(MAX_DISPATCHES_PER_CELL);
    expect(second.peaks.get('anthropic')).toBeLessThanOrEqual(2);
    const completeSeats = assignments.slice(0, SEATS).filter((seat, index) =>
      Array.from({ length: CHUNKS }, (_, chunk) => resumed.reviews[chunk * SEATS + index]!).every(item => item.status === 'success'));
    expect(completeSeats.length).toBeGreaterThanOrEqual(12);
    expect((await withJournal(dir, false, journal => journal.read())).finalized).toBe(true);
  }, 180_000);

  it('records the same successful evidence as an uninterrupted wait-for-all council', async () => {
    const small = council(3, 6), { assignments, prompts } = small, all = { quorum: { fraction: 1, blocking: assignments.map(() => true) } };
    const baselineDir = await commonDir();
    const baseline = await withJournal(baselineDir, true, (journal, ownership) => runJournaledCouncil({ journal, ownership,
      assignments, prompts, runner: runner(providers().factory, all) }), small);
    const dir = await commonDir(), abort = new AbortController();
    const first = providers({ onStart: started => { if (started === 9) abort.abort(); } });
    await withJournal(dir, true, (journal, ownership) => runJournaledCouncil({ journal, ownership, assignments, prompts,
      runner: runner(first.factory, { ...all, signal: abort.signal }) }), small);
    const second = providers();
    const resumed = await withJournal(dir, false, (journal, ownership) => runJournaledCouncil({ journal, ownership,
      assignments, prompts, runner: runner(second.factory, all) }), small);
    expect(resumed.reviews).toEqual(baseline.reviews);
    expect(resumed.dispatched + resumed.retained).toBe(assignments.length);
  }, 30_000);

  it('gives a call that was in flight at a hard kill exactly one more dispatch', async () => {
    const dir = await commonDir(), small = council(3, 6), { assignments, prompts } = small;
    const killed = 's0:0', killedKey = key(assignments[0]!.model, prompts[0]!.userPrompt);
    // A killed process leaves only the durable intent behind.
    await withJournal(dir, true, (journal, ownership) => journal.recordIntent(killed, { id: 'killed-call', kind: 'paid' }, ownership), small);
    const abort = new AbortController();
    const again = providers({ hang: cell => cell === killedKey, onStart: started => { if (started === 5) abort.abort(); } });
    await withJournal(dir, false, (journal, ownership) => runJournaledCouncil({ journal, ownership, assignments, prompts,
      runner: runner(again.factory, { signal: abort.signal }, assignments.length) }), small);
    expect(again.calls.get(killedKey)).toBe(1);

    const last = providers();
    const resumed = await withJournal(dir, false, (journal, ownership) => runJournaledCouncil({ journal, ownership,
      assignments, prompts, runner: runner(last.factory, {}, assignments.length) }), small);
    expect(last.calls.has(killedKey)).toBe(false);
    expect(resumed.reviews[0]).toMatchObject({ status: 'canceled', error: expect.stringContaining('possibly billed') });
    const records = (await withJournal(dir, false, journal => journal.read(), small)).records
      .filter(record => record.cell === killed && record.type === 'intent');
    expect(records).toHaveLength(MAX_DISPATCHES_PER_CELL);
  }, 30_000);

  it('reassembles a finished council from its journal without any provider call', async () => {
    const dir = await commonDir(), small = council(3, 6), { assignments, prompts } = small;
    const done = await withJournal(dir, true, (journal, ownership) => runJournaledCouncil({ journal, ownership,
      assignments, prompts, runner: runner(providers().factory, {}, assignments.length) }), small);
    const again = providers();
    const replay = await withJournal(dir, false, (journal, ownership) => runJournaledCouncil({ journal, ownership,
      assignments, prompts, runner: runner(again.factory, {}, assignments.length) }), small);
    expect(again.calls.size).toBe(0);
    expect(replay.dispatched).toBe(0);
    expect(replay.reviews.filter(item => item.status === 'success')).toEqual(done.reviews.filter(item => item.status === 'success'));
  }, 30_000);

  it('refuses a journal captured for different review inputs', async () => {
    const dir = await commonDir(), { plan } = council();
    await withJournal(dir, true, async () => {});
    const changed = freezeCheckpointPlan({ ...plan, patchSha256: hash('changed patch') });
    await expect(withNativeTarget(dir, target, ownership => CheckpointJournal.openWrite({ commonDir: dir,
      namespace: 'ordinary-fixture', plan: changed, ownership }))).rejects.toThrow('checkpoint_plan_mismatch');
  });
});
