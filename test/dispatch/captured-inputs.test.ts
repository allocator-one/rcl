import { describe, expect, it, vi } from 'vitest';
import * as runHeader from '../../src/report/run-header.js';
import { sha256Hex, stableStringify } from '../../src/report/run-header.js';
import { freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { CAPTURED_INPUT_HARD_LIMITS, CAPTURED_INPUT_LIMITS, captureReviewerInputs, decodeCapturedInputs } from '../../src/dispatch/captured-inputs.js';

function fixture() {
  const configBytes = stableStringify({ quorumFraction: 2 / 3, timeout: 1000 });
  const contextBytes = stableStringify([{ label: 'rules.md', content: 'Rules €', sha256: sha256Hex('Rules €') }]);
  const toolsBytes = stableStringify({ parser: { name: 'findings-json', version: 1 }, aggregation: { name: 'consensus', version: 2 } });
  const assignments = [0, 1, 2].map(index => ({ model: `fake/m${index}`, provider: 'fake',
    role: { name: 'general', systemPrompt: 'role', focus: [], description: 'Test', isSpecialized: false } }));
  const prompts = assignments.map(() => ({ systemPrompt: 'System €', userPrompt: 'Review patch' }));
  const plan = freezeCheckpointPlan({ target: 'allocator-one/rcl#105', headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40),
    patchSha256: sha256Hex('patch'), configSha256: sha256Hex(configBytes), specSha256: sha256Hex('spec'),
    contextSha256: sha256Hex(contextBytes), toolsSha256: sha256Hex(toolsBytes), parser: { name: 'findings-json', version: 1 },
    roster: assignments.map((a, index) => ({ seat: `s${index}`, model: a.model, role: a.role.name, route: a.provider })),
    chunks: [{ index: 0, total: 1, digest: sha256Hex('chunk') }],
    prompts: prompts.map((p, index) => ({ seat: `s${index}`, chunk: 0, systemSha256: sha256Hex(p.systemPrompt), userSha256: sha256Hex(p.userPrompt) })),
  });
  return { plan, policy: { version: 1 as const, fraction: 2 / 3 }, assignments, prompts,
    patchBytes: 'patch', configBytes, specBytes: 'spec', contextBytes, toolsBytes, chunkBytes: ['chunk'] };
}

describe('captured reviewer inputs', () => {
  it('preserves the default wire format and binds an explicit capacity into the capture digest', () => {
    const input = fixture(), original = captureReviewerInputs(input);
    expect(JSON.parse(original.bytes)).not.toHaveProperty('capacity');
    const captured = captureReviewerInputs({ ...input, capacity: CAPTURED_INPUT_HARD_LIMITS });
    expect(JSON.parse(captured.bytes).capacity).toEqual(CAPTURED_INPUT_HARD_LIMITS);
    expect(decodeCapturedInputs(captured.bytes, input.plan).capacity).toEqual(CAPTURED_INPUT_HARD_LIMITS);
    expect(captured.digest).not.toBe(original.digest);
    expect(Object.isFrozen(captured.capacity)).toBe(true);
  });

  it('requires explicit capacity for a large patch and recovers it from the persisted document', () => {
    const input = fixture();
    input.patchBytes = 'p'.repeat(CAPTURED_INPUT_LIMITS.bytes + 1);
    input.plan = freezeCheckpointPlan({ ...input.plan, patchSha256: sha256Hex(input.patchBytes) });
    expect(() => captureReviewerInputs(input)).toThrow('capture_invalid_bytes');
    const captured = captureReviewerInputs({ ...input, capacity: CAPTURED_INPUT_HARD_LIMITS });
    const decoded = decodeCapturedInputs(captured.bytes, input.plan);
    expect(decoded.patchBytes).toBe(input.patchBytes);
    expect(decoded.digest).toBe(captured.digest);
    const stripped = JSON.parse(captured.bytes);
    delete stripped.capacity;
    expect(() => decodeCapturedInputs(stableStringify(stripped), input.plan)).toThrow('capture_invalid_bytes');
  }, 15_000);

  it('captures a complete 400 chunk by 17 reviewer matrix only with explicit capacity', () => {
    const base = fixture();
    const roster = Array.from({ length: 17 }, (_, index) => ({ ...base.plan.roster[0]!, seat: `s${index}`, model: `fake/m${index}` }));
    const chunkBytes = Array.from({ length: 400 }, (_, index) => `chunk ${index}`);
    const prompts = chunkBytes.flatMap(() => roster.map(() => base.prompts[0]!));
    const plan = freezeCheckpointPlan({ ...base.plan, roster,
      chunks: chunkBytes.map((bytes, index) => ({ index, total: chunkBytes.length, digest: sha256Hex(bytes) })),
      prompts: chunkBytes.flatMap((_, chunk) => roster.map(seat => ({ seat: seat.seat, chunk,
        systemSha256: sha256Hex(base.prompts[0]!.systemPrompt), userSha256: sha256Hex(base.prompts[0]!.userPrompt) }))),
    });
    const input = { ...base, plan, chunkBytes, prompts,
      assignments: plan.cells.map(cell => ({ ...base.assignments[0]!, model: cell.model })) };
    expect(() => captureReviewerInputs(input)).toThrow('capture_invalid_plan');
    const captured = captureReviewerInputs({ ...input, capacity: CAPTURED_INPUT_HARD_LIMITS });
    const recovered = decodeCapturedInputs(captured.bytes, plan);
    expect(recovered.plan.cells).toHaveLength(6800);
    expect(recovered.chunkBytes).toEqual(chunkBytes);
    expect(recovered.assignments).toEqual(input.assignments);
    const lowered = JSON.parse(captured.bytes);
    lowered.capacity.cells = 6799;
    expect(() => decodeCapturedInputs(stableStringify(lowered), plan)).toThrow('capture_invalid_plan');
    lowered.capacity = { ...CAPTURED_INPUT_HARD_LIMITS, chunks: 399 };
    expect(() => decodeCapturedInputs(stableStringify(lowered), plan)).toThrow('capture_invalid_plan');
  }, 15_000);

  it.each([
    ['bytes', 64 * 1024 * 1024 + 1], ['cells', 8193], ['chunks', 513], ['seats', 201],
    ['bytes', 0], ['cells', 1.5], ['chunks', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid explicit %s capacity before capture and on recovery', (key, value) => {
    const input = fixture(), capacity = { ...CAPTURED_INPUT_LIMITS, [key]: value };
    expect(() => captureReviewerInputs({ ...input, capacity })).toThrow('capture_invalid_capacity');
    const wire = { ...JSON.parse(captureReviewerInputs(input).bytes), capacity };
    expect(() => decodeCapturedInputs(stableStringify(wire), input.plan)).toThrow('capture_invalid_capacity');
  });

  it('rejects partial or unknown capacity fields instead of filling in defaults', () => {
    const input = fixture();
    for (const capacity of [{ bytes: CAPTURED_INPUT_LIMITS.bytes }, { ...CAPTURED_INPUT_LIMITS, unknown: 1 }, null]) {
      expect(() => captureReviewerInputs({ ...input, capacity } as any)).toThrow('capture_invalid_capacity');
      const wire = { ...JSON.parse(captureReviewerInputs(input).bytes), capacity };
      expect(() => decodeCapturedInputs(stableStringify(wire), input.plan)).toThrow('capture_invalid_capacity');
    }
  });

  it('enforces the encoded document byte limit even when all individual blobs fit', () => {
    const input = fixture(), captured = captureReviewerInputs(input);
    const capacity = { ...CAPTURED_INPUT_LIMITS, bytes: Buffer.byteLength(captured.bytes) };
    expect(() => captureReviewerInputs({ ...input, capacity })).toThrow('capture_invalid_bytes');
  });

  it('retains content integrity and unreferenced blob checks with expanded capacity', () => {
    const input = fixture(), captured = captureReviewerInputs({ ...input, capacity: CAPTURED_INPUT_HARD_LIMITS });
    const changed = JSON.parse(captured.bytes);
    changed.blobs[sha256Hex(input.patchBytes)] = 'changed';
    expect(() => decodeCapturedInputs(stableStringify(changed), input.plan)).toThrow('capture_missing_or_changed_blob');
    const extra = JSON.parse(captured.bytes);
    extra.blobs[sha256Hex('extra')] = 'extra';
    expect(() => decodeCapturedInputs(stableStringify(extra), input.plan)).toThrow('capture_unreferenced_blob');
  });

  it('validates a large shared blob once per decode without carrying trust into another decode', () => {
    const base = fixture(), systemPrompt = 'S'.repeat(4 * 1024 * 1024);
    const roster = Array.from({ length: 100 }, (_, index) => ({ ...base.plan.roster[0]!, seat: `s${index}`, model: `fake/m${index}` }));
    const chunkBytes = Array.from({ length: 5 }, (_, index) => `chunk ${index}`);
    const cells = chunkBytes.flatMap((_, chunk) => roster.map(seat => ({ seat, chunk })));
    const prompts = cells.map(() => ({ systemPrompt, userPrompt: 'Review patch' }));
    const plan = freezeCheckpointPlan({ ...base.plan, roster,
      chunks: chunkBytes.map((bytes, index) => ({ index, total: chunkBytes.length, digest: sha256Hex(bytes) })),
      prompts: cells.map(({ seat, chunk }) => ({ seat: seat.seat, chunk,
        systemSha256: sha256Hex(systemPrompt), userSha256: sha256Hex('Review patch') })),
    });
    const captured = captureReviewerInputs({ ...base, plan, chunkBytes, prompts,
      assignments: cells.map(({ seat }) => ({ ...base.assignments[0]!, model: seat.model })) });
    expect(Buffer.byteLength(captured.bytes)).toBeLessThan(8 * 1024 * 1024);
    const hash = vi.spyOn(runHeader, 'sha256Hex');
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        hash.mockClear();
        const decoded = decodeCapturedInputs(captured.bytes, plan);
        expect(decoded.prompts).toEqual(prompts);
        expect(decoded.bytes).toBe(captured.bytes);
        expect(hash.mock.calls.filter(([bytes]) => bytes === systemPrompt)).toHaveLength(1);
      }
    } finally { hash.mockRestore(); }
  }, 15_000);

  it.each(['changed', 'missing'])('revalidates a %s shared blob after a successful decode', mutation => {
    const input = fixture(), captured = captureReviewerInputs(input);
    expect(decodeCapturedInputs(captured.bytes, input.plan).prompts).toEqual(input.prompts);
    const tampered = JSON.parse(captured.bytes), shared = sha256Hex(input.prompts[0]!.systemPrompt);
    if (mutation === 'changed') tampered.blobs[shared] = 'different shared prompt';
    else delete tampered.blobs[shared];
    expect(() => decodeCapturedInputs(stableStringify(tampered), input.plan)).toThrow('capture_missing_or_changed_blob');
  });

  it('rejects invalid UTF-8 in a shared blob even when its hash and plan agree', () => {
    const input = fixture(), captured = captureReviewerInputs(input), wire = JSON.parse(captured.bytes);
    const invalid = String.fromCharCode(0xd800), digest = sha256Hex(invalid);
    delete wire.blobs[sha256Hex(input.prompts[0]!.systemPrompt)];
    wire.blobs[digest] = invalid;
    const plan = freezeCheckpointPlan({ ...input.plan,
      prompts: input.plan.prompts.map(prompt => ({ ...prompt, systemSha256: digest })) });
    wire.plan = plan;
    expect(() => decodeCapturedInputs(stableStringify(wire), plan)).toThrow('capture_invalid_bytes');
  });

  it('captures exact async routes, roles, prompts and retry allocation in the same blob store', () => {
    const base = fixture();
    const async = { timeoutMs: 1000, maxAttemptsPerCall: 2, maxPhysicalCalls: 2,
      calls: [{ assignmentId: 'async:0', chunk: 0, assignment: base.assignments[0]!,
        prompt: { systemPrompt: 'Async private system', userPrompt: 'Async private user' } }] };
    const captured = captureReviewerInputs({ ...base, async } as any);
    const decoded = decodeCapturedInputs(captured.bytes, base.plan) as any;
    expect(decoded.async?.calls[0].prompt).toEqual(async.calls[0].prompt);
    expect(decoded.async?.calls[0].ref).toMatchObject({ id: 'async:0:0', assignment: 'async:0',
      model: base.assignments[0]!.model, systemPromptSha256: sha256Hex(async.calls[0].prompt.systemPrompt) });
    expect(decoded.async?.maxPhysicalCalls).toBe(2);
    expect(captured.digest).not.toBe(captureReviewerInputs(base).digest);
  });
  it('refuses duplicate async cells and an async chunk absent from the captured matrix', () => {
    const base = fixture();
    const call = { assignmentId: 'async:0', chunk: 0, assignment: base.assignments[0]!, prompt: base.prompts[0]! };
    const async = { timeoutMs: 1000, maxAttemptsPerCall: 2, maxPhysicalCalls: 2, calls: [call, call] };
    expect(() => captureReviewerInputs({ ...base, async } as any)).toThrow();
    expect(() => captureReviewerInputs({ ...base, async: { ...async, calls: [{ ...call, chunk: 1 }] } } as any)).toThrow();
  });
  it('round-trips exact prompts and source bytes with content-addressed sharing', () => {
    const input = fixture();
    const captured = captureReviewerInputs(input);
    const decoded = decodeCapturedInputs(captured.bytes, input.plan);
    expect(decoded.prompts).toEqual(input.prompts);
    expect(decoded.assignments).toEqual(input.assignments);
    expect(decoded.patchBytes).toBe('patch');
    expect(decoded.contextBytes).toBe(input.contextBytes);
    expect(decoded.digest).toBe(sha256Hex(captured.bytes));
    expect(decoded.policy.minimumSuccessful).toBe(2);
    expect(captured.bytes.split('System €')).toHaveLength(2);
  });

  it.each(['patchBytes', 'configBytes', 'specBytes', 'contextBytes', 'toolsBytes'] as const)(
    'refuses changed %s rather than claiming matching captured inputs', key => {
      const input = fixture(); input[key] += ' changed';
      expect(() => captureReviewerInputs(input)).toThrow();
    });

  it('refuses changed prompts, provider route, chunk bytes and incomplete matrices', () => {
    const input = fixture(); input.prompts[0]!.userPrompt = 'replacement';
    expect(() => captureReviewerInputs(input)).toThrow();
    const routed = fixture(); routed.assignments[0]!.provider = 'other';
    expect(() => captureReviewerInputs(routed)).toThrow();
    const chunk = fixture(); chunk.chunkBytes[0] = 'replacement';
    expect(() => captureReviewerInputs(chunk)).toThrow();
    const missing = fixture(); missing.assignments.pop();
    expect(() => captureReviewerInputs(missing)).toThrow();
  });

  it('refuses a different expected head while upstream tip metadata is irrelevant', () => {
    const input = fixture(); const captured = captureReviewerInputs(input);
    const changed = freezeCheckpointPlan({ ...input.plan, headSha: 'c'.repeat(40) });
    expect(() => decodeCapturedInputs(captured.bytes, changed)).toThrow();
    expect(decodeCapturedInputs(captured.bytes, input.plan).plan.digest).toBe(input.plan.digest);
  });

  it('refuses duplicate structural keys, missing legacy payloads and unknown fields', () => {
    const input = fixture(); const captured = captureReviewerInputs(input);
    expect(() => decodeCapturedInputs(captured.bytes.replace('"version":1', '"version":1,"version":1'), input.plan)).toThrow();
    expect(() => decodeCapturedInputs('{}', input.plan)).toThrow();
    const unknown = JSON.parse(captured.bytes); unknown.authority = 'attested';
    expect(() => decodeCapturedInputs(stableStringify(unknown), input.plan)).toThrow();
  });

  it('refuses credential-bearing config even if a caller supplied its digest', () => {
    const input = fixture(); input.configBytes = stableStringify({ githubToken: 'do-not-persist', quorumFraction: 2 / 3 });
    input.plan = freezeCheckpointPlan({ ...input.plan, configSha256: sha256Hex(input.configBytes) });
    expect(() => captureReviewerInputs(input)).toThrow();
  });

  it('refuses an independently changed quorum policy and incompatible parser', () => {
    const input = fixture(); input.policy.fraction = 1;
    expect(() => captureReviewerInputs(input)).toThrow();
    const parser = fixture(); parser.toolsBytes = stableStringify({ parser: { name: 'other', version: 1 }, aggregation: { name: 'consensus', version: 2 } });
    parser.plan = freezeCheckpointPlan({ ...parser.plan, toolsSha256: sha256Hex(parser.toolsBytes) });
    expect(() => captureReviewerInputs(parser)).toThrow();
  });

  it('validates each content digest and rejects extra unreferenced blobs', () => {
    const input = fixture(); const captured = captureReviewerInputs(input);
    const tampered = JSON.parse(captured.bytes); tampered.blobs[sha256Hex('patch')] = 'other';
    expect(() => decodeCapturedInputs(stableStringify(tampered), input.plan)).toThrow();
    const extra = JSON.parse(captured.bytes); extra.blobs[sha256Hex('extra')] = 'extra';
    expect(() => decodeCapturedInputs(stableStringify(extra), input.plan)).toThrow();
  });

  it('returns isolated immutable input objects and enforces the capture byte bound', () => {
    const input = fixture(); const captured = captureReviewerInputs(input);
    input.prompts[0]!.userPrompt = 'later mutation';
    const decoded = decodeCapturedInputs(captured.bytes, input.plan);
    expect(decoded.prompts[0]!.userPrompt).toBe('Review patch');
    expect(Object.isFrozen(decoded.assignments[0]!.role)).toBe(true);
    expect(() => decodeCapturedInputs(' '.repeat(8 * 1024 * 1024 + 1), input.plan)).toThrow();
  });
  it('binds an async call to its declared chunk index when frozen chunks are stored out of order', () => {
    const base = fixture();
    const chunks = [{ index: 1, total: 2, digest: sha256Hex('other chunk') }, { index: 0, total: 2, digest: sha256Hex('chunk') }];
    const plan = freezeCheckpointPlan({ ...base.plan, chunks,
      prompts: chunks.flatMap(chunk => base.plan.roster.map(seat => ({ seat: seat.seat, chunk: chunk.index,
        systemSha256: sha256Hex('System €'), userSha256: sha256Hex('Review patch') }))),
    });
    const assignments = plan.cells.map(cell => base.assignments.find(assignment => assignment.model === cell.model)!);
    const prompts = plan.cells.map(() => ({ systemPrompt: 'System €', userPrompt: 'Review patch' }));
    const async = { timeoutMs: 1000, maxAttemptsPerCall: 2, maxPhysicalCalls: 2,
      calls: [{ assignmentId: 'async:0', chunk: 0, assignment: assignments[0]!,
        prompt: { systemPrompt: 'Async private system', userPrompt: 'Async private user' } }] };
    const captured = captureReviewerInputs({ ...base, plan, assignments, prompts, chunkBytes: ['other chunk', 'chunk'], async });
    expect(captured.async!.calls[0]!.ref.chunkSha256).toBe(sha256Hex('chunk'));
    const positional = JSON.parse(captured.bytes);
    positional.async.calls[0].chunkSha256 = sha256Hex('other chunk');
    expect(() => decodeCapturedInputs(stableStringify(positional), plan)).toThrow('capture_invalid_async_matrix');
  });

});
