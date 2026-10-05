import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { CAPTURED_INPUT_HARD_LIMITS, captureReviewerInputs } from '../../src/dispatch/captured-inputs.js';
import { CheckpointJournal, checkpointPath, decodeCheckpointProof, freezeCheckpointPlan, MAX_CHECKPOINT_PROOF_BYTES } from '../../src/dispatch/checkpoint.js';
import { sha256Hex, stableStringify } from '../../src/report/run-header.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const target = 'allocator-one/rcl#162', namespace = 'capture-capacity';
function capture(patchSize = 9 * 1024 * 1024, capacity = CAPTURED_INPUT_HARD_LIMITS) {
  const patchBytes = 'p'.repeat(patchSize), configBytes = stableStringify({ quorumFraction: 2 / 3 });
  const toolsBytes = stableStringify({ parser: { name: 'findings-json', version: 1 }, aggregation: { name: 'consensus', version: 2 } });
  const assignments = [0, 1].map(index => ({ model: `fake/m${index}`, provider: 'fake',
    role: { name: 'general', systemPrompt: 'role', focus: [], description: 'Test', isSpecialized: false } }));
  const prompts = assignments.map(() => ({ systemPrompt: 'system', userPrompt: 'user' }));
  const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40),
    patchSha256: sha256Hex(patchBytes), configSha256: sha256Hex(configBytes), specSha256: sha256Hex('spec'),
    contextSha256: sha256Hex('[]'), toolsSha256: sha256Hex(toolsBytes), parser: { name: 'findings-json', version: 1 },
    roster: assignments.map((a, index) => ({ seat: `s${index}`, model: a.model, role: a.role.name, route: a.provider })),
    chunks: [{ index: 0, total: 1, digest: sha256Hex('chunk') }],
    prompts: prompts.map((p, index) => ({ seat: `s${index}`, chunk: 0, systemSha256: sha256Hex(p.systemPrompt), userSha256: sha256Hex(p.userPrompt) })),
  });
  return captureReviewerInputs({ plan, capacity, policy: { version: 1, fraction: 2 / 3 },
    patchBytes, configBytes, specBytes: 'spec', contextBytes: '[]', toolsBytes, assignments, prompts, chunkBytes: ['chunk'] });
}
async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'rcl-capture-capacity-')));
  roots.push(path); return path;
}

describe('checkpoint explicit capture capacity', () => {
  it('persists, replays, reopens and exports a capture above the default file limit', async () => {
    const commonDir = await directory(), captured = capture();
    await withNativeTarget(commonDir, target, async ownership => {
      const input = { commonDir, namespace, plan: captured.plan, ownership };
      const journal = await CheckpointJournal.create(input);
      await journal.bind('captured-inputs', captured.bytes, ownership);
      await journal.bind('captured-inputs', captured.bytes, ownership);
      const recovered = await CheckpointJournal.openWrite(input);
      expect((await recovered.readBindings())['captured-inputs']).toBe(captured.bytes);
      await recovered.finalize(ownership);
      const proof = await recovered.exportProof();
      expect(decodeCheckpointProof(proof.bytes, captured.plan).bindings['captured-inputs']).toBe(captured.bytes);
    });
  }, 30_000);

  it('exports and independently decodes an explicit capture above the default proof limit', async () => {
    const commonDir = await directory(), captured = capture(26 * 1024 * 1024);
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace, plan: captured.plan, ownership });
      await journal.bind('captured-inputs', captured.bytes, ownership);
      await journal.finalize(ownership);
      const proof = await journal.exportProof();
      expect(Buffer.byteLength(proof.bytes)).toBeGreaterThan(MAX_CHECKPOINT_PROOF_BYTES);
      await rm(checkpointPath(commonDir, target, namespace), { recursive: true });
      expect(decodeCheckpointProof(proof.bytes, captured.plan).bindings['captured-inputs']).toBe(captured.bytes);
    });
  }, 30_000);

  it('exports expanded reviewer outcomes with a small explicit capture', async () => {
    const commonDir = await directory(), captured = capture(1024);
    expect(Buffer.byteLength(captured.bytes)).toBeLessThan(8 * 1024 * 1024);
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace, plan: captured.plan, ownership });
      await journal.bind('captured-inputs', captured.bytes, ownership);
      const reviewBytes = stableStringify({ model: 'fake/m0', role: 'general', provider: 'fake',
        status: 'error', findings: [], durationMs: 1, error: 'e'.repeat(7 * 1024 * 1024) });
      for (let index = 0; index < 4; index++) {
        const attempt = { id: `failed-${index}`, kind: 'paid' as const };
        await journal.recordIntent('s0:0', attempt, ownership);
        await journal.recordResult('s0:0', attempt, { kind: 'failure', chunk: 0, reviewBytes, possiblyBilled: true }, ownership);
      }
      await journal.finalize(ownership);
      const proof = await journal.exportProof();
      expect(Buffer.byteLength(proof.bytes)).toBeGreaterThan(MAX_CHECKPOINT_PROOF_BYTES);
      await rm(checkpointPath(commonDir, target, namespace), { recursive: true });
      expect(decodeCheckpointProof(proof.bytes, captured.plan).state.outcomes.map(outcome => outcome.result.reviewBytes))
        .toEqual(Array(4).fill(reviewBytes));
    });
  }, 30_000);

  it.each(['decode', 'export'] as const)('%s enforces the declared capture allowance on serialized proof bytes', async operation => {
    const commonDir = await directory();
    const capacity = { ...CAPTURED_INPUT_HARD_LIMITS, bytes: 1024 * 1024 };
    const captured = capture(1024, capacity);
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace, plan: captured.plan, ownership });
      await journal.bind('captured-inputs', captured.bytes, ownership);
      // These individually bounded bindings fit the raw journal budget, but
      // JSON escaping takes the portable proof past its declared allowance.
      for (const name of ['source', 'operation', 'launch'] as const) {
        await journal.bind(name, '"'.repeat(5 * 1024 * 1024), ownership);
      }
      await journal.finalize(ownership);
      const { records } = await journal.read(), bindings = await journal.readBindings();
      const bytes = stableStringify({ version: 1, plan: captured.plan, records, outcomes: [], bindings });
      expect(Buffer.byteLength(bytes)).toBeGreaterThan(MAX_CHECKPOINT_PROOF_BYTES + capacity.bytes);
      if (operation === 'decode') {
        expect(() => decodeCheckpointProof(bytes, captured.plan)).toThrow('checkpoint_proof_too_large');
      } else {
        await expect(journal.exportProof()).rejects.toThrow('checkpoint_proof_too_large');
      }
    });
  }, 30_000);

  it.each([1024, 9 * 1024 * 1024])('recovers the capture allowance for a %i-byte patch before reading an expanded journal', async patchSize => {
    const commonDir = await directory(), captured = capture(patchSize);
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace, plan: captured.plan, ownership });
      await journal.bind('captured-inputs', captured.bytes, ownership);
      const path = checkpointPath(commonDir, target, namespace);
      let previousDigest = (await journal.read()).records[0]!.digest;
      // Preserve valid intent chains while charging their original whitespace
      // bytes, as the ordinary read-budget regression tests also require.
      for (let index = 0; index < 10; index++) {
        const unsigned = { type: 'intent', sequence: index + 2, previousDigest, cell: 's0:0',
          paidAttempt: { id: `pending-${index}`, kind: 'paid' } };
        const record = { ...unsigned, digest: sha256Hex(stableStringify(unsigned)) };
        const bytes = stableStringify(record);
        await writeFile(join(path, 'events', `${String(index + 2).padStart(8, '0')}.json`),
          bytes + ' '.repeat(7 * 1024 * 1024 - Buffer.byteLength(bytes)), { mode: 0o600 });
        previousDigest = record.digest;
      }
      const reopened = await CheckpointJournal.openRead(path, captured.plan);
      expect((await reopened.read()).uncertain).toHaveLength(10);
      await journal.finalize(ownership);
      expect((await journal.exportProof()).state.uncertain).toHaveLength(10);
    });
  }, 30_000);

  it('does not expand other bindings or accept a large capture without its explicit capacity', async () => {
    const commonDir = await directory(), captured = capture();
    const wire = JSON.parse(captured.bytes); delete wire.capacity;
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace, plan: captured.plan, ownership });
      await expect(journal.bind('source', captured.bytes, ownership)).rejects.toThrow('checkpoint_file_too_large');
      await expect(journal.bind('captured-inputs', stableStringify(wire), ownership)).rejects.toThrow('capture_invalid_bytes');
      expect((await journal.read()).records).toEqual([]);
    });
  }, 30_000);

  it.each([1024, 9 * 1024 * 1024])('rejects a capture for a %i-byte patch with an unrelated plan before publication', async patchSize => {
    const commonDir = await directory(), captured = capture(patchSize);
    const plan = freezeCheckpointPlan({ ...captured.plan, headSha: 'c'.repeat(40) });
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace, plan, ownership });
      await expect(journal.bind('captured-inputs', captured.bytes, ownership)).rejects.toThrow('capture_plan_mismatch');
      expect((await journal.read()).records).toEqual([]);
    });
  }, 30_000);

  it('round-trips a valid small capture without explicit capacity', async () => {
    const commonDir = await directory(), captured = capture(1024);
    const wire = JSON.parse(captured.bytes); delete wire.capacity;
    const bytes = stableStringify(wire);
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace, plan: captured.plan, ownership });
      await journal.bind('captured-inputs', bytes, ownership);
      await journal.finalize(ownership);
      expect(decodeCheckpointProof((await journal.exportProof()).bytes).bindings['captured-inputs']).toBe(bytes);
    });
  });

  it('rejects malformed small captures and invalid declared capacity before publication', async () => {
    const commonDir = await directory(), captured = capture(1024);
    const wire = JSON.parse(captured.bytes); wire.capacity.bytes = 0;
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace, plan: captured.plan, ownership });
      await expect(journal.bind('captured-inputs', 'opaque capture', ownership)).rejects.toThrow('capture_invalid_json');
      await expect(journal.bind('captured-inputs', stableStringify(wire), ownership)).rejects.toThrow('capture_invalid_capacity');
      expect((await journal.read()).records).toEqual([]);
    });
  });

  it('rejects tampered persisted capacity through the journal binding digest', async () => {
    const commonDir = await directory(), captured = capture();
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace, plan: captured.plan, ownership });
      await journal.bind('captured-inputs', captured.bytes, ownership);
      const path = join(checkpointPath(commonDir, target, namespace), 'binding-captured-inputs.data');
      const wire = JSON.parse(await readFile(path, 'utf8')); wire.capacity.bytes -= 1;
      await writeFile(path, stableStringify(wire));
      await expect(journal.read()).rejects.toThrow('checkpoint_binding_tampered');
    });
  }, 30_000);
});
