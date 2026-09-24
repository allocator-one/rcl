import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withNativeTarget, withRecoveryTarget } from '../../src/converge/target-ownership.js';
import { deliverPreparedClaimEvent, type ClaimEventDeliveryOptions } from '../../src/evidence/claim-recovery/delivery.js';
import type { StoredEventReceipt } from '../../src/evidence/event-receipts.js';
import { openJournal } from '../../src/evidence/original-run/journal.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { RecoveryRequestBudget } from '../../src/telemetry/recovery-request-budget.js';

const uuid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture(requestBudget?: RecoveryRequestBudget) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-claim-delivery-'))); dirs.push(dir);
  const scope = { base_url: 'https://synthetic.example.test', org_id: uuid(1), run_id: uuid(2), repo: 'synthetic/recovery', pr_number: 7 };
  const actor = uuid(3); const target = 'same-native-target'; const operationId = uuid(4); const manifestSha256 = 'a'.repeat(64);
  const event = { id: uuid(5), kind: 'finding_claim_split' as const, run_id: scope.run_id, converge_target: target, round: 2,
    occurred_at: '2026-09-22T22:00:00.123456Z', payload: { version: 1, matched_identity: '2222222222222222', previous_identity: '1111111111111111' } };
  const eventJson = JSON.stringify(event, null, 2) + '\n';
  const receipt = (): StoredEventReceipt => ({
    ...structuredClone(event), org_id: scope.org_id, repo: scope.repo,
    pr_number: scope.pr_number, actor_user_id: actor, attempt: null,
    sequence: 9, received_at: '2026-09-22T22:00:01.654321Z' });
  let stored: ReturnType<typeof receipt> | undefined; let loseAck = false; let readFailure = false; let badAck = false; let omitStorage = false;
  let omitReceiptMetadata = false; let rateLimitPost = false;
  let postObserver = () => {};
  const calls: string[] = []; const bodies: unknown[] = []; const checks: string[] = [];
  const sink = new HarnessSink({ credential: { url: scope.base_url, token: 'synthetic', source: 'login' }, rclVersion: 'test', requestBudget,
    fetchImpl: async (_url, request) => {
      const method = request?.method ?? 'GET'; calls.push(method);
      if (method === 'POST') {
        postObserver();
        // The exact packet must already be readable when the request starts.
        const packet = JSON.parse(await readFile(join(dir, 'event.json'), 'utf8'));
        expect(packet.event_json).toBe(eventJson);
        bodies.push(JSON.parse(String(request?.body)));
        if (!omitStorage) stored = receipt(); if (badAck) stored!.actor_user_id = uuid(9);
        if (rateLimitPost) return Response.json({}, { status: 429, headers: { 'Retry-After': '13' } });
        if (loseAck) throw new Error('synthetic connection lost after acceptance');
        return Response.json({ data: { inserted: 1, duplicates: 0 } });
      }
      if (readFailure) return Response.json({ error: 'unavailable' }, { status: 503 });
      const row = stored && omitReceiptMetadata ? { ...stored, sequence: undefined, received_at: undefined } : stored;
      return Response.json({ data: row ? [row] : [], meta: { org_id: scope.org_id, run_id: scope.run_id, claim_recovery_version: 1 } });
    } });
  const execute = async (mode: 'apply' | 'resume' = 'apply', changes: Partial<ClaimEventDeliveryOptions> = {}, failPhase?: string, ordinary = false) =>
    (ordinary ? withNativeTarget : withRecoveryTarget)(dir, target, async ownership => {
      const journal = await openJournal(join(dir, 'journal'), manifestSha256, operationId, mode,
        async phase => { if (phase === failPhase) throw new Error('synthetic checkpoint failure'); });
      return deliverPreparedClaimEvent({ gitCommonDir: dir, target, ownership, operationId, manifestSha256,
        packetPath: join(dir, 'event.json'), mode, scope, actor, eventJson, sink, journal,
        verifyContext: async () => { checks.push('fresh'); }, ...changes });
    });
  return { dir, scope, actor, target, event, eventJson, receipt, calls, bodies, checks, execute,
    rateLimitPost: () => { rateLimitPost = true; }, observePost: (fn: () => void) => { postObserver = fn; },
    accept: () => { stored = receipt(); }, loseAck: () => { loseAck = true; },
    omitReceiptMetadata: (omit = true) => { omitReceiptMetadata = omit; },
    failReads: () => { readFailure = true; }, badAck: () => { badAck = true; }, omitStorage: () => { omitStorage = true; } };
}

describe('durable claim event delivery', () => {
  it('retains exact prepared bytes before POST and accepts only a complete matching receipt', async () => {
    const f = await fixture();
    expect(await f.execute()).toEqual(f.receipt());
    expect(f.calls).toEqual(['GET', 'POST', 'GET']);
    expect(f.bodies).toEqual([{ events: [f.event] }]);
    expect(f.checks.length).toBeGreaterThanOrEqual(2);
    const packet = JSON.parse(await readFile(join(f.dir, 'event.json'), 'utf8'));
    expect(packet).toMatchObject({ operation_id: uuid(4), manifest_sha256: 'a'.repeat(64), event_json: f.eventJson, actor_user_id: f.actor });
  });

  it('resolves a lost POST acknowledgment through exact receipt readback', async () => {
    const f = await fixture(); f.loseAck();
    expect(await f.execute()).toEqual(f.receipt());
    expect(f.calls).toEqual(['GET', 'POST', 'GET']);
  });

  it('resumes after accepted POST and failed checkpoint without posting again', async () => {
    const f = await fixture();
    await expect(f.execute('apply', {}, 'claim_event_post_outcome')).rejects.toThrow('synthetic checkpoint failure');
    expect(f.calls).toEqual(['GET', 'POST']);
    const before = await readFile(join(f.dir, 'event.json'));
    expect(await f.execute('resume')).toEqual(f.receipt());
    expect(f.calls).toEqual(['GET', 'POST', 'GET']);
    expect(await readFile(join(f.dir, 'event.json'))).toEqual(before);
  });

  it('verifies an already recorded exact event without sending it again', async () => {
    const f = await fixture(); f.accept();
    expect(await f.execute()).toEqual(f.receipt());
    expect(f.calls).toEqual(['GET']);
  });

  it('refuses an existing selected receipt without server chronology before POST', async () => {
    const f = await fixture(); f.accept(); f.omitReceiptMetadata();
    await expect(f.execute()).rejects.toThrow('claim_event_receipt_unanswered');
    expect(f.calls).toEqual(['GET']);
  });

  it('does not acknowledge incomplete chronology after POST and resumes from complete readback without reposting', async () => {
    const f = await fixture(); f.omitReceiptMetadata();
    await expect(f.execute()).rejects.toThrow('claim_event_receipt_unanswered');
    const journalRecords = async () => Promise.all((await readdir(join(f.dir, 'journal'))).sort()
      .map(async name => JSON.parse(await readFile(join(f.dir, 'journal', name), 'utf8'))));
    expect((await journalRecords()).some(record => record.phase === 'claim_event_verified')).toBe(false);
    expect(f.calls).toEqual(['GET', 'POST', 'GET']);
    f.omitReceiptMetadata(false);
    expect(await f.execute('resume')).toEqual(f.receipt());
    expect(f.calls).toEqual(['GET', 'POST', 'GET', 'GET']);
    expect(f.bodies).toEqual([{ events: [f.event] }]);
    const verified = (await journalRecords()).find(record => record.phase === 'claim_event_verified');
    expect(verified.data.receipt).toEqual(f.receipt());
    expect(verified.data.receipt.received_at).toBe('2026-09-22T22:00:01.654321Z');
  });

  it('does not interpret an unanswered receipt read as permission to POST', async () => {
    const f = await fixture(); f.failReads();
    await expect(f.execute()).rejects.toThrow('claim_event_receipt_unanswered');
    expect(f.calls).toEqual(['GET']);
  });

  it('refuses a stored event attributed to a different actor despite a successful POST response', async () => {
    const f = await fixture(); f.badAck();
    await expect(f.execute()).rejects.toThrow('claim_event_receipt_conflict');
    expect(f.calls).toEqual(['GET', 'POST', 'GET']);
  });

  it('does not accept insertion counters when the selected receipt is still absent', async () => {
    const f = await fixture(); f.omitStorage();
    await expect(f.execute()).rejects.toThrow('claim_event_delivery_unverified');
    expect(f.calls).toEqual(['GET', 'POST', 'GET']);
  });

  it.each(['event', 'actor', 'destination'])('refuses changed %s on resume before HTTP', async change => {
    const f = await fixture(); await f.execute(); const count = f.calls.length;
    const changes: Partial<ClaimEventDeliveryOptions> = change === 'event'
      ? { eventJson: JSON.stringify({ ...f.event, id: uuid(9) }) }
      : change === 'actor' ? { actor: uuid(9) } : { scope: { ...f.scope, base_url: 'https://changed.example.test' } };
    await expect(f.execute('resume', changes)).rejects.toThrow(/claim_event_.*conflict/);
    expect(f.calls).toHaveLength(count);
  });

  it('refuses changed source or authenticated context before delivery', async () => {
    const f = await fixture();
    await expect(f.execute('apply', { verifyContext: async () => { throw new Error('source_or_actor_changed'); } }))
      .rejects.toThrow('source_or_actor_changed');
    expect(f.calls).toEqual([]);
  });

  it('rechecks the current context between receipt absence and POST', async () => {
    const f = await fixture(); let checks = 0;
    await expect(f.execute('apply', { verifyContext: async () => {
      if (++checks === 3) throw new Error('source_or_actor_changed');
    } })).rejects.toThrow('source_or_actor_changed');
    expect(f.calls).toEqual(['GET']);
  });

  it('refuses a changed durable packet immediately before POST', async () => {
    const f = await fixture(); let checks = 0;
    await expect(f.execute('apply', { verifyContext: async () => {
      if (++checks === 3) {
        const path = join(f.dir, 'event.json');
        const packet = JSON.parse(await readFile(path, 'utf8')); packet.actor_user_id = uuid(9);
        await writeFile(path, JSON.stringify(packet));
      }
    } })).rejects.toThrow('claim_event_packet_conflict');
    expect(f.calls).toEqual(['GET']);
  });

  it('does not deliver when immutable packet publication fails', async () => {
    const f = await fixture(); await writeFile(join(f.dir, 'event.json'), 'pre-existing evidence');
    await expect(f.execute()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(f.dir, 'event.json'), 'utf8')).toBe('pre-existing evidence');
    expect(f.calls).toEqual([]);
  });

  it('refuses released target ownership before packet or HTTP effects', async () => {
    const f = await fixture();
    const released = await withRecoveryTarget(f.dir, f.target, async ownership => ownership);
    await expect(f.execute('apply', { ownership: released })).rejects.toThrow('native_target_not_owned');
    await expect(readFile(join(f.dir, 'event.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls).toEqual([]);
  });

  it('requires recovery qualification rather than ordinary native ownership', async () => {
    const f = await fixture();
    await expect(f.execute('apply', {}, undefined, true)).rejects.toThrow('native_target_recovery_not_owned');
    await expect(readFile(join(f.dir, 'event.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls).toEqual([]);
  });
});

function quotaClock(onSleep = () => {}) {
  let now = 0; const waits: number[] = [];
  return { now: () => now, wallTime: () => Date.now(), waits,
    sleep: async (ms: number) => { now += ms; waits.push(ms); onSleep(); } };
}

describe('claim writes across quota waits', () => {
  it('rechecks the source after waiting for the write reservation and refuses before POST', async () => {
    let changed = false;
    const time = quotaClock(() => { changed = true; });
    const budget = new RecoveryRequestBudget(time);
    for (let i = 0; i < 239; i++) await budget.acquire();
    const f = await fixture(budget);
    await expect(f.execute('apply', { verifyContext: async () => {
      if (changed) throw new Error('source_changed_during_quota_wait');
    } })).rejects.toThrow('source_changed_during_quota_wait');
    expect(time.waits).toEqual([60_000]);
    expect(f.calls).toEqual(['GET']);
    expect(JSON.parse(await readFile(join(f.dir, 'event.json'), 'utf8')).event_json).toBe(f.eventJson);
  });

  it('does not insert a quota wait after the final successful pre-write proof', async () => {
    const time = quotaClock(); const budget = new RecoveryRequestBudget(time);
    for (let i = 0; i < 239; i++) await budget.acquire();
    const f = await fixture(budget); let checks = 0, provedAt = -1, proofWaits = -1;
    f.observePost(() => { expect(time.now()).toBe(provedAt); expect(time.waits.length).toBe(proofWaits); });
    expect(await f.execute('apply', { verifyContext: async () => {
      if (++checks === 3) { provedAt = time.now(); proofWaits = time.waits.length; }
    } })).toEqual(f.receipt());
    expect(provedAt).toBe(60_000);
    expect(f.calls).toEqual(['GET', 'POST', 'GET']);
  });

  it('preserves an actual POST 429 and acknowledges only its exact subsequent receipt without reposting', async () => {
    const time = quotaClock(); const f = await fixture(new RecoveryRequestBudget(time)); f.rateLimitPost();
    expect(await f.execute()).toEqual(f.receipt());
    expect(f.calls).toEqual(['GET', 'POST', 'GET']);
    expect(time.waits).toEqual([13_000]);
    const checkpoints = await Promise.all((await readdir(join(f.dir, 'journal'))).map(async name => JSON.parse(await readFile(join(f.dir, 'journal', name), 'utf8'))));
    expect(checkpoints.find(c => c.phase === 'claim_event_post_outcome').data).toMatchObject({ kind: 'unavailable', http_status: 429, retry_after_ms: 13_000 });
  });

  it('keeps an exact rate-rejected packet and safely stops on complete receipt absence', async () => {
    const time = quotaClock(); const f = await fixture(new RecoveryRequestBudget(time)); f.rateLimitPost(); f.omitStorage();
    await expect(f.execute()).rejects.toThrow('claim_event_delivery_unverified');
    expect(f.calls).toEqual(['GET', 'POST', 'GET']);
    const packet = await readFile(join(f.dir, 'event.json'));
    f.accept();
    expect(await f.execute('resume')).toEqual(f.receipt());
    expect(f.calls).toEqual(['GET', 'POST', 'GET', 'GET']);
    expect(await readFile(join(f.dir, 'event.json'))).toEqual(packet);
  });
});
