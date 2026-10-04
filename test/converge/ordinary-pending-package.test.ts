import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { guardedInputSha256 } from '../../src/report/run-header.js';
import { DEFAULT_GUARDED_INPUT_CAPACITY, MAX_GUARDED_INPUT_CAPACITY, retainGuardedInput } from '../../src/converge/guarded-input-retention.js';
import { ordinaryPendingGuardedInput,
  prepareOrdinaryPendingGuardedInput,
  validateOrdinaryPendingPackage } from '../../src/converge/ordinary-pending-package.js';
const pr9691Input = JSON.parse(gunzipSync(Buffer.from(readFileSync(
  new URL('../fixtures/pr9691-a2-guarded-input.json.gz.b64', import.meta.url), 'utf8').replace(/\s/g, ''), 'base64'
)).toString('utf8')) as Record<string, unknown>;
import pr9691Migration from '../fixtures/pr9691-a2-migration.json' with { type: 'json' };

const input = { head: 'a'.repeat(40), kind: 'patch', repo: 'allocator-one/allocator-one', pr: 9691, diff: 'd'.repeat(64), config: 'e'.repeat(64), roster: [{ model: 'openai/test', role: 'general', provider: 'openai', lane: 'async' }], prompts: [], asyncRoles: [{ name: 'general' }], spec: { source: 'flag', sha256: 'f'.repeat(64) } };
const expected = { target: 'allocator-one-9691', headSha: input.head, inputSha256: guardedInputSha256(input), baseSha: 'b'.repeat(40), attempt: 2, round: 2, pid: 32832, retainedAsyncSha256: ['c'.repeat(64)] };
const packet = () => ({ target: expected.target, headSha: input.head, baseSha: expected.baseSha, attempt: 2, round: 2, pid: 32832, retainedAsyncSha256: [...expected.retainedAsyncSha256], retainedAsync: [{ sha256: 'c'.repeat(64), model: 'openai/test', role: 'general', provider: 'openai', lane: 'async' as const }], guardedInput: structuredClone(input) });

function directPrPackage() {
  const guardedInput = { ...structuredClone(input), kind: 'pr', spec: undefined };
  const value = JSON.parse(JSON.stringify({ ...packet(), guardedInput })) as ReturnType<typeof packet>;
  return { value, identity: { ...expected, inputSha256: guardedInputSha256(guardedInput) } };
}

describe('ordinary pending migration package', () => {
  it('preserves explicit archive capacity through preparation without changing the guarded-input digest', () => {
    const original = prepareOrdinaryPendingGuardedInput(structuredClone(input));
    expect(original.retained).not.toHaveProperty('capacity');
    const capacity = { ...MAX_GUARDED_INPUT_CAPACITY };
    const prepared = prepareOrdinaryPendingGuardedInput(structuredClone(input), capacity);
    expect(prepared.retained.capacity).toEqual(capacity);
    expect(prepared.inputSha256()).toBe(original.inputSha256());
    capacity.decodedBytes -= 1;
    expect(prepared.retained.capacity).toEqual(MAX_GUARDED_INPUT_CAPACITY);
    const restored = prepareOrdinaryPendingGuardedInput(structuredClone(prepared.retained));
    expect(restored.retained).toEqual(prepared.retained);
    expect(restored.inputSha256()).toBe(expected.inputSha256);
    expect(Object.isFrozen(restored.retained.capacity)).toBe(true);
    const compact = { ...packet(), guardedInput: restored.retained,
      guardedInputRepresentation: { version: 1 as const, encoding: 'json-string-table-v1' as const } };
    expect(ordinaryPendingGuardedInput(validateOrdinaryPendingPackage(compact, expected, restored))).toEqual(input);
  });

  it('accepts a matching compact capacity and rejects overrides of the persisted policy', () => {
    const archive = retainGuardedInput(input, MAX_GUARDED_INPUT_CAPACITY);
    expect(prepareOrdinaryPendingGuardedInput(archive, MAX_GUARDED_INPUT_CAPACITY).retained).toEqual(archive);
    expect(() => prepareOrdinaryPendingGuardedInput(archive, DEFAULT_GUARDED_INPUT_CAPACITY))
      .toThrow('guarded_input_capacity_mismatch');
    const legacy = retainGuardedInput(input);
    expect(prepareOrdinaryPendingGuardedInput(legacy, DEFAULT_GUARDED_INPUT_CAPACITY).retained).toEqual(legacy);
    expect(() => prepareOrdinaryPendingGuardedInput(legacy, MAX_GUARDED_INPUT_CAPACITY))
      .toThrow('guarded_input_capacity_mismatch');
  });

  it('rejects invalid persisted capacity before preparing or authenticating a package', () => {
    const archive = retainGuardedInput(input, MAX_GUARDED_INPUT_CAPACITY);
    const invalid = { ...archive, capacity: { ...MAX_GUARDED_INPUT_CAPACITY, decodedBytes: MAX_GUARDED_INPUT_CAPACITY.decodedBytes + 1 } };
    expect(() => prepareOrdinaryPendingGuardedInput(invalid)).toThrow();
    expect(() => prepareOrdinaryPendingGuardedInput(archive, invalid.capacity)).toThrow();
    const compact = { ...packet(), guardedInput: invalid,
      guardedInputRepresentation: { version: 1 as const, encoding: 'json-string-table-v1' as const } };
    expect(() => validateOrdinaryPendingPackage(compact, expected)).toThrow('ordinary_pending_package_mismatch');
  });

  it('restores an expanded pending input using its retained capacity without a new override', () => {
    const prompt = { userPrompt: 'p'.repeat(1024 * 1024) };
    const expanded = { ...structuredClone(input), prompts: Array.from({ length: 129 }, () => prompt) };
    expect(() => prepareOrdinaryPendingGuardedInput(expanded)).toThrow('guarded_input_archive_expands_too_large');
    const prepared = prepareOrdinaryPendingGuardedInput(expanded, MAX_GUARDED_INPUT_CAPACITY);
    const restored = prepareOrdinaryPendingGuardedInput(structuredClone(prepared.retained));
    expect(restored.retained.capacity).toEqual(MAX_GUARDED_INPUT_CAPACITY);
    expect(restored.inputSha256()).toBe(prepared.inputSha256());
    expect(restored.input.prompts).toHaveLength(129);
    expect((restored.input.prompts as typeof expanded.prompts)[128]!.userPrompt).toBe(prompt.userPrompt);
  }, 30_000);

  it('requires an explicit representation contract for compact guarded input while accepting legacy raw input', () => {
    expect(validateOrdinaryPendingPackage(packet(), expected)).toBeDefined();

    const compact = { ...packet(),
      guardedInputRepresentation: { version: 1 as const, encoding: 'json-string-table-v1' as const },
      guardedInput: retainGuardedInput(input) };
    expect(ordinaryPendingGuardedInput(validateOrdinaryPendingPackage(compact, expected))).toEqual(input);

    const prepared = prepareOrdinaryPendingGuardedInput(compact.guardedInput);
    const preparedPacket = { ...compact, guardedInput: prepared.retained };
    expect(validateOrdinaryPendingPackage(preparedPacket, expected, prepared)).toBeDefined();

    expect(() => { prepared.retained.strings[0] = 'tampered'; }).toThrow(TypeError);
    expect(() => { (prepared.retained.root as any[])[0] = 'v'; }).toThrow(TypeError);
    expect(validateOrdinaryPendingPackage(preparedPacket, expected, prepared)).toBeDefined();

    const rawPrepared = prepareOrdinaryPendingGuardedInput(structuredClone(input));
    rawPrepared.inputSha256();
    expect(() => {
      ((rawPrepared.input.roster as Array<Record<string, unknown>>)[0]!).model = 'tampered/model';
    }).toThrow(TypeError);
    const rawPreparedPacket = { ...compact, guardedInput: rawPrepared.retained };
    expect(validateOrdinaryPendingPackage(rawPreparedPacket, expected, rawPrepared)).toBeDefined();

    const forged = { ...prepared };
    expect(() => validateOrdinaryPendingPackage(preparedPacket, expected, forged))
      .toThrow('ordinary_pending_package_mismatch');

    const replacedArchive = { ...preparedPacket,
      guardedInput: structuredClone(prepared.retained) };
    expect(() => validateOrdinaryPendingPackage(replacedArchive, expected, prepared))
      .toThrow('ordinary_pending_package_mismatch');

    const preparedWithoutMarker = { ...preparedPacket } as any;
    delete preparedWithoutMarker.guardedInputRepresentation;
    expect(() => validateOrdinaryPendingPackage(preparedWithoutMarker, expected, prepared))
      .toThrow('ordinary_pending_package_mismatch');

    const preparedWithWrongMarker = { ...preparedPacket,
      guardedInputRepresentation: { version: 2, encoding: 'json-string-table-v1' } } as any;
    expect(() => validateOrdinaryPendingPackage(preparedWithWrongMarker, expected, prepared))
      .toThrow('ordinary_pending_package_mismatch');

    const unmarkedCompact = structuredClone(compact) as any;
    delete unmarkedCompact.guardedInputRepresentation;
    expect(() => validateOrdinaryPendingPackage(unmarkedCompact, expected))
      .toThrow('ordinary_pending_package_mismatch');

    const falselyMarkedRaw = { ...packet(), guardedInputRepresentation: compact.guardedInputRepresentation };
    expect(() => validateOrdinaryPendingPackage(falselyMarkedRaw, expected))
      .toThrow('ordinary_pending_package_mismatch');

    const unsupportedRepresentation = structuredClone(compact) as any;
    unsupportedRepresentation.guardedInputRepresentation.version = 2;
    expect(() => validateOrdinaryPendingPackage(unsupportedRepresentation, expected))
      .toThrow('ordinary_pending_package_mismatch');

    const malformedRepresentation = { ...compact, guardedInputRepresentation: null } as any;
    expect(() => ordinaryPendingGuardedInput(malformedRepresentation))
      .toThrow('ordinary_pending_package_mismatch');
  });

  it('authenticates a direct PR production input with omitted spec without changing its source kind', () => {
    const { value, identity } = directPrPackage();

    expect(value.guardedInput).not.toHaveProperty('spec');
    const validated = validateOrdinaryPendingPackage(value, identity);
    expect(validated).toEqual(value);
    expect(validated.guardedInput.kind).toBe('pr');
    expect(validated.guardedInput).not.toHaveProperty('spec');
    expect(guardedInputSha256(validated.guardedInput)).toBe(identity.inputSha256);
  });

  it.each([
    ['patch source kind', (value: ReturnType<typeof packet>) => { value.guardedInput.kind = 'patch'; }],
    ['repo', (value: ReturnType<typeof packet>) => { value.guardedInput.repo = 'other/repo'; }],
    ['PR number', (value: ReturnType<typeof packet>) => { value.guardedInput.pr += 1; }],
    ['head', (value: ReturnType<typeof packet>) => { value.guardedInput.head = 'f'.repeat(40); }],
    ['base', (value: ReturnType<typeof packet>) => { value.baseSha = 'f'.repeat(40); }],
    ['diff digest', (value: ReturnType<typeof packet>) => { value.guardedInput.diff = 'f'.repeat(64); }],
    ['config digest', (value: ReturnType<typeof packet>) => { value.guardedInput.config = 'f'.repeat(64); }],
    ['invented spec', (value: ReturnType<typeof packet>) => { value.guardedInput.spec = input.spec; }],
    ['async model', (value: ReturnType<typeof packet>) => { value.retainedAsync[0].model = 'other/model'; }],
    ['async hash', (value: ReturnType<typeof packet>) => { value.retainedAsync[0].sha256 = 'f'.repeat(64); }],
  ] as const)('rejects direct PR %s drift', (_label, mutate) => {
    const { value, identity } = directPrPackage();
    mutate(value);
    expect(() => validateOrdinaryPendingPackage(value, identity)).toThrow('ordinary_pending_package_mismatch');
  });

  it.each([
    ['unsupported source kind', { kind: 'staged' }],
    ['malformed repo', { repo: 'not-a-repository' }],
    ['malformed PR number', { pr: '9691' }],
    ['malformed diff digest', { diff: 'invalid' }],
    ['malformed roster', { roster: ['not-a-roster-entry'] }],
    ['malformed async roles', { asyncRoles: [null] }],
    ['null spec', { spec: null }],
    ['unexpected input key', { unexpected: true }],
  ] as const)('rejects direct PR %s even with a matching digest', (_label, change) => {
    const { value, identity } = directPrPackage();
    Object.assign(value.guardedInput, change);
    identity.inputSha256 = guardedInputSha256(value.guardedInput);
    expect(() => validateOrdinaryPendingPackage(value, identity)).toThrow('ordinary_pending_package_mismatch');
  });

  it('authenticates a historical guarded input whose undefined spec was omitted by JSON', () => {
    const guardedInput = structuredClone(input) as Record<string, unknown>;
    guardedInput.spec = undefined;
    const jsonPacket = JSON.parse(JSON.stringify({ ...packet(), guardedInput })) as ReturnType<typeof packet>;
    const omittedExpected = { ...expected, inputSha256: guardedInputSha256(guardedInput) };

    expect(jsonPacket.guardedInput).not.toHaveProperty('spec');
    expect(validateOrdinaryPendingPackage(jsonPacket, omittedExpected).guardedInput).not.toHaveProperty('spec');

    const invented = structuredClone(jsonPacket);
    invented.guardedInput.spec = {};
    expect(() => validateOrdinaryPendingPackage(invented, omittedExpected))
      .toThrow('ordinary_pending_package_mismatch');

    const ambiguous = packet();
    ambiguous.guardedInput.spec = undefined as unknown as typeof input.spec;
    expect(() => validateOrdinaryPendingPackage(ambiguous, omittedExpected))
      .toThrow('ordinary_pending_package_mismatch');

    const newlyOmitted = packet();
    delete (newlyOmitted.guardedInput as Partial<typeof input>).spec;
    expect(() => validateOrdinaryPendingPackage(newlyOmitted, expected))
      .toThrow('ordinary_pending_package_mismatch');
  });

  it('recomputes the authenticated PR9691 A2 production input', () => {
    expect(guardedInputSha256(pr9691Input)).toBe('b1cedd3d7d55720b8efea4474f9cf82e5c8ee7accf6a1f9e0121e7d5ad7ae2db');
    expect(validateOrdinaryPendingPackage({ target: pr9691Migration.target, headSha: pr9691Input.head as string,
      baseSha: pr9691Migration.base_sha, attempt: pr9691Migration.attempt, round: pr9691Migration.round, pid: 32832,
      retainedAsyncSha256: pr9691Migration.retained_async_sha256, retainedAsync: pr9691Migration.retained_async, guardedInput: pr9691Input }, { target: pr9691Migration.target, headSha: pr9691Input.head as string,
      inputSha256: pr9691Migration.input_sha256, baseSha: pr9691Migration.base_sha,
      attempt: pr9691Migration.attempt, round: pr9691Migration.round, pid: 32832,
      retainedAsyncSha256: pr9691Migration.retained_async_sha256 })).toBeDefined();
  });
  it('authenticates only the production guarded-input projection', () => {
    expect(validateOrdinaryPendingPackage(packet(), expected)).toMatchObject({ target: expected.target, headSha: expected.headSha });
    for (const key of ['kind', 'repo', 'pr', 'diff', 'config', 'roster', 'prompts', 'asyncRoles', 'spec'] as const) {
      const changed = packet(); (changed.guardedInput as any)[key] = key === 'pr' ? 1 : ['drift'];
      expect(() => validateOrdinaryPendingPackage(changed, expected)).toThrow('ordinary_pending_package_mismatch');
    }
    const changed = packet(); changed.guardedInput.head = 'f'.repeat(40);
    expect(() => validateOrdinaryPendingPackage(changed, expected)).toThrow('ordinary_pending_package_mismatch');
    const malformed = packet(); malformed.guardedInput.roster = ['not-a-roster-entry'];
    expect(() => validateOrdinaryPendingPackage(malformed, expected)).toThrow('ordinary_pending_package_mismatch');
    const missingInput = packet() as any; missingInput.guardedInput = null;
    expect(() => validateOrdinaryPendingPackage(missingInput, expected)).toThrow('ordinary_pending_package_mismatch');
  });
  it.each(['target', 'headSha', 'baseSha', 'attempt', 'round', 'pid', 'retainedAsyncSha256'] as const)('refuses mismatched %s launch metadata', key => {
    const changed = packet() as any;
    changed[key] = key === 'attempt' || key === 'round' || key === 'pid' ? 1 : key === 'retainedAsyncSha256' ? ['d'.repeat(64)] : 'f'.repeat(40);
    expect(() => validateOrdinaryPendingPackage(changed, expected)).toThrow('ordinary_pending_package_mismatch');
  });
  it.each([
    ['missing descriptor', (value: any) => { value.retainedAsync = []; }],
    ['duplicate descriptor', (value: any) => { value.retainedAsync.push({ ...value.retainedAsync[0] }); }],
    ['wrong model', (value: any) => { value.retainedAsync[0].model = 'other'; }],
    ['wrong role', (value: any) => { value.retainedAsync[0].role = ''; }],
    ['wrong provider', (value: any) => { value.retainedAsync[0].provider = ''; }],
    ['wrong lane', (value: any) => { value.retainedAsync[0].lane = 'blocking'; }],
    ['wrong descriptor hash', (value: any) => { value.retainedAsync[0].sha256 = 'd'.repeat(64); }],
  ])('refuses %s retained async descriptor', (_label, mutate) => {
    const changed = packet(); mutate(changed);
    expect(() => validateOrdinaryPendingPackage(changed, expected)).toThrow('ordinary_pending_package_mismatch');
  });
});
