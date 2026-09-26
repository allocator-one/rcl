import { describe, expect, it } from 'vitest';
import { sha256Hex, stableStringify } from '../../src/report/run-header.js';
import { freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { captureReviewerInputs, decodeCapturedInputs } from '../../src/dispatch/captured-inputs.js';

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
});
