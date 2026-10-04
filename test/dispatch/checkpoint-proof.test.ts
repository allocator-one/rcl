import { minimalCheckpointCapture } from './checkpoint-capture-fixture.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import {
  CheckpointJournal, checkpointPath, freezeCheckpointPlan, exportCheckpointProof,
  decodeCheckpointProof, isCheckpointProof, MAX_CHECKPOINT_PROOF_BYTES,
} from '../../src/dispatch/checkpoint.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const target = 'allocator-one/rcl#105', namespace = 'portable-proof';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: any): string {
  return value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function plan() {
  return minimalCheckpointCapture({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: 'c'.repeat(64), configSha256: 'd'.repeat(64), specSha256: 'e'.repeat(64), contextSha256: '3'.repeat(64), toolsSha256: '4'.repeat(64), parser: { name: 'findings-json', version: 1 },
    roster: [{ seat: 'general', model: 'openai/gpt-6-sol', role: 'general', route: 'openai' }, { seat: 'security', model: 'openai/gpt-6-sol', role: 'security', route: 'openai' }],
    chunks: [0, 1].map(index => ({ index, total: 2, digest: hash(`chunk-${index}`) })),
    prompts: ['general', 'security'].flatMap(seat => [0, 1].map(chunk => ({ seat, chunk, systemSha256: hash(`${seat}-system`), userSha256: hash(`${seat}-${chunk}`) }))),
  }).plan;
}
const successfulBytes = JSON.stringify({ model: 'openai/gpt-6-sol', provider: 'openai', role: 'general', status: 'success', durationMs: 5, usage: { inputTokens: 11, outputTokens: 7 }, findings: [{ id: 'raw-1', file: 'src/a.ts', startLine: 1, endLine: 1, severity: 'important', category: 'correctness', title: '\uFEFFOriginal title', description: 'Original description' }] }, null, 2) + '\n';
const failedBytes = JSON.stringify({ model: 'openai/gpt-6-sol', provider: 'openai', role: 'general', status: 'timeout', durationMs: 10, usage: { inputTokens: 3 }, findings: [], error: 'Stalled response' }, null, 4);

async function fixture(sealed = true) {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-proof-'))); roots.push(commonDir);
  const frozen = plan(); let journal!: CheckpointJournal;
  await withNativeTarget(commonDir, target, async owner => {
    journal = await CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership: owner });
    await journal.bind('captured-inputs', minimalCheckpointCapture(frozen).bytes, owner);
    await journal.bind('source', '\uFEFF exact source\n', owner);
    await journal.bind('operation', 'operation bytes', owner);
    await journal.recordIntent('general:0', { id: 'failed-paid', kind: 'paid' }, owner);
    await journal.recordResult('general:0', { id: 'failed-paid', kind: 'paid' }, { kind: 'failure', chunk: 0, reviewBytes: failedBytes, possiblyBilled: true }, owner);
    await journal.recordIntent('general:0', { id: 'successful-paid', kind: 'paid' }, owner);
    await journal.recordResult('general:0', { id: 'successful-paid', kind: 'paid' }, { kind: 'success', chunk: 0, reviewBytes: successfulBytes }, owner);
    await journal.recordIntent('security:0', { id: 'lost-paid', kind: 'unknown' }, owner);
    await journal.recordUncertain('security:0', { id: 'lost-paid', kind: 'unknown' }, 'Response lost', owner);
    await journal.recordIntent('general:1', { id: 'chunk-one', kind: 'paid' }, owner);
    await journal.recordResult('general:1', { id: 'chunk-one', kind: 'paid' }, { kind: 'success', chunk: 1, reviewBytes: successfulBytes }, owner);
    if (sealed) await journal.finalize(owner);
  });
  return { commonDir, frozen, journal, path: checkpointPath(commonDir, target, namespace) };
}

/** Rehash mutations so validation cannot succeed merely by checking hashes. */
function rechain(wire: any) {
  let previous = wire.plan.digest;
  for (let index = 0; index < wire.records.length; index++) {
    const row = wire.records[index]; delete row.digest;
    row.sequence = index + 1; row.previousDigest = previous;
    if (row.type === 'finalization') row.finalizedDigest = hash(canonical(wire.records.slice(0, index)));
    row.digest = hash(canonical(row)); previous = row.digest;
  }
}

describe('portable finalized checkpoint proof', () => {
  it.each(['failure', 'success', 'other pending attempt'] as const)('refuses uncertainty appended after %s even with a valid digest chain', async kind => {
    const { journal } = await fixture();
    const original = await exportCheckpointProof(journal), wire = JSON.parse(original.bytes);
    rechain(wire);
    expect(canonical(wire)).toBe(original.bytes);
    expect(decodeCheckpointProof(canonical(wire))).toEqual(original);
    const attempt = { id: kind === 'failure' ? 'failed-paid' : kind === 'success' ? 'successful-paid' : 'pending-paid', kind: 'paid' };
    if (kind === 'other pending attempt') wire.records.splice(3, 0, { type: 'intent', cell: 'general:0', paidAttempt: attempt });
    wire.records.splice(-1, 0, { type: 'uncertain', cell: 'general:0', paidAttempt: attempt, reason: 'Response lost' });
    rechain(wire);
    expect(() => decodeCheckpointProof(canonical(wire))).toThrow(kind === 'other pending attempt' ? 'checkpoint_success_immutable' : 'checkpoint_terminal_result_exists');
  });

  it('retains uncertainty before a terminal result when decoding a valid chronological proof', async () => {
    const { journal } = await fixture(), wire = JSON.parse((await exportCheckpointProof(journal)).bytes);
    wire.records.splice(4, 0, { type: 'uncertain', cell: 'general:0', paidAttempt: { id: 'failed-paid', kind: 'paid' }, reason: 'Response lost' });
    rechain(wire);
    const decoded = decodeCheckpointProof(canonical(wire));
    expect(decoded.state.outcomes.map(row => row.result.reviewBytes)).toEqual([failedBytes, successfulBytes, successfulBytes]);
    expect(decoded.state.uncertain).toEqual([{ cell: 'security:0', paidAttempt: { id: 'lost-paid', kind: 'unknown' } }]);
    expect(decoded.state.records[4]).toMatchObject({ type: 'uncertain', paidAttempt: { id: 'failed-paid', kind: 'paid' } });
  });

  it('independently decodes complete frozen evidence after the source journal is gone', async () => {
    const { journal, frozen, path } = await fixture();
    const state = await journal.read(), bindings = await journal.readBindings();
    const proof = await exportCheckpointProof(journal);
    expect(proof.bytes).toBe(canonical(JSON.parse(proof.bytes)));
    const rehashed = JSON.parse(proof.bytes);
    rechain(rehashed);
    expect(canonical(rehashed)).toBe(proof.bytes);
    expect(decodeCheckpointProof(canonical(rehashed), frozen)).toEqual(proof);
    expect(proof.digest).toBe(hash(proof.bytes));
    expect(proof.state).toEqual(state); expect(proof.bindings).toEqual(bindings);
    await rm(path, { recursive: true });
    const decoded = decodeCheckpointProof(proof.bytes, frozen);
    expect(decoded).toEqual(proof); expect(isCheckpointProof(decoded)).toBe(true);
    expect(isCheckpointProof({ ...decoded })).toBe(false);
    expect(decoded.state.outcomes.map(row => row.result.reviewBytes)).toEqual([failedBytes, successfulBytes, successfulBytes]);
    expect(decoded.state.uncertain).toEqual([{ cell: 'security:0', paidAttempt: { id: 'lost-paid', kind: 'unknown' } }]);
    expect(decoded.state.successes).toHaveLength(2);
    expect(decoded.plan.cells).toHaveLength(4); // Never-attempted cell is not invented as a success.
    expect(Object.isFrozen(decoded)).toBe(true); expect(Object.isFrozen(decoded.state.records[0])).toBe(true);
    expect(Object.isFrozen(decoded.state.outcomes[0]?.result)).toBe(true); expect(Object.isFrozen(decoded.plan.roster)).toBe(true);
  });

  it('refuses unsealed export and decoding with no finalization record', async () => {
    const { journal, commonDir } = await fixture(false);
    await expect(exportCheckpointProof(journal)).rejects.toThrow('checkpoint_proof_unsealed');
    await withNativeTarget(commonDir, target, owner => journal.finalize(owner));
    const wire = JSON.parse((await exportCheckpointProof(journal)).bytes); wire.records.pop();
    expect(() => decodeCheckpointProof(canonical(wire))).toThrow('checkpoint_proof_unsealed');
  });

  it.each(['missing file', 'partial file'] as const)('refuses export from a %s rather than omitting an outcome', async mutation => {
    const { journal, path } = await fixture();
    const row = (await journal.read()).records.find(row => row.type === 'result')!;
    const file = join(path, 'results', row.result!.resultFile);
    if (mutation === 'missing file') await unlink(file); else await writeFile(file, '{');
    await expect(exportCheckpointProof(journal)).rejects.toThrow();
  });

  it('does not strip an injected leading BOM before validating stored outcome bytes', async () => {
    const { journal, path } = await fixture();
    const result = (await journal.read()).records.find(row => row.type === 'result')!;
    const file = join(path, 'results', result.result!.resultFile);
    await writeFile(file, '\uFEFF' + await readFile(file, 'utf8'));
    await expect(exportCheckpointProof(journal)).rejects.toThrow('checkpoint_result_tampered');
    await expect(journal.read()).rejects.toThrow('checkpoint_result_tampered');
  });

  it('supports a sealed legacy journal without treating absent bindings as evidence', async () => {
    const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-proof-'))); roots.push(commonDir);
    let journal!: CheckpointJournal;
    await withNativeTarget(commonDir, target, async owner => { journal = await CheckpointJournal.create({ commonDir, namespace, plan: plan(), ownership: owner }); await journal.finalize(owner); });
    const proof = decodeCheckpointProof((await exportCheckpointProof(journal)).bytes);
    expect(proof.bindings).toEqual({}); expect(proof.state.outcomes).toEqual([]); expect(proof.state.successes).toEqual([]);
  });

  it.each(['binding bytes', 'missing binding', 'extra binding', 'outcome bytes', 'missing outcome', 'duplicate outcome', 'extra outcome', 'wrong order', 'plan digest', 'missing prompt', 'unknown envelope key', 'unknown event key', 'unknown event type', 'duplicate intent', 'result before intent', 'wrong attempt kind', 'duplicate terminal result', 'unknown uncertain intent', 'late binding', 'unreferenced binding', 'extra result metadata', 'bad result identity', 'malformed finding'])(
    'refuses %s even with recomputed event and finalization hashes', async mutation => {
      const { journal } = await fixture(); const wire = JSON.parse((await exportCheckpointProof(journal)).bytes);
      const result = wire.records.find((row: any) => row.type === 'result');
      if (mutation === 'binding bytes') wire.bindings.source += '!';
      else if (mutation === 'missing binding') delete wire.bindings.source;
      else if (mutation === 'extra binding') wire.bindings.extra = 'not supported';
      else if (mutation === 'outcome bytes') wire.outcomes[0].reviewBytes += ' ';
      else if (mutation === 'missing outcome') wire.outcomes.shift();
      else if (mutation === 'duplicate outcome') wire.outcomes.push(wire.outcomes[0]);
      else if (mutation === 'extra outcome') wire.outcomes.push({ resultFile: 'unreferenced.json', reviewBytes: failedBytes });
      else if (mutation === 'wrong order') wire.outcomes.reverse();
      else if (mutation === 'plan digest') wire.plan.headSha = '9'.repeat(40);
      else if (mutation === 'missing prompt') wire.plan.prompts.pop();
      else if (mutation === 'unknown envelope key') wire.successfulCount = 4;
      else if (mutation === 'unknown event key') wire.records[3].success = true;
      else if (mutation === 'unknown event type') wire.records[3].type = 'approved';
      else if (mutation === 'duplicate intent') wire.records.splice(4, 0, structuredClone(wire.records[3]));
      else if (mutation === 'result before intent') [wire.records[3], wire.records[4]] = [wire.records[4], wire.records[3]];
      else if (mutation === 'wrong attempt kind') result.paidAttempt.kind = 'unknown';
      else if (mutation === 'duplicate terminal result') wire.records.splice(5, 0, structuredClone(result));
      else if (mutation === 'unknown uncertain intent') wire.records.find((row: any) => row.type === 'uncertain').paidAttempt.id = 'invented';
      else if (mutation === 'late binding') wire.records.splice(5, 0, wire.records.shift());
      else if (mutation === 'unreferenced binding') wire.records.splice(1, 1);
      else if (mutation === 'extra result metadata') result.result.approved = true;
      else {
        const review = JSON.parse(wire.outcomes[0].reviewBytes);
        if (mutation === 'bad result identity') review.role = 'security';
        else review.findings = [{ id: 'incomplete' }];
        wire.outcomes[0].reviewBytes = JSON.stringify(review); result.result.reviewSha256 = hash(wire.outcomes[0].reviewBytes);
      }
      rechain(wire);
      expect(() => decodeCheckpointProof(canonical(wire))).toThrow();
    },
  );

  it('rejects a different expected plan and noncanonical or partial wire bytes', async () => {
    const { journal } = await fixture(); const proof = await exportCheckpointProof(journal);
    const changed = freezeCheckpointPlan({ ...plan(), toolsSha256: '9'.repeat(64) });
    expect(() => decodeCheckpointProof(proof.bytes, changed)).toThrow('checkpoint_plan_mismatch');
    expect(() => decodeCheckpointProof(proof.bytes + '\n')).toThrow('checkpoint_proof_noncanonical');
    expect(() => decodeCheckpointProof(proof.bytes.slice(0, -1))).toThrow('checkpoint_invalid_proof');
    expect(() => decodeCheckpointProof('x'.repeat(MAX_CHECKPOINT_PROOF_BYTES + 1))).toThrow('checkpoint_proof_too_large');
  });

  it.each(['plan', 'record'] as const)('rejects a deeply nested malformed portable %s with a checkpoint error', location => {
    const nested = '{"extra":'.repeat(10_000) + 'null' + '}'.repeat(10_000);
    const bytes = location === 'plan'
      ? `{"version":1,"plan":${nested},"records":[],"outcomes":[],"bindings":{}}`
      : `{"version":1,"plan":${canonical(plan())},"records":[${nested}],"outcomes":[],"bindings":{}}`;
    expect(() => decodeCheckpointProof(bytes)).toThrow(location === 'plan' ? 'checkpoint_invalid_plan' : 'checkpoint_invalid_record');
  });

  it('keeps a valid wide portable proof canonical', async () => {
    const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-proof-wide-'))); roots.push(commonDir);
    const base = plan(), chunks = Array.from({ length: 250 }, (_, index) => ({ index, total: 250, digest: hash(`wide-chunk-${index}`) }));
    const wide = freezeCheckpointPlan({ ...base, chunks,
      prompts: base.roster.flatMap(({ seat }) => chunks.map(({ index }) => ({ seat, chunk: index, systemSha256: hash(`${seat}-system`), userSha256: hash(`${seat}-${index}`) }))) });
    await withNativeTarget(commonDir, target, async owner => {
      const journal = await CheckpointJournal.create({ commonDir, namespace: 'wide-proof', plan: wide, ownership: owner });
      await journal.finalize(owner);
      const proof = await exportCheckpointProof(journal);
      expect(decodeCheckpointProof(proof.bytes, wide)).toEqual(proof);
      expect(proof.bytes).toBe(canonical(JSON.parse(proof.bytes)));
    });
  });

  it('bounds serialized proof size without truncating individually valid binding files', async () => {
    const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-proof-'))); roots.push(commonDir);
    let journal!: CheckpointJournal;
    await withNativeTarget(commonDir, target, async owner => {
      journal = await CheckpointJournal.create({ commonDir, namespace, plan: plan(), ownership: owner });
      for (const name of ['source', 'operation', 'launch'] as const) await journal.bind(name, '"'.repeat(5 * 1024 * 1024), owner);
      await journal.finalize(owner);
    });
    await expect(exportCheckpointProof(journal)).rejects.toThrow('checkpoint_proof_too_large');
    expect((await readFile(join(checkpointPath(commonDir, target, namespace), 'binding-source.data'))).length).toBe(5 * 1024 * 1024);
  });
});
