import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { guardedInputSha256 } from '../../src/report/run-header.js';
import { validateOrdinaryPendingPackage } from '../../src/converge/ordinary-pending-package.js';
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
